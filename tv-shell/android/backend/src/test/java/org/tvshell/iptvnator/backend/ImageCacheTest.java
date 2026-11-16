package org.tvshell.iptvnator.backend;

import static org.tvshell.iptvnator.backend.TestMain.assertEquals;
import static org.tvshell.iptvnator.backend.TestMain.assertTrue;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Poster cache checks: scripted fetcher, a temp folder, no network. */
public class ImageCacheTest {

    static byte[] jpeg(int size, int fill) {
        byte[] b = new byte[Math.max(size, 16)];
        java.util.Arrays.fill(b, (byte) fill);
        b[0] = (byte) 0xff;
        b[1] = (byte) 0xd8;
        b[2] = (byte) 0xff;
        return b;
    }

    /** Answers the scripted body for any url and counts the downloads. */
    static final class FakeFetcher extends HttpFetcher {
        final List<String> urls = new ArrayList<String>();
        byte[] body = jpeg(100, 1);
        ProviderException failure;

        @Override
        public BinaryResult getBytes(String url, Map<String, String> headers, int timeoutMs, long limit) throws ProviderException {
            urls.add(url);
            if (failure != null) throw failure;
            return new BinaryResult(200, body, "image/jpeg");
        }
    }

    static File tempDir() throws IOException {
        File dir = File.createTempFile("imagecache", "");
        dir.delete();
        dir.mkdirs();
        return dir;
    }

    static void expectUnavailable(ImageCache cache, String url, int status) {
        try {
            cache.get(url, 0, Collections.<String>emptySet());
            throw new TestMain.AssertionFailed("expected " + status + " for " + url);
        } catch (ImageCache.Unavailable e) {
            assertEquals("status for " + url, Integer.valueOf(status), Integer.valueOf(e.status));
        }
    }

    public void testFetchedOnceThenServedFromDisk() throws Exception {
        File dir = tempDir();
        FakeFetcher fetcher = new FakeFetcher();
        ImageCache cache = new ImageCache(dir, 1_000_000, fetcher, null);
        Set<String> none = Collections.emptySet();
        ImageCache.Image first = cache.get("https://img.example.test/a.jpg", 300, none);
        ImageCache.Image second = cache.get("https://img.example.test/a.jpg", 300, none);
        assertEquals("one download", Integer.valueOf(1), Integer.valueOf(fetcher.urls.size()));
        assertEquals("type", "image/jpeg", first.contentType);
        assertTrue("same bytes", java.util.Arrays.equals(first.bytes, second.bytes));
        // A new instance (an app restart) still finds it on disk.
        new ImageCache(dir, 1_000_000, fetcher, null).get("https://img.example.test/a.jpg", 300, none);
        assertEquals("still one download after restart", Integer.valueOf(1), Integer.valueOf(fetcher.urls.size()));
        // Another size is another file.
        cache.get("https://img.example.test/a.jpg", 100, none);
        assertEquals("a second size downloads again", Integer.valueOf(2), Integer.valueOf(fetcher.urls.size()));
    }

    public void testTranscoderShrinksWhatIsStored() throws Exception {
        FakeFetcher fetcher = new FakeFetcher();
        fetcher.body = jpeg(5000, 2);
        final int[] widthSeen = new int[1];
        ImageCache cache = new ImageCache(tempDir(), 1_000_000, fetcher, new ImageCache.Transcoder() {
            @Override
            public byte[] downscale(byte[] original, int maxWidth) {
                widthSeen[0] = maxWidth;
                return jpeg(200, 3);
            }
        });
        ImageCache.Image image = cache.get("https://img.example.test/big.jpg", 99999, Collections.<String>emptySet());
        assertEquals("stored size", Integer.valueOf(200), Integer.valueOf(image.bytes.length));
        assertEquals("width is clamped", Integer.valueOf(ImageCache.MAX_WIDTH), Integer.valueOf(widthSeen[0]));
    }

    public void testNonImagesAreRefusedAndRememberedAsFailures() throws Exception {
        FakeFetcher fetcher = new FakeFetcher();
        fetcher.body = "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>".getBytes("UTF-8");
        ImageCache cache = new ImageCache(tempDir(), 1_000_000, fetcher, null);
        expectUnavailable(cache, "https://img.example.test/x.svg", 415);
        expectUnavailable(cache, "https://img.example.test/x.svg", 404);
        assertEquals("the failure is not retried at once", Integer.valueOf(1), Integer.valueOf(fetcher.urls.size()));
        assertTrue("html is not an image", ImageCache.sniff("<!doctype html><html>".getBytes("UTF-8")) == null);
        assertEquals("png", "image/png", ImageCache.sniff(new byte[] {(byte) 0x89, 'P', 'N', 'G', 13, 10, 26, 10, 0, 0, 0, 0}));
        assertEquals("webp", "image/webp", ImageCache.sniff(new byte[] {'R', 'I', 'F', 'F', 0, 0, 0, 0, 'W', 'E', 'B', 'P'}));
    }

    public void testProviderErrorsAreUnavailable() throws Exception {
        FakeFetcher fetcher = new FakeFetcher();
        fetcher.failure = new ProviderException(404, "Not Found");
        ImageCache cache = new ImageCache(tempDir(), 1_000_000, fetcher, null);
        expectUnavailable(cache, "https://img.example.test/gone.jpg", 404);
        fetcher.failure = new ProviderException("timeout", "ETIMEDOUT");
        expectUnavailable(cache, "https://img.example.test/slow.jpg", 502);
    }

    public void testOnlyPublicHttpUrlsUnlessTheHostIsAProvider() throws Exception {
        FakeFetcher fetcher = new FakeFetcher();
        ImageCache cache = new ImageCache(tempDir(), 1_000_000, fetcher, null);
        expectUnavailable(cache, "file:///etc/passwd", 400);
        expectUnavailable(cache, "ftp://img.example.test/a.jpg", 400);
        expectUnavailable(cache, "not a url", 400);
        expectUnavailable(cache, null, 400);
        expectUnavailable(cache, "http://127.0.0.1:43330/api/health", 403);
        expectUnavailable(cache, "http://localhost/a.jpg", 403);
        expectUnavailable(cache, "http://192.168.1.10/a.jpg", 403);
        expectUnavailable(cache, "http://10.0.0.5/a.jpg", 403);
        expectUnavailable(cache, "http://172.16.0.1/a.jpg", 403);
        expectUnavailable(cache, "http://169.254.169.254/latest", 403);
        expectUnavailable(cache, "http://[::1]/a.jpg", 403);
        assertEquals("nothing was fetched", Integer.valueOf(0), Integer.valueOf(fetcher.urls.size()));
        assertTrue("172.32 is public", !ImageCache.isLocalOrPrivate("172.32.0.1"));
        assertTrue("a name is public", !ImageCache.isLocalOrPrivate("images.example.test"));
        Set<String> trusted = new HashSet<String>();
        trusted.add("192.168.1.10");
        cache.get("http://192.168.1.10/poster.jpg", 0, trusted);
        assertEquals("a provider on the LAN is served", Integer.valueOf(1), Integer.valueOf(fetcher.urls.size()));
    }

    public void testFolderIsTrimmedToItsLimit() throws Exception {
        File dir = tempDir();
        FakeFetcher fetcher = new FakeFetcher();
        fetcher.body = jpeg(1000, 4);
        ImageCache cache = new ImageCache(dir, 5000, fetcher, null);
        for (int i = 0; i < 20; i++) cache.get("https://img.example.test/" + i + ".jpg", 0, Collections.<String>emptySet());
        long total = 0;
        for (File f : dir.listFiles()) total += f.length();
        assertTrue("trimmed to the limit, was " + total, total <= 5000);
        assertTrue("not emptied", dir.listFiles().length > 0);
    }

    public void testBackendRoute() throws Exception {
        FakeFetcher fetcher = new FakeFetcher();
        WebBackend without = new WebBackend(fetcher, "/api");
        assertEquals("no cache, no route", Integer.valueOf(404),
            Integer.valueOf(without.handle("GET", "/image", WebBackendTest.query("url", "https://img.example.test/a.jpg"), null).status));

        WebBackend backend = new WebBackend(fetcher, "/api", new ImageCache(tempDir(), 1_000_000, fetcher, null));
        WebBackend.Response ok = backend.handle("GET", "/image", WebBackendTest.query("url", "https://img.example.test/a.jpg", "w", "300"), null);
        assertEquals("status", Integer.valueOf(200), Integer.valueOf(ok.status));
        assertEquals("type", "image/jpeg", ok.contentType);
        assertEquals("cacheable", "public, max-age=604800", ok.headers.get("Cache-Control"));
        assertEquals("nosniff", "nosniff", ok.headers.get("X-Content-Type-Options"));
        assertEquals("missing url", Integer.valueOf(400),
            Integer.valueOf(backend.handle("GET", "/image", WebBackendTest.query(), null).status));
        assertEquals("loopback", Integer.valueOf(403),
            Integer.valueOf(backend.handle("GET", "/image", WebBackendTest.query("url", "http://127.0.0.1/x.jpg"), null).status));
        assertEquals("a bad width falls back", Integer.valueOf(200),
            Integer.valueOf(backend.handle("GET", "/image", WebBackendTest.query("url", "https://img.example.test/b.jpg", "w", "abc"), null).status));
    }
}
