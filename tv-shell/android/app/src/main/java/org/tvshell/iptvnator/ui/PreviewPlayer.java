package org.tvshell.iptvnator.ui;

import android.content.Context;
import android.net.Uri;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;

import androidx.media3.common.MediaItem;
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
            view = new PlayerView(context);
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
        view.setPlayer(player);
        player.setMediaItem(MediaItem.fromUri(Uri.parse(streamUrl)));
        player.setPlayWhenReady(true);
        player.prepare();
    }

    /** Removes the picture and frees the decoder and the provider connection. */
    void stop() {
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
