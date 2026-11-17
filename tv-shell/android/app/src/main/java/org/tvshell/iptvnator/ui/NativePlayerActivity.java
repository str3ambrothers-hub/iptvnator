package org.tvshell.iptvnator.ui;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.List;

import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.Tracks;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.mediacodec.MediaCodecInfo;
import androidx.media3.exoplayer.mediacodec.MediaCodecSelector;
import androidx.media3.exoplayer.mediacodec.MediaCodecUtil;
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

        startPlayer(url, false, 0);
    }

    private boolean softwareDecoders;

    /**
     * Builds the player. First with the device's preferred (usually hardware) decoders; when one of
     * them breaks while playing (some phones' HEVC chips do), once more with the platform's own
     * software decoders first (Android's built-in codecs, not FFmpeg), from the same position.
     */
    private void startPlayer(final String url, boolean software, long positionMs) {
        softwareDecoders = software;
        if (player != null) {
            player.release();
            player = null;
        }
        DefaultRenderersFactory renderers = new DefaultRenderersFactory(this)
            .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_OFF)
            .setEnableDecoderFallback(true);
        if (software) renderers.setMediaCodecSelector(softwareFirstSelector());
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
                boolean decoderFailure = error.errorCode == PlaybackException.ERROR_CODE_DECODING_FAILED
                    || error.errorCode == PlaybackException.ERROR_CODE_DECODER_INIT_FAILED
                    || error.errorCode == PlaybackException.ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES;
                if (decoderFailure && !softwareDecoders && player != null) {
                    startPlayer(url, true, Math.max(0, player.getCurrentPosition()));
                    return;
                }
                showError(error);
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
        if (positionMs > 0) player.seekTo(positionMs);
        player.setPlayWhenReady(true);
        player.prepare();
    }

    /** The device's decoders with the software ones (no dedicated chip) tried first. */
    private static MediaCodecSelector softwareFirstSelector() {
        return new MediaCodecSelector() {
            @Override
            public List<MediaCodecInfo> getDecoderInfos(String mimeType, boolean requiresSecureDecoder,
                                                        boolean requiresTunnelingDecoder)
                throws MediaCodecUtil.DecoderQueryException {
                List<MediaCodecInfo> all = new ArrayList<MediaCodecInfo>(
                    MediaCodecUtil.getDecoderInfos(mimeType, requiresSecureDecoder, requiresTunnelingDecoder));
                List<MediaCodecInfo> ordered = new ArrayList<MediaCodecInfo>(all.size());
                for (MediaCodecInfo info : all) if (!info.hardwareAccelerated) ordered.add(info);
                for (MediaCodecInfo info : all) if (info.hardwareAccelerated) ordered.add(info);
                return ordered;
            }
        };
    }

    /** The reason on screen until dismissed (a toast is cut to one line on many devices). */
    private void showError(PlaybackException error) {
        if (isFinishing()) return;
        StringBuilder detail = new StringBuilder(error.getErrorCodeName());
        Throwable cause = error.getCause();
        int depth = 0;
        while (cause != null && depth++ < 3) {
            detail.append("\n").append(cause.getClass().getSimpleName());
            if (cause.getMessage() != null) detail.append(": ").append(cause.getMessage());
            cause = cause.getCause();
        }
        androidx.media3.common.Format video = player == null ? null : player.getVideoFormat();
        if (video != null) {
            detail.append("\n\nVideo: ").append(video.sampleMimeType)
                .append(" ").append(video.codecs)
                .append(" ").append(video.width).append("x").append(video.height)
                .append(" ").append(video.frameRate > 0 ? Math.round(video.frameRate) + "fps" : "")
                .append(video.colorInfo == null ? "" : " " + video.colorInfo);
        }
        androidx.media3.common.Format audio = player == null ? null : player.getAudioFormat();
        if (audio != null) detail.append("\nAudio: ").append(audio.sampleMimeType).append(" ").append(audio.channelCount).append("ch");
        if (softwareDecoders) detail.append("\n(software decoder tried)");
        if (detail.length() > 900) detail.setLength(900);
        final String url = getIntent().getStringExtra(EXTRA_URL);
        final String title = getIntent().getStringExtra(EXTRA_TITLE);
        new android.app.AlertDialog.Builder(this)
            .setTitle(R.string.native_player_error)
            .setMessage(detail.toString())
            .setPositiveButton(R.string.native_player_try_other, new android.content.DialogInterface.OnClickListener() {
                @Override
                public void onClick(android.content.DialogInterface dialog, int which) {
                    ExternalPlayer.open(NativePlayerActivity.this, url, title, ExternalPlayer.CHOOSER);
                    finish();
                }
            })
            .setNegativeButton(R.string.external_prompt_cancel, new android.content.DialogInterface.OnClickListener() {
                @Override
                public void onClick(android.content.DialogInterface dialog, int which) {
                    finish();
                }
            })
            .setOnCancelListener(new android.content.DialogInterface.OnCancelListener() {
                @Override
                public void onCancel(android.content.DialogInterface dialog) {
                    finish();
                }
            })
            .show();
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
