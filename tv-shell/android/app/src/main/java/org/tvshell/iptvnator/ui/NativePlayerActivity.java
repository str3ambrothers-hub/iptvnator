package org.tvshell.iptvnator.ui;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.Toast;

import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.Tracks;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.ui.PlayerView;

import org.tvshell.iptvnator.R;

/**
 * The built-in video player: Media3 ExoPlayer with the device's own decoders only (no software
 * FFmpeg decoders, which are GPL). Handles the formats the WebView cannot (AC3/E-AC3 audio, MKV,
 * raw MPEG-TS) as far as the hardware allows. Remote: OK/Enter shows the controls, Left/Right
 * seek, Back closes.
 */
public class NativePlayerActivity extends android.app.Activity {

    private static final String EXTRA_URL = "url";
    private static final String EXTRA_TITLE = "title";

    private ExoPlayer player;
    private PlayerView view;

    public static Intent intent(Context context, String url, String title) {
        Intent intent = new Intent(context, NativePlayerActivity.class);
        intent.putExtra(EXTRA_URL, url);
        intent.putExtra(EXTRA_TITLE, title == null ? "" : title);
        return intent;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        String url = getIntent().getStringExtra(EXTRA_URL);
        if (url == null || url.isEmpty()) {
            finish();
            return;
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        view = new PlayerView(this);
        view.setKeepScreenOn(true);
        view.setControllerShowTimeoutMs(4000);
        setContentView(view);
        view.setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);

        // Device decoders only; fall back to another hardware decoder when the first fails.
        DefaultRenderersFactory renderers = new DefaultRenderersFactory(this)
            .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_OFF)
            .setEnableDecoderFallback(true);
        // Providers often redirect http to https (or back) and some refuse unknown clients.
        DefaultHttpDataSource.Factory http = new DefaultHttpDataSource.Factory()
            .setAllowCrossProtocolRedirects(true)
            .setConnectTimeoutMs(15_000)
            .setReadTimeoutMs(20_000)
            .setUserAgent("VLC/3.0.20 LibVLC/3.0.20");
        player = new ExoPlayer.Builder(this, renderers)
            .setMediaSourceFactory(new DefaultMediaSourceFactory(this).setDataSourceFactory(http))
            .build();
        player.addListener(new Player.Listener() {
            @Override
            public void onPlayerError(PlaybackException error) {
                Throwable cause = error.getCause();
                String detail = error.getErrorCodeName() + (cause == null || cause.getMessage() == null ? "" : ": " + cause.getMessage());
                if (detail.length() > 160) detail = detail.substring(0, 160);
                Toast.makeText(getApplicationContext(), getString(R.string.native_player_error) + "\n" + detail, Toast.LENGTH_LONG).show();
                finish();
            }

            @Override
            public void onTracksChanged(Tracks tracks) {
                boolean audioPresent = false;
                boolean audioPlayable = false;
                for (Tracks.Group group : tracks.getGroups()) {
                    if (group.getType() != C.TRACK_TYPE_AUDIO) continue;
                    audioPresent = true;
                    if (group.isSupported()) audioPlayable = true;
                }
                if (audioPresent && !audioPlayable) {
                    Toast.makeText(getApplicationContext(), R.string.native_player_no_audio, Toast.LENGTH_LONG).show();
                }
            }
        });
        view.setPlayer(player);
        player.setMediaItem(MediaItem.fromUri(Uri.parse(url)));
        player.setPlayWhenReady(true);
        player.prepare();
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (view != null && player != null && event.getAction() == KeyEvent.ACTION_DOWN) {
            switch (event.getKeyCode()) {
                case KeyEvent.KEYCODE_DPAD_LEFT:
                    if (!view.isControllerFullyVisible()) {
                        player.seekBack();
                        return true;
                    }
                    break;
                case KeyEvent.KEYCODE_DPAD_RIGHT:
                    if (!view.isControllerFullyVisible()) {
                        player.seekForward();
                        return true;
                    }
                    break;
                case KeyEvent.KEYCODE_DPAD_CENTER:
                case KeyEvent.KEYCODE_ENTER:
                    if (!view.isControllerFullyVisible()) {
                        view.showController();
                        return true;
                    }
                    break;
                default:
                    break;
            }
        }
        return super.dispatchKeyEvent(event);
    }

    @Override
    protected void onStop() {
        super.onStop();
        if (player != null) player.pause();
    }

    @Override
    protected void onDestroy() {
        if (player != null) {
            player.release();
            player = null;
        }
        super.onDestroy();
    }
}
