package org.tvshell.iptvnator.ui;

/**
 * The two servers of a login (main and backup) as the page last reported them: which one stream links
 * are built on right now, and which is the other. The built-in player uses it to move a failing or
 * frozen stream to the other server, and the page is told afterwards so it follows.
 */
final class ServerPair {
    private static volatile String active = "";
    private static volatile String other = "";
    private static volatile String switchedTo;

    /** Set by the main screen: tells the page (right now) that the player moved to the other server. */
    static volatile Runnable pageNotifier;

    private ServerPair() {}

    static void notifyPage() {
        Runnable r = pageNotifier;
        if (r != null) r.run();
    }

    static synchronized void set(String newActive, String newOther) {
        active = newActive == null ? "" : stripSlash(newActive.trim());
        other = newOther == null ? "" : stripSlash(newOther.trim());
    }

    /** The stream address on the other server, or null when there is no other server for it. Swaps the pair. */
    static synchronized String switchTo(String streamUrl) {
        if (streamUrl == null || active.isEmpty() || other.isEmpty()) return null;
        String rewritten = null;
        if (startsWithIgnoreCase(streamUrl, active)) rewritten = other + streamUrl.substring(active.length());
        else if (startsWithIgnoreCase(streamUrl, other)) rewritten = active + streamUrl.substring(other.length());
        if (rewritten == null) return null;
        String newActive = startsWithIgnoreCase(streamUrl, active) ? other : active;
        other = startsWithIgnoreCase(streamUrl, active) ? active : other;
        active = newActive;
        switchedTo = active;
        return rewritten;
    }

    /** The server the player moved to since the page was last told (read once). */
    static synchronized String takeSwitched() {
        String value = switchedTo;
        switchedTo = null;
        return value;
    }

    private static boolean startsWithIgnoreCase(String text, String prefix) {
        return text.regionMatches(true, 0, prefix, 0, prefix.length())
            && (text.length() == prefix.length() || "/?#".indexOf(text.charAt(prefix.length())) >= 0);
    }

    private static String stripSlash(String value) {
        while (value.endsWith("/")) value = value.substring(0, value.length() - 1);
        return value;
    }
}
