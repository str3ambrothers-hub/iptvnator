package org.tvshell.iptvnator.backend;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Keeps the newest parsed guide file and builds it in the background, so a request never waits
 * for the download: it answers "building" until the file is read, then serves from memory. One
 * guide is kept (the last login asked for); a build older than {@link #FRESH_MS} is rebuilt in the
 * background while the old one keeps being served. After a failure the next try waits
 * {@link #RETRY_AFTER_FAILURE_MS}.
 */
public final class XmltvGuideStore {

    static final long FRESH_MS = 25L * 60_000L;
    static final long RETRY_AFTER_FAILURE_MS = 60_000L;
    private static final int TIMEOUT_MS = 60_000;
    /** The decoded file may be this big; the kept part has its own, smaller cap. */
    private static final long MAX_FILE_BYTES = 400L * 1024 * 1024;

    private final HttpFetcher fetcher;
    private final long keptCapBytes;
    private final Object lock = new Object();
    private String key;
    private XmltvGuide.Snapshot snapshot;
    private boolean building;
    private String error;
    private long failedAtMs;
    private File cacheDir;
    /** A saved copy older than this is not used at all. */
    private static final long SAVED_MAX_AGE_MS = 2L * 3_600_000L;

    public XmltvGuideStore(HttpFetcher fetcher) {
        this(fetcher, Math.min(40L * 1024 * 1024, Runtime.getRuntime().maxMemory() / 6));
    }

    XmltvGuideStore(HttpFetcher fetcher, long keptCapBytes) {
        this.fetcher = fetcher;
        this.keptCapBytes = keptCapBytes;
    }

    /** Where the built guide is saved (null: nowhere). The OS may clear it, which only costs a download. */
    public void setCacheDir(File dir) {
        synchronized (lock) {
            cacheDir = dir;
        }
    }

    private File savedFile(String guideKey) {
        if (cacheDir == null) return null;
        try {
            byte[] digest = java.security.MessageDigest.getInstance("SHA-256").digest(guideKey.getBytes("UTF-8"));
            StringBuilder name = new StringBuilder("guide-");
            for (int i = 0; i < 12; i++) name.append(String.format("%02x", digest[i] & 0xff));
            return new File(cacheDir, name.append(".bin").toString());
        } catch (Exception e) {
            return null;
        }
    }

    private XmltvGuide.Snapshot loadSaved(String guideKey) {
        File file = savedFile(guideKey);
        if (file == null || !file.isFile()) return null;
        FileInputStream in = null;
        try {
            in = new FileInputStream(file);
            XmltvGuide.Snapshot loaded = XmltvGuide.Snapshot.loadFrom(in);
            if (System.currentTimeMillis() - loaded.builtAtMs > SAVED_MAX_AGE_MS) return null;
            return loaded;
        } catch (IOException e) {
            return null;
        } catch (RuntimeException e) {
            return null;
        } catch (OutOfMemoryError e) {
            return null;
        } finally {
            if (in != null) try { in.close(); } catch (IOException ignored) { /* nothing to do */ }
        }
    }

    private void save(String guideKey, XmltvGuide.Snapshot built) {
        File file = savedFile(guideKey);
        if (file == null) return;
        File temp = new File(file.getPath() + ".tmp");
        FileOutputStream out = null;
        try {
            cacheDir.mkdirs();
            out = new FileOutputStream(temp);
            built.saveTo(out);
            out.close();
            out = null;
            if (!temp.renameTo(file)) temp.delete();
        } catch (IOException e) {
            temp.delete();
        } finally {
            if (out != null) try { out.close(); } catch (IOException ignored) { /* nothing to do */ }
        }
    }

    /** Starts (or keeps) the build for {@code guideKey}; returns at once. */
    public Map<String, Object> start(final String guideKey, final String url, final Map<String, String> headers) {
        synchronized (lock) {
            if (!guideKey.equals(key)) {
                key = guideKey;
                snapshot = loadSaved(guideKey);
                error = null;
                failedAtMs = 0;
            }
            long now = System.currentTimeMillis();
            boolean fresh = snapshot != null && now - snapshot.builtAtMs < FRESH_MS;
            boolean coolingDown = error != null && now - failedAtMs < RETRY_AFTER_FAILURE_MS;
            if (!building && !fresh && !coolingDown) {
                building = true;
                final String buildingFor = guideKey;
                Thread worker = new Thread(new Runnable() {
                    @Override
                    public void run() {
                        build(buildingFor, url, headers);
                    }
                }, "xmltv-guide");
                worker.setDaemon(true);
                worker.start();
            }
            return state();
        }
    }

    private void build(final String buildingFor, String url, Map<String, String> headers) {
        XmltvGuide.Snapshot built = null;
        String failure = null;
        final long now = System.currentTimeMillis();
        final XmltvGuide.Snapshot[] holder = new XmltvGuide.Snapshot[1];
        try {
            fetcher.stream(url, headers, TIMEOUT_MS, MAX_FILE_BYTES, new HttpFetcher.StreamConsumer() {
                @Override
                public void consume(InputStream in) throws IOException {
                    holder[0] = XmltvGuide.parse(in, now - 3_600_000L, now + 12L * 3_600_000L, keptCapBytes);
                }
            });
            built = holder[0];
            if (built == null || built.channelCount() == 0) failure = "The guide file had no programmes";
        } catch (ProviderException e) {
            failure = e.hasHttpStatus() ? "Guide file: HTTP " + e.status : "Guide file: " + (e.code == null ? "failed" : e.code);
        } catch (RuntimeException e) {
            failure = "Guide file could not be read";
        } catch (OutOfMemoryError e) {
            failure = "Guide file is too big for this device";
        }
        synchronized (lock) {
            building = false;
            if (!buildingFor.equals(key)) return; // another login was asked for meanwhile
            if (failure == null) {
                snapshot = built;
                error = null;
                save(buildingFor, built);
            } else {
                error = failure;
                failedAtMs = System.currentTimeMillis();
            }
        }
    }

    /** idle | building | ready | error, with a few counters (no programme text). */
    public Map<String, Object> state() {
        synchronized (lock) {
            Map<String, Object> out = new LinkedHashMap<String, Object>();
            String state = snapshot != null ? "ready" : building ? "building" : error != null ? "error" : "idle";
            out.put("state", state);
            if (snapshot != null) {
                out.put("ageMs", Long.valueOf(System.currentTimeMillis() - snapshot.builtAtMs));
                out.put("channelCount", Integer.valueOf(snapshot.channelCount()));
                out.put("programmes", Integer.valueOf(snapshot.programmes));
                out.put("truncated", Boolean.valueOf(snapshot.truncated));
                out.put("refreshing", Boolean.valueOf(building));
            }
            if (error != null && snapshot == null) out.put("error", error);
            return out;
        }
    }

    /** {@code state()} plus the kept programmes of {@code ids}, as {@code "channels": {...}}. */
    public Map<String, Object> read(List<String> ids) {
        return read(ids, null);
    }

    /** Also {@code "byName"}: kept programmes of playlist channels that match a guide channel by name. */
    public Map<String, Object> read(List<String> ids, List<String> names) {
        Map<String, Object> out = state();
        XmltvGuide.Snapshot current;
        synchronized (lock) {
            current = snapshot;
        }
        if (current != null) {
            StringBuilder body = new StringBuilder("{");
            current.write(ids, body);
            body.append('}');
            out.put("channels", new Json.Raw(body.toString()));
            if (names != null && !names.isEmpty()) {
                StringBuilder byName = new StringBuilder("{");
                current.writeByName(names, byName);
                byName.append('}');
                out.put("byName", new Json.Raw(byName.toString()));
            }
        }
        return out;
    }
}
