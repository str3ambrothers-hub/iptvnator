package org.tvshell.iptvnator.ui;

import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.LoadControl;

/**
 * How far ahead the full-screen player downloads. "normal" keeps the player's own defaults (nothing
 * is changed); "large" and "xlarge" keep more of the stream ready so a short slowdown does not stop
 * playback. Live channels get smaller values than movies and series because every second buffered
 * is a second behind the broadcast. The memory cap matters on small sticks, so it ends the
 * buffering before the time does.
 */
final class PlayerBuffer {

    private static volatile String level = "normal";

    private PlayerBuffer() {
    }

    /** Set by the page (Settings, Playback, Buffer). Anything unknown means normal. */
    static void set(String value) {
        level = "large".equals(value) || "xlarge".equals(value) ? value : "normal";
    }

    static String level() {
        return level;
    }

    /** Null for "normal": the caller then leaves the player's default untouched. */
    static LoadControl loadControl(boolean live) {
        String current = level;
        boolean xl = "xlarge".equals(current);
        if (!xl && !"large".equals(current)) return null;
        int maxMs = live ? (xl ? 30_000 : 20_000) : (xl ? 180_000 : 90_000);
        int capBytes = (xl ? 64 : 40) * 1024 * 1024;
        return new DefaultLoadControl.Builder()
            .setBufferDurationsMs(maxMs / 2, maxMs, 2_500, xl ? 8_000 : 5_000)
            .setTargetBufferBytes(capBytes)
            .setPrioritizeTimeOverSizeThresholds(false)
            .build();
    }
}
