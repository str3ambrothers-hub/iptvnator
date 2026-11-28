package org.tvshell.iptvnator.backend;

import static org.tvshell.iptvnator.backend.TestMain.assertEquals;
import static org.tvshell.iptvnator.backend.TestMain.assertTrue;

import java.io.File;
import java.util.Map;

/** The weekly streaming-service lists: only a real lists file is saved, and the saved copy is served. */
public class StreamingListsTest {

    private static final String GOOD = "{\"format\":2,\"region\":\"CA+US\",\"generatedAt\":\"2026-11-28T00:00:00.000Z\",\"services\":[{\"name\":\"Netflix\",\"movie\":[1,2],\"tv\":[3]}]}";

    static final class Answering extends HttpFetcher {
        int status = 200;
        String body = GOOD;
        int calls;

        @Override
        public BinaryResult getBytes(String url, Map<String, String> headers, int timeoutMs, long limit) throws ProviderException {
            calls++;
            try {
                return new BinaryResult(status, body.getBytes("UTF-8"), "application/json");
            } catch (java.io.UnsupportedEncodingException e) {
                throw new IllegalStateException(e);
            }
        }
    }

    private static File temp() throws Exception {
        File dir = File.createTempFile("streaming", "");
        dir.delete();
        dir.mkdirs();
        return dir;
    }

    public void testOnlyARealListsFileIsRecognised() {
        assertTrue("the real file", StreamingLists.looksValid(GOOD.getBytes()));
        assertTrue("an error page is not", !StreamingLists.looksValid("<html>Not Found</html>".getBytes()));
        assertTrue("an empty list is not", !StreamingLists.looksValid("{\"services\":[]}".getBytes()));
        assertTrue("nothing is not", !StreamingLists.looksValid(null));
    }

    public void testSavesTheDownloadAndKeepsItWhenALaterOneIsBad() throws Exception {
        Answering fetcher = new Answering();
        StreamingLists lists = new StreamingLists(fetcher, "https://example.invalid/streaming.json");
        File dir = temp();
        lists.setCacheDir(dir);
        assertTrue("downloaded and saved", lists.refreshNow());
        assertEquals("saved copy is served", GOOD, new String(lists.current(), "UTF-8"));
        fetcher.body = "<html>oops</html>";
        assertTrue("a bad answer is not saved", !lists.refreshNow());
        assertEquals("the good copy is still served", GOOD, new String(lists.current(), "UTF-8"));
        fetcher.status = 404;
        fetcher.body = GOOD;
        assertTrue("an error status is not saved", !lists.refreshNow());
    }

    public void testNothingSavedYetAnswersNull() throws Exception {
        StreamingLists lists = new StreamingLists(new Answering(), "https://example.invalid/streaming.json");
        lists.setCacheDir(temp());
        // current() starts a background refresh; the answer for this call is "nothing yet".
        assertTrue("no copy yet", lists.current() == null);
    }
}
