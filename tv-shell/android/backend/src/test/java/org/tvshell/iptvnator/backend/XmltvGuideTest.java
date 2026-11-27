package org.tvshell.iptvnator.backend;

import static org.tvshell.iptvnator.backend.TestMain.assertEquals;
import static org.tvshell.iptvnator.backend.TestMain.assertTrue;

import java.io.ByteArrayInputStream;
import java.util.Arrays;

/** The guide file reader: times, the window, matching of ids and the cap. */
public class XmltvGuideTest {

    private static final long T = 1795786200000L; // 2026-11-27 13:30:00 UTC

    private static XmltvGuide.Snapshot parse(String xml, long from, long to, long cap) throws Exception {
        return XmltvGuide.parse(new ByteArrayInputStream(xml.getBytes("UTF-8")), from, to, cap);
    }

    private static String read(XmltvGuide.Snapshot snapshot, String... ids) {
        StringBuilder out = new StringBuilder();
        snapshot.write(Arrays.asList(ids), out);
        return out.toString();
    }

    public void testTimes() {
        assertEquals("utc", Long.valueOf(T), Long.valueOf(XmltvGuide.parseTime("20261127133000 +0000")));
        assertEquals("no offset is utc", Long.valueOf(T), Long.valueOf(XmltvGuide.parseTime("20261127133000")));
        assertEquals("offset", Long.valueOf(1795804200000L), Long.valueOf(XmltvGuide.parseTime("20261127133000 -0500")));
        assertEquals("no seconds", Long.valueOf(T), Long.valueOf(XmltvGuide.parseTime("202611271330 +0000")));
        assertEquals("junk", Long.valueOf(Long.MIN_VALUE), Long.valueOf(XmltvGuide.parseTime("soon")));
    }

    public void testKeepsOnlyTheWindowAndMatchesIdsAnyCase() throws Exception {
        String xml = "<?xml version=\"1.0\"?><!DOCTYPE tv SYSTEM \"xmltv.dtd\"><tv>"
            + "<channel id=\"ESPN.us\"><display-name>ESPN</display-name></channel>"
            + "<programme start=\"20261127120000 +0000\" stop=\"20261127133000 +0000\" channel=\"ESPN.us\"><title>Old &amp; gone</title></programme>"
            + "<programme start=\"20261127133000 +0000\" stop=\"20261127143000 +0000\" channel=\"ESPN.us\"><title lang=\"en\">Live \"game\"</title><desc>A long match</desc></programme>"
            + "<programme start=\"20261128133000 +0000\" stop=\"20261128143000 +0000\" channel=\"ESPN.us\"><title>Tomorrow</title></programme>"
            + "</tv>";
        XmltvGuide.Snapshot snapshot = parse(xml, T + 1000, T + 6 * 3_600_000L, 1 << 20);
        assertEquals("one programme kept", Integer.valueOf(1), Integer.valueOf(snapshot.programmes));
        assertTrue("id matches in any case", snapshot.has("espn.US"));
        String json = read(snapshot, "espn.US", "missing");
        assertEquals("json", "\"espn.US\":[[1795786200,1795789800,\"Live \\\"game\\\"\",\"A long match\"]]", json);
    }

    public void testCapMarksTruncated() throws Exception {
        StringBuilder xml = new StringBuilder("<tv>");
        for (int i = 0; i < 50; i++) {
            xml.append("<programme start=\"20261127133000 +0000\" stop=\"20261127143000 +0000\" channel=\"c").append(i).append("\"><title>Show</title></programme>");
        }
        xml.append("</tv>");
        try {
            XmltvGuide.Snapshot snapshot = parse(xml.toString(), T, T + 3_600_000L, 200);
            assertTrue("truncated", snapshot.truncated);
            assertTrue("kept some", snapshot.programmes > 0 && snapshot.programmes < 50);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    public void testNotXmlIsAnError() {
        boolean failed = false;
        try {
            parse("this is not xml", T, T + 1, 1000);
        } catch (Exception e) {
            failed = true;
        }
        assertTrue("fails", failed);
    }
}
