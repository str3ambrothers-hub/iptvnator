package org.tvshell.iptvnator.ui;

import android.content.Context;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.LayoutInflater;
import android.widget.Toast;

import org.tvshell.iptvnator.R;
import org.tvshell.iptvnator.ShellApp;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;

import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.ui.AspectRatioFrameLayout;
import androidx.media3.ui.PlayerView;

/**
 * The small live picture in the programme guide's corner: a Media3 player drawn over the page at
 * the rectangle the page names. It never takes focus (the remote keeps working on the page), has no
 * controls, and is dropped whenever the guide closes, another channel is picked, or the app leaves
 * the foreground. Full screen is the normal built-in player, started by the page.
 */
final class PreviewPlayer {
    private final Context context;
    private final FrameLayout root;
    private ExoPlayer player;
    private PlayerView view;
    private String url;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private Runnable report;
    private Runnable stall;
    private int retries;
    private static final int MAX_RETRIES = 4;

    PreviewPlayer(Context context, FrameLayout root) {
        this.context = context;
        this.root = root;
    }

    /** Pixels of the window; the page converts CSS pixels with its device pixel ratio. */
    void start(String streamUrl, int left, int top, int width, int height) {
        if (streamUrl == null || streamUrl.isEmpty() || width < 16 || height < 16) return;
        boolean same = streamUrl.equals(url) && player != null;
        url = streamUrl;
        if (view == null) {
            // A TextureView surface: it draws in the view tree, so it shows over the WebView.
            view = (PlayerView) LayoutInflater.from(context).inflate(R.layout.preview_player_view, null);
            view.setUseController(false);
            view.setFocusable(false);
            view.setFocusableInTouchMode(false);
            view.setDescendantFocusability(ViewGroup.FOCUS_BLOCK_DESCENDANTS);
            view.setClickable(false);
            view.setResizeMode(AspectRatioFrameLayout.RESIZE_MODE_FIT);
            view.setShutterBackgroundColor(0xFF000000);
            view.setBackgroundColor(0xFF000000);
        }
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(width, height, Gravity.TOP | Gravity.START);
        lp.leftMargin = left;
        lp.topMargin = top;
        if (view.getParent() == null) root.addView(view, lp);
        else view.setLayoutParams(lp);
        view.setVisibility(View.VISIBLE);
        if (same) return; // only moved
        retries = 0;
        open(streamUrl);
        final int w = width, h = height, l = left, t = top;
        final ExoPlayer watched = player;
        if (report != null) handler.removeCallbacks(report);
        report = new Runnable() {
            @Override public void run() {
                if (player != watched || view == null) return;
                String state = new String[] {"?", "IDLE", "BUFFERING", "READY", "ENDED"}[Math.min(4, Math.max(0, watched.getPlaybackState()))];
                androidx.media3.common.VideoSize vs = watched.getVideoSize();
                String msg = "Preview " + state + (watched.isPlaying() ? " playing" : "") + " video " + vs.width + "x" + vs.height
                    + " box " + w + "x" + h + "@" + l + "," + t + " view " + view.getWidth() + "x" + view.getHeight() + (view.isShown() ? " shown" : " hidden");
                Log.i(ShellApp.TAG, msg);
                Toast.makeText(context.getApplicationContext(), msg, Toast.LENGTH_LONG).show();
            }
        };
        handler.postDelayed(report, 5000);
    }

    /** Builds a fresh player for the stream (also used to reconnect after a failure). */
    private void open(final String streamUrl) {
        release();
        DefaultHttpDataSource.Factory http = new DefaultHttpDataSource.Factory()
            .setAllowCrossProtocolRedirects(true)
            .setConnectTimeoutMs(15_000)
            .setReadTimeoutMs(20_000)
            .setUserAgent("VLC/3.0.20 LibVLC/3.0.20");
        final ExoPlayer[] thisPlayer = new ExoPlayer[1];
        player = new ExoPlayer.Builder(context)
            .setMediaSourceFactory(new DefaultMediaSourceFactory(context).setDataSourceFactory(http))
            .build();
        player.addListener(new Player.Listener() {
            @Override
            public void onIsPlayingChanged(boolean playing) {
                if (playing) retries = 0;
            }

            @Override
            public void onPlaybackStateChanged(int state) {
                if (stall != null) handler.removeCallbacks(stall);
                if (state != Player.STATE_BUFFERING) return;
                // Frozen: still waiting for data after a while, so try the other server.
                stall = new Runnable() {
                    @Override public void run() {
                        if (player != thisPlayer[0] || view == null || !streamUrl.equals(url)) return;
                        if (thisPlayer[0].getPlaybackState() != Player.STATE_BUFFERING) return;
                        String moved = ServerPair.switchTo(streamUrl);
                        if (moved == null) return;
                        url = moved;
                        ServerPair.notifyPage();
                        open(moved);
                    }
                };
                handler.postDelayed(stall, 15_000);
            }

            @Override
            public void onPlayerError(PlaybackException error) {
                Log.w(ShellApp.TAG, "preview failed: " + error.getErrorCodeName() + " " + streamUrl.replaceAll("//[^/]*/.*", "//…"));
                if (player != thisPlayer[0]) return;
                // The provider drops a live connection now and then (or limits connections): a fresh
                // connection a moment later usually works, so the picture comes back on its own.
                if (retries < MAX_RETRIES && streamUrl.equals(url)) {
                    retries++;
                    // After two failed tries on this server, move to the other one (main <-> backup).
                    String next = streamUrl;
                    if (retries >= 2) {
                        String moved = ServerPair.switchTo(streamUrl);
                        if (moved != null) {
                            next = moved;
                            url = moved;
                            ServerPair.notifyPage();
                        }
                    }
                    final String target = next;
                    handler.postDelayed(new Runnable() {
                        @Override public void run() {
                            if (player == thisPlayer[0] && target.equals(url) && view != null) open(target);
                        }
                    }, 2000L * retries);
                    return;
                }
                String why = error.getErrorCodeName();
                Throwable c = error.getCause();
                if (c instanceof androidx.media3.datasource.HttpDataSource.InvalidResponseCodeException) {
                    why += " " + ((androidx.media3.datasource.HttpDataSource.InvalidResponseCodeException) c).responseCode;
                }
                Toast.makeText(context.getApplicationContext(), "Preview: " + why, Toast.LENGTH_LONG).show();
            }
        });
        thisPlayer[0] = player;
        view.setPlayer(player);
        player.setMediaItem(MediaItem.fromUri(Uri.parse(streamUrl)));
        player.setPlayWhenReady(true);
        player.prepare();
    }

    /** Removes the picture and frees the decoder and the provider connection. */
    void stop() {
        if (report != null) handler.removeCallbacks(report);
        if (stall != null) handler.removeCallbacks(stall);
        release();
        url = null;
        if (view != null) {
            view.setPlayer(null);
            if (view.getParent() != null) root.removeView(view);
        }
    }

    boolean isShowing() {
        return player != null;
    }

    private void release() {
        if (player != null) {
            try {
                player.release();
            } catch (RuntimeException ignored) {
                // already gone
            }
            player = null;
        }
    }
}
