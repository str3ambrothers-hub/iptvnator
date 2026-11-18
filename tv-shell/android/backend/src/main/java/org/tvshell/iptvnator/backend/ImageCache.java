package org.tvshell.iptvnator.backend;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.Comparator;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;

/**
 * A disk cache of poster images, fetched once and shrunk to card size.
 *
 * A grid of tens of thousands of items asks for a lot of full-size artwork
 * (often 500 KB+ each) from slow provider servers, and a 1 GB stick decodes
 * every one of them at full resolution. Here each image is downloaded once,
 * scaled down by a {@link Transcoder} (the Android side), stored under a hash
 * of its URL and then served from disk, so scrolling back is instant and
 * later launches need no network for images already seen.
 *
 * Safety: only http(s); only JPEG, PNG, WebP or GIF are ever served (the type
 * is sniffed from the bytes, never taken from the provider, so no SVG/HTML);
 * a download cap; at most {@link #MAX_PARALLEL} fetches at once; failures are
 * remembered briefly so a broken URL is not retried on every scroll; the
 * folder is trimmed to {@code maxBytes}. Loopback, link-local and private
 * literal hosts are refused unless they are a registered provider host, so
 * another app on the device cannot use this endpoint to reach local services.
 */
public final class ImageCache {

    /** Scales an image down to at most {@code maxWidth} pixels wide, or throws when it is not an image. */
    public interface Transcoder {
        byte[] downscale(byte[] original, int maxWidth) throws IOException;
    }

    /** A cached or freshly fetched image. */
    public static final class Image {
        public final byte[] bytes;
        public final String contentType;

        Image(byte[] bytes, String contentType) {
            this.bytes = bytes;
            this.contentType = contentType;
        }
    }

    /** The image could not be provided; {@code status} is the HTTP status to answer. */
    public static final class Unavailable extends Exception {
        private static final long serialVersionUID = 1L;
        public final int status;

        Unavailable(int status, String message) {
            super(message);
            this.status = status;
        }
    }

    public static final int MAX_PARALLEL = 6;
    public static final int MIN_WIDTH = 64;
    public static final int MAX_WIDTH = 720;
    public static final int DEFAULT_WIDTH = 360;
    static final long MAX_DOWNLOAD_BYTES = 8L * 1024 * 1024;
    private static final int FETCH_TIMEOUT_MS = 15_000;
    private static final long WAIT_FOR_SLOT_MS = 25_000;
    /** A poster the provider says is gone (404, not an image) is not asked again for this long. */
    private static final long FAILURE_MEMORY_MS = 10 * 60 * 1000L;
    /** A slow or unreachable image server is retried soon: the next try often works. */
    private static final long TRANSIENT_FAILURE_MEMORY_MS = 15 * 1000L;
    private static final int MAX_REMEMBERED_FAILURES = 2_000;
    private static final int LOCK_STRIPES = 256;

    private final File dir;
    private final long maxBytes;
    private final HttpFetcher fetcher;
    private final Transcoder transcoder;
    private final Semaphore slots = new Semaphore(MAX_PARALLEL, true);
    private final Object[] locks = new Object[LOCK_STRIPES];
    private final Map<String, Long> failures = new ConcurrentHashMap<String, Long>();
    private long writtenSinceTrim;

    public ImageCache(File dir, long maxBytes, HttpFetcher fetcher, Transcoder transcoder) {
        this.dir = dir;
        this.maxBytes = maxBytes;
        this.fetcher = fetcher;
        this.transcoder = transcoder;
        for (int i = 0; i < LOCK_STRIPES; i++) locks[i] = new Object();
    }

    /** The image for {@code url} at about {@code width} px, from disk when already seen. */
    public Image get(String url, int width, java.util.Set<String> trustedHosts) throws Unavailable {
        URI uri = parse(url);
        String host = uri.getHost().toLowerCase(Locale.ROOT);
        if (!trustedHosts.contains(host) && isLocalOrPrivate(host)) throw new Unavailable(403, "Local addresses are not served");
        int w = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width <= 0 ? DEFAULT_WIDTH : width));
        String key = sha256Hex(url + "|" + w);

        File file = new File(dir, key);
        Image cached = read(file);
        if (cached != null) return cached;

        Long failedUntil = failures.get(key);
        if (failedUntil != null) {
            if (System.currentTimeMillis() < failedUntil) throw new Unavailable(404, "Image unavailable");
            failures.remove(key);
        }
        synchronized (locks[(key.hashCode() & 0x7fffffff) % LOCK_STRIPES]) {
            // Another request for the same image may have finished while this one waited.
            cached = read(file);
            if (cached != null) return cached;
            try {
                if (!slots.tryAcquire(WAIT_FOR_SLOT_MS, TimeUnit.MILLISECONDS)) throw new Unavailable(503, "Busy");
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new Unavailable(503, "Interrupted");
            }
            try {
                Image fresh = fetchAndStore(url, w, file);
                failures.remove(key);
                return fresh;
            } catch (Unavailable e) {
                if (e.status != 503) remember(key, e.status == 502 ? TRANSIENT_FAILURE_MEMORY_MS : FAILURE_MEMORY_MS);
                throw e;
            } finally {
                slots.release();
            }
        }
    }

    private Image fetchAndStore(String url, int width, File file) throws Unavailable {
        byte[] original;
        try {
            HttpFetcher.BinaryResult result = fetcher.getBytes(url, HttpFetcher.headers("Accept", "image/*"), FETCH_TIMEOUT_MS, MAX_DOWNLOAD_BYTES);
            original = result.body;
        } catch (ProviderException e) {
            throw new Unavailable(e.hasHttpStatus() ? 404 : 502, "Image could not be fetched");
        }
        if (sniff(original) == null) throw new Unavailable(415, "Not an image");
        byte[] stored = original;
        if (transcoder != null) {
            try {
                stored = transcoder.downscale(original, width);
            } catch (IOException | RuntimeException e) {
                throw new Unavailable(415, "Image could not be decoded");
            }
        }
        String type = sniff(stored);
        if (type == null) throw new Unavailable(415, "Not an image");
        write(file, stored);
        return new Image(stored, type);
    }

    // ----------------------------------------------------------------- disk
    private Image read(File file) {
        if (!file.isFile()) return null;
        InputStream in = null;
        try {
            long length = file.length();
            if (length <= 0 || length > MAX_DOWNLOAD_BYTES) return null;
            byte[] data = new byte[(int) length];
            in = new FileInputStream(file);
            int off = 0;
            while (off < data.length) {
                int n = in.read(data, off, data.length - off);
                if (n == -1) return null;
                off += n;
            }
            String type = sniff(data);
            if (type == null) return null;
            // Recently used files outlive old ones when the folder is trimmed.
            file.setLastModified(System.currentTimeMillis());
            return new Image(data, type);
        } catch (IOException e) {
            return null;
        } finally {
            if (in != null) {
                try {
                    in.close();
                } catch (IOException ignored) {
                    // ignore
                }
            }
        }
    }

    private void write(File file, byte[] data) {
        // Never fatal: with a full or read-only disk the image is still served, just not kept.
        if (!dir.isDirectory() && !dir.mkdirs() && !dir.isDirectory()) return;
        File temp = new File(dir, file.getName() + ".tmp" + Thread.currentThread().getId());
        FileOutputStream out = null;
        try {
            out = new FileOutputStream(temp);
            out.write(data);
            out.close();
            out = null;
            if (!temp.renameTo(file)) temp.delete();
        } catch (IOException e) {
            temp.delete();
        } finally {
            if (out != null) {
                try {
                    out.close();
                } catch (IOException ignored) {
                    // ignore
                }
                temp.delete();
            }
        }
        boolean trim;
        synchronized (this) {
            writtenSinceTrim += data.length;
            trim = writtenSinceTrim > Math.max(1L, maxBytes / 10);
            if (trim) writtenSinceTrim = 0;
        }
        if (trim) trim();
    }

    /** Deletes the least recently used files until the folder fits {@code maxBytes}. */
    public void trim() {
        File[] files = dir.listFiles();
        if (files == null) return;
        long total = 0;
        for (File f : files) total += f.length();
        if (total <= maxBytes) return;
        Arrays.sort(files, new Comparator<File>() {
            @Override
            public int compare(File a, File b) {
                return Long.compare(a.lastModified(), b.lastModified());
            }
        });
        // Down to 80% so the next write does not trim again at once.
        long target = maxBytes / 10 * 8;
        for (File f : files) {
            if (total <= target) break;
            long length = f.length();
            if (f.delete()) total -= length;
        }
    }

    private void remember(String key, long forMs) {
        if (failures.size() >= MAX_REMEMBERED_FAILURES) failures.clear();
        failures.put(key, Long.valueOf(System.currentTimeMillis() + forMs));
    }

    // ------------------------------------------------------------ validation
    static URI parse(String url) throws Unavailable {
        if (url == null || url.length() > 2048) throw new Unavailable(400, "Missing or invalid url");
        URI uri;
        try {
            uri = new URI(url.trim());
        } catch (java.net.URISyntaxException e) {
            throw new Unavailable(400, "Missing or invalid url");
        }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if ((!scheme.equals("http") && !scheme.equals("https")) || uri.getHost() == null) {
            throw new Unavailable(400, "Only http and https images are supported");
        }
        return uri;
    }

    /** localhost, loopback, link-local, private and IPv6 literal hosts. */
    static boolean isLocalOrPrivate(String host) {
        if (host.equals("localhost") || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
        if (host.indexOf(':') >= 0 || host.startsWith("[")) return true;
        String[] parts = host.split("\\.");
        if (parts.length != 4) return false;
        int[] octets = new int[4];
        for (int i = 0; i < 4; i++) {
            if (parts[i].isEmpty() || parts[i].length() > 3) return false;
            for (int c = 0; c < parts[i].length(); c++) if (!Character.isDigit(parts[i].charAt(c))) return false;
            octets[i] = Integer.parseInt(parts[i]);
            if (octets[i] > 255) return false;
        }
        return octets[0] == 0 || octets[0] == 10 || octets[0] == 127
            || (octets[0] == 169 && octets[1] == 254)
            || (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31)
            || (octets[0] == 192 && octets[1] == 168)
            || (octets[0] == 100 && octets[1] >= 64 && octets[1] <= 127);
    }

    /** The served type from the leading bytes, or null when it is not a raster image we serve. */
    static String sniff(byte[] b) {
        if (b == null || b.length < 12) return null;
        if ((b[0] & 0xff) == 0xff && (b[1] & 0xff) == 0xd8 && (b[2] & 0xff) == 0xff) return "image/jpeg";
        if ((b[0] & 0xff) == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G') return "image/png";
        if (b[0] == 'G' && b[1] == 'I' && b[2] == 'F' && b[3] == '8') return "image/gif";
        if (b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F' && b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P') return "image/webp";
        return null;
    }

    private static String sha256Hex(String text) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(text.getBytes("UTF-8"));
            StringBuilder out = new StringBuilder(digest.length * 2);
            for (byte value : digest) out.append(String.format("%02x", value & 0xff));
            return out.toString();
        } catch (NoSuchAlgorithmException | java.io.UnsupportedEncodingException e) {
            throw new IllegalStateException(e);
        }
    }
}
