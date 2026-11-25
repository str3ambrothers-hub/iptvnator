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
        release();
        DefaultHttpDataSource.Factory http = new DefaultHttpDataSource.Factory()
            .setAllowCrossProtocolRedirects(true)
            .setConnectTimeoutMs(15_000)
            .setReadTimeoutMs(20_000)
            .setUserAgent("VLC/3.0.20 LibVLC/3.0.20");
        player = new ExoPlayer.Builder(context)
            .setMediaSourceFactory(new DefaultMediaSourceFactory(context).setDataSourceFactory(http))
            .build();
        player.addListener(new Player.Listener() {
            @Override
            public void onPlayerError(PlaybackException error) {
                Log.w(ShellApp.TAG, "preview failed: " + error.getErrorCodeName() + " " + streamUrl.replaceAll("//[^/]*/.*", "//…"));
                Toast.makeText(context.getApplicationContext(), "Preview: " + error.getErrorCodeName(), Toast.LENGTH_LONG).show();
            }
        });
        view.setPlayer(player);
        player.setMediaItem(MediaItem.fromUri(Uri.parse(streamUrl)));
        player.setPlayWhenReady(true);
        player.prepare();
        final ExoPlayer watched = player;
        final int w = width, h = height, l = left, t = top;
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

    /** Removes the picture and frees the decoder and the provider connection. */
    void stop() {
        if (report != null) handler.removeCallbacks(report);
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
