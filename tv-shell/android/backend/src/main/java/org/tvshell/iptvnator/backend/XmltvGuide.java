package org.tvshell.iptvnator.backend;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.Charset;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import javax.xml.parsers.SAXParser;
import javax.xml.parsers.SAXParserFactory;

import org.xml.sax.Attributes;
import org.xml.sax.InputSource;
import org.xml.sax.SAXException;
import org.xml.sax.helpers.DefaultHandler;

/**
 * The provider's guide file (XMLTV, {@code xmltv.php}) read as a stream, keeping only the
 * programmes that overlap a time window, per channel, as small JSON fragments:
 * {@code [startSeconds,stopSeconds,"title","description"]}. The file is never held whole, so a big
 * guide costs only the kept part, which is capped (the cap follows the heap, like the other
 * provider answers). Channel ids are matched case-insensitively.
 */
public final class XmltvGuide {

    private static final Charset UTF8 = Charset.forName("UTF-8");
    private static final int MAX_TITLE = 160;
    private static final int MAX_DESC = 240;

    /** What was kept from one file. */
    public static final class Snapshot {
        private final Map<String, ByteArrayOutputStream> channels = new HashMap<String, ByteArrayOutputStream>();
        private final Map<String, String> nameIndex = new HashMap<String, String>();
        private long bytes;
        public final long builtAtMs;
        /** The kept part hit the cap, so some programmes are missing. */
        public boolean truncated;
        public int programmes;

        Snapshot(long builtAtMs) {
            this.builtAtMs = builtAtMs;
        }

        public int channelCount() {
            return channels.size();
        }

        public boolean has(String channelId) {
            return channels.containsKey(key(channelId));
        }

        /** Appends {@code "id":[...]} entries for the ids that were kept, comma separated. */
        public void write(List<String> ids, StringBuilder out) {
            boolean first = true;
            for (String id : ids) {
                ByteArrayOutputStream kept = channels.get(key(id));
                if (kept == null) continue;
                if (!first) out.append(',');
                first = false;
                Json.write(id, out);
                out.append(":[").append(new String(kept.toByteArray(), UTF8)).append(']');
            }
        }

        /** Remembers a channel's name (and id) so a playlist channel can be matched by name. */
        void addName(String channelId, String name) {
            String normalized = normName(name);
            if (normalized.length() >= 3 && !nameIndex.containsKey(normalized)) nameIndex.put(normalized, channelId);
        }

        /** Appends {@code "name":[...]} entries for playlist names that match a kept channel by name. */
        public void writeByName(List<String> names, StringBuilder out) {
            boolean first = true;
            for (String name : names) {
                String id = nameIndex.get(normName(name));
                ByteArrayOutputStream kept = id == null ? null : channels.get(key(id));
                if (kept == null) continue;
                if (!first) out.append(',');
                first = false;
                Json.write(name, out);
                out.append(":[").append(new String(kept.toByteArray(), UTF8)).append(']');
            }
        }

        void add(String channelId, long startMs, long stopMs, String title, String desc, long maxBytes) {
            if (bytes >= maxBytes) {
                truncated = true;
                return;
            }
            StringBuilder item = new StringBuilder(64 + title.length() + desc.length());
            item.append('[').append(startMs / 1000).append(',').append(stopMs / 1000).append(',');
            Json.write(title, item);
            item.append(',');
            Json.write(desc, item);
            item.append(']');
            byte[] encoded = item.toString().getBytes(UTF8);
            String k = key(channelId);
            ByteArrayOutputStream kept = channels.get(k);
            if (kept == null) {
                kept = new ByteArrayOutputStream(512);
                channels.put(k, kept);
            } else {
                kept.write(',');
                bytes++;
            }
            kept.write(encoded, 0, encoded.length);
            bytes += encoded.length;
            programmes++;
        }
    }

    private XmltvGuide() {
    }

    /** Words that differ between a playlist's channel names and the guide's, dropped before comparing. */
    private static final java.util.Set<String> NAME_NOISE = new java.util.HashSet<String>(Arrays.asList(
        "hd", "fhd", "uhd", "sd", "4k", "hevc", "h265", "h264", "usa", "us", "ca", "can", "canada", "uk"));

    /** Lower case, brackets and noise words and everything but letters and digits removed. */
    static String normName(String raw) {
        if (raw == null) return "";
        String s = raw.toLowerCase(Locale.ROOT).replaceAll("[\\[(].*?[\\])]", " ");
        StringBuilder out = new StringBuilder();
        for (String token : s.split("[^\\p{L}\\p{Nd}]+")) {
            if (token.isEmpty() || NAME_NOISE.contains(token)) continue;
            out.append(token);
        }
        return out.toString();
    }

    static String key(String channelId) {
        return channelId == null ? "" : channelId.trim().toLowerCase(Locale.ROOT);
    }

    /** Reads {@code in}, keeping programmes that overlap [fromMs, toMs). */
    public static Snapshot parse(InputStream in, final long fromMs, final long toMs, final long maxBytes) throws IOException {
        final Snapshot snapshot = new Snapshot(System.currentTimeMillis());
        DefaultHandler handler = new DefaultHandler() {
            private StringBuilder text;
            private String channel;
            private long start;
            private long stop;
            private boolean keep;
            private String title;
            private String desc;
            private String channelDef;
            private StringBuilder nameText;

            @Override
            public void startElement(String uri, String localName, String qName, Attributes attrs) {
                if ("channel".equals(qName)) {
                    channelDef = attrs.getValue("id");
                    if (channelDef != null) snapshot.addName(channelDef, channelDef.replaceAll("\\.[A-Za-z]{2,3}\\d*$", ""));
                } else if (channelDef != null && "display-name".equals(qName)) {
                    nameText = new StringBuilder();
                } else if ("programme".equals(qName)) {
                    channel = attrs.getValue("channel");
                    start = parseTime(attrs.getValue("start"));
                    stop = parseTime(attrs.getValue("stop"));
                    keep = channel != null && start != Long.MIN_VALUE && stop != Long.MIN_VALUE
                        && stop > fromMs && start < toMs && stop > start;
                    title = null;
                    desc = null;
                    text = null;
                } else if (keep && title == null && "title".equals(qName)) {
                    text = new StringBuilder();
                } else if (keep && desc == null && "desc".equals(qName)) {
                    text = new StringBuilder();
                }
            }

            @Override
            public void characters(char[] ch, int begin, int length) {
                if (nameText != null && nameText.length() < 200) nameText.append(ch, begin, length);
                if (text != null && text.length() < MAX_DESC + 64) text.append(ch, begin, length);
            }

            @Override
            public void endElement(String uri, String localName, String qName) {
                if ("channel".equals(qName)) {
                    channelDef = null;
                    nameText = null;
                } else if (nameText != null && "display-name".equals(qName)) {
                    if (channelDef != null) snapshot.addName(channelDef, nameText.toString());
                    nameText = null;
                } else if (text != null && "title".equals(qName) && title == null) {
                    title = clip(text.toString(), MAX_TITLE);
                    text = null;
                } else if (text != null && "desc".equals(qName) && desc == null) {
                    desc = clip(text.toString(), MAX_DESC);
                    text = null;
                } else if ("programme".equals(qName)) {
                    if (keep) snapshot.add(channel, start, stop, title == null ? "" : title, desc == null ? "" : desc, maxBytes);
                    keep = false;
                    text = null;
                }
            }

            @Override
            public InputSource resolveEntity(String publicId, String systemId) {
                // Never fetch an external DTD or entity named by the file.
                return new InputSource(new java.io.StringReader(""));
            }
        };
        try {
            SAXParserFactory factory = SAXParserFactory.newInstance();
            factory.setNamespaceAware(false);
            try {
                factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
                factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
            } catch (Exception ignored) {
                // Not every parser knows these; resolveEntity above covers the same ground.
            }
            SAXParser parser = factory.newSAXParser();
            InputSource source = new InputSource(in);
            parser.parse(source, handler);
        } catch (SAXException e) {
            throw new IOException("Guide file could not be read: " + e.getMessage());
        } catch (javax.xml.parsers.ParserConfigurationException e) {
            throw new IOException("No XML reader available");
        }
        return snapshot;
    }

    private static String clip(String value, int max) {
        String trimmed = value.trim().replaceAll("\\s+", " ");
        return trimmed.length() <= max ? trimmed : trimmed.substring(0, max - 1) + "…";
    }

    /**
     * XMLTV time "20261127133000 +0000" (seconds and offset optional; no offset means UTC) as
     * epoch milliseconds, or Long.MIN_VALUE when it does not parse.
     */
    static long parseTime(String value) {
        if (value == null) return Long.MIN_VALUE;
        String v = value.trim();
        int digits = 0;
        while (digits < v.length() && Character.isDigit(v.charAt(digits))) digits++;
        if (digits < 12) return Long.MIN_VALUE;
        try {
            int year = Integer.parseInt(v.substring(0, 4));
            int month = Integer.parseInt(v.substring(4, 6));
            int day = Integer.parseInt(v.substring(6, 8));
            int hour = Integer.parseInt(v.substring(8, 10));
            int minute = Integer.parseInt(v.substring(10, 12));
            int second = digits >= 14 ? Integer.parseInt(v.substring(12, 14)) : 0;
            long offsetMs = 0;
            String rest = v.substring(digits).trim();
            if (rest.length() >= 5 && (rest.charAt(0) == '+' || rest.charAt(0) == '-')) {
                int oh = Integer.parseInt(rest.substring(1, 3));
                int om = Integer.parseInt(rest.substring(3, 5));
                offsetMs = (oh * 60L + om) * 60_000L * (rest.charAt(0) == '-' ? -1 : 1);
            }
            long days = daysFromCivil(year, month, day);
            long seconds = days * 86_400L + hour * 3_600L + minute * 60L + second;
            return seconds * 1000L - offsetMs;
        } catch (NumberFormatException e) {
            return Long.MIN_VALUE;
        }
    }

    /** Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm). */
    private static long daysFromCivil(int y, int m, int d) {
        y -= m <= 2 ? 1 : 0;
        long era = (y >= 0 ? y : y - 399) / 400;
        long yoe = y - era * 400;
        long doy = (153L * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
        long doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        return era * 146097 + doe - 719468;
    }
}
