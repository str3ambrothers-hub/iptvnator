package org.tvshell.iptvnator.backend;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.Charset;
import java.util.Collections;

/**
 * The weekly streaming-service lists (which titles Netflix, Disney+ and the others carry), published
 * once by the build server. The newest copy is kept on the device; a copy older than a day is
 * refreshed in the background while the saved one keeps being served. No token is involved: this is
 * a plain download of one public file, so the devices never talk to TMDB.
 */
public final class StreamingLists {

    static final long FRESH_MS = 24L * 3_600_000L;
    static final long RETRY_MS = 15L * 60_000L;
    private static final long MAX_BYTES = 40L * 1024 * 1024;
    private static final int TIMEOUT_MS = 30_000;

    private final HttpFetcher fetcher;
    private final String url;
    private final Object lock = new Object();
    private File dir;
    private boolean refreshing;
    private long triedAtMs;

    public StreamingLists(HttpFetcher fetcher, String url) {
        this.fetcher = fetcher;
        this.url = url;
    }

    public void setCacheDir(File cacheDir) {
        synchronized (lock) {
            dir = cacheDir;
        }
    }

    private File file() {
        return dir == null ? null : new File(dir, "streaming.json");
    }

    /** The saved copy, or null when there is none yet. Starts a background refresh when it is old. */
    public byte[] current() {
        File file;
        boolean refresh = false;
        synchronized (lock) {
            file = file();
            if (file == null) return null;
            long now = System.currentTimeMillis();
            boolean stale = !file.isFile() || now - file.lastModified() > FRESH_MS;
            if (stale && !refreshing && now - triedAtMs > RETRY_MS) {
                refreshing = true;
                triedAtMs = now;
                refresh = true;
            }
        }
        if (refresh) {
            Thread worker = new Thread(new Runnable() {
                @Override
                public void run() {
                    try {
                        refreshNow();
                    } finally {
                        synchronized (lock) {
                            refreshing = false;
                        }
                    }
                }
            }, "streaming-lists");
            worker.setDaemon(true);
            worker.start();
        }
        return read(file);
    }

    private static byte[] read(File file) {
        if (file == null || !file.isFile() || file.length() > MAX_BYTES) return null;
        InputStream in = null;
        try {
            in = new FileInputStream(file);
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream((int) file.length());
            byte[] buffer = new byte[16 * 1024];
            int n;
            while ((n = in.read(buffer)) > 0) out.write(buffer, 0, n);
            return out.toByteArray();
        } catch (IOException e) {
            return null;
        } finally {
            if (in != null) try { in.close(); } catch (IOException ignored) { /* nothing to do */ }
        }
    }

    /** True when the downloaded text looks like the lists file (so a page of errors is never saved). */
    static boolean looksValid(byte[] body) {
        if (body == null || body.length < 20) return false;
        String text = new String(body, Charset.forName("UTF-8"));
        String head = text.trim();
        return head.startsWith("{") && head.endsWith("}") && text.contains("\"services\":[{");
    }

    /** Downloads and saves the newest file; returns whether a new copy was saved. */
    boolean refreshNow() {
        File file;
        synchronized (lock) {
            file = file();
        }
        if (file == null) return false;
        try {
            HttpFetcher.BinaryResult result = fetcher.getBytes(url, Collections.<String, String>emptyMap(), TIMEOUT_MS, MAX_BYTES);
            if (result == null || result.status != 200 || !looksValid(result.body)) return false;
            file.getParentFile().mkdirs();
            File temp = new File(file.getPath() + ".tmp");
            FileOutputStream out = new FileOutputStream(temp);
            try {
                out.write(result.body);
            } finally {
                out.close();
            }
            if (!temp.renameTo(file)) {
                temp.delete();
                return false;
            }
            return true;
        } catch (ProviderException e) {
            return false;
        } catch (IOException e) {
            return false;
        } catch (RuntimeException e) {
            return false;
        }
    }
}
