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
import androidx.media3.extractor.DefaultExtractorsFactory;
import androidx.media3.extractor.mkv.MatroskaExtractor;
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
    private static final String EXTRA_LIVE = "live";

    /** Channel change asked for in the last live session (-1 previous, +1 next, 0 none); read once by MainActivity. */
    private static volatile int pendingZap;

    static int takeZap() {
        int zap = pendingZap;
        pendingZap = 0;
        return zap;
    }

    /** Provider live URLs have no /movie/ or /series/ part; those two are on demand. */
    static boolean looksLive(String url) {
        return url != null && !url.contains("/movie/") && !url.contains("/series/");
    }

    private boolean live;

    private ExoPlayer player;
    private PlayerView view;

    public static Intent intent(Context context, String url, String title) {
        Intent intent = new Intent(context, NativePlayerActivity.class);
        intent.putExtra(EXTRA_URL, url);
        intent.putExtra(EXTRA_TITLE, title == null ? "" : title);
        intent.putExtra(EXTRA_LIVE, looksLive(url));
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
        live = getIntent().getBooleanExtra(EXTRA_LIVE, false);
        pendingZap = 0;
        view = new PlayerView(this);
        view.setKeepScreenOn(true);
        view.setControllerShowTimeoutMs(4000);
        android.widget.FrameLayout root = new android.widget.FrameLayout(this);
        root.setBackgroundColor(android.graphics.Color.BLACK);
        root.addView(view, new android.widget.FrameLayout.LayoutParams(-1, -1));
        // A visible way out, shown together with the playback controls (touch, mouse or remote).
        final android.widget.Button back = new android.widget.Button(this);
        back.setText("\u2190  Back");
        back.setAllCaps(false);
        back.setTextColor(android.graphics.Color.WHITE);
        back.setTextSize(18);
        // Dark when idle; bright blue with a white edge when the remote, mouse or touch is on it.
        android.graphics.drawable.StateListDrawable backBg = new android.graphics.drawable.StateListDrawable();
        int[][] lit = {
            {android.R.attr.state_focused}, {android.R.attr.state_hovered}, {android.R.attr.state_pressed}};
        for (int[] state : lit) {
            android.graphics.drawable.GradientDrawable on = new android.graphics.drawable.GradientDrawable();
            on.setColor(0xFF2F6FED);
            on.setStroke(4, android.graphics.Color.WHITE);
            on.setCornerRadius(8);
            backBg.addState(state, on);
        }
        android.graphics.drawable.GradientDrawable off = new android.graphics.drawable.GradientDrawable();
        off.setColor(0xB3000000);
        off.setCornerRadius(8);
        backBg.addState(new int[0], off);
        back.setBackground(backBg);
        back.setFocusable(true);
        back.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { finish(); }
        });
        float density = getResources().getDisplayMetrics().density;
        android.widget.FrameLayout.LayoutParams backParams = new android.widget.FrameLayout.LayoutParams(-2, -2,
            android.view.Gravity.TOP | android.view.Gravity.START);
        backParams.setMargins((int) (24 * density), (int) (24 * density), 0, 0);
        root.addView(back, backParams);
        view.setControllerVisibilityListener(new PlayerView.ControllerVisibilityListener() {
            @Override public void onVisibilityChanged(int visibility) {
                back.setVisibility(visibility == View.VISIBLE ? View.VISIBLE : View.GONE);
            }
        });
        setContentView(root);
        if (live) {
            // A live channel has no timeline or seeking: keep only play/pause and the Back button.
            view.setShowFastForwardButton(false);
            view.setShowRewindButton(false);
            view.setShowNextButton(false);
            view.setShowPreviousButton(false);
            for (int id : new int[] {
                androidx.media3.ui.R.id.exo_progress, androidx.media3.ui.R.id.exo_position,
                androidx.media3.ui.R.id.exo_duration}) {
                View part = view.findViewById(id);
                if (part != null) part.setVisibility(View.GONE);
            }
        }
        view.setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);

        startPlayer(url, false, 0);
    }

    private boolean softwareDecoders;
    /** Reading the stream failed (a bad or refused response, not a codec): tries made again so far. */
    private int sourceRetries;
    private static final int MAX_SOURCE_RETRIES = 2;
    private static final long STALL_MS = 15_000;
    private static final int MAX_SERVER_SWITCHES = 3;
    private int serverSwitches;
    private final android.os.Handler stallHandler = new android.os.Handler(android.os.Looper.getMainLooper());

    /** Moves the stream to the other server of the login (main <-> backup) from where it stopped. */
    private boolean switchServer(String failedUrl) {
        if (isFinishing() || player == null || serverSwitches >= MAX_SERVER_SWITCHES) return false;
        String moved = ServerPair.switchTo(failedUrl);
        if (moved == null) return false;
        serverSwitches++;
        sourceRetries = 0;
        Toast.makeText(getApplicationContext(), "Switching to the other server…", Toast.LENGTH_SHORT).show();
        startPlayer(moved, softwareDecoders, live ? 0 : Math.max(0, player.getCurrentPosition()));
        return true;
    }
    private final android.os.Handler retryHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    /** The stream's formats as announced by the tracks: the player drops its own when a decoder fails. */
    private androidx.media3.common.Format seenVideo;
    private androidx.media3.common.Format seenAudio;

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
        // Second retry of a failed read: do not seek to the index at the end of an MKV file. Some
        // providers answer that ranged request with the wrong bytes, which breaks the parser.
        DefaultExtractorsFactory extractors = new DefaultExtractorsFactory();
        if (sourceRetries >= 2) extractors.setMatroskaExtractorFlags(MatroskaExtractor.FLAG_DISABLE_SEEK_FOR_CUES);
        ExoPlayer.Builder builder = new ExoPlayer.Builder(this, renderers)
            .setMediaSourceFactory(new DefaultMediaSourceFactory(this, extractors).setDataSourceFactory(http));
        androidx.media3.exoplayer.LoadControl buffer = PlayerBuffer.loadControl(live);
        if (buffer != null) builder.setLoadControl(buffer);
        player = builder.build();
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
                boolean sourceFailure = error.errorCode == PlaybackException.ERROR_CODE_IO_UNSPECIFIED
                    || error.errorCode == PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED
                    || error.errorCode == PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS
                    || error.errorCode == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED
                    || error.errorCode == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT;
                if (sourceFailure && sourceRetries < MAX_SOURCE_RETRIES && player != null) {
                    // A provider that limits connections or answers a seek wrongly often succeeds on
                    // a fresh connection a moment later.
                    sourceRetries++;
                    final long resumeAt = Math.max(0, player.getCurrentPosition());
                    final boolean software = softwareDecoders;
                    retryHandler.postDelayed(new Runnable() {
                        @Override public void run() {
                            if (!isFinishing()) startPlayer(url, software, resumeAt);
                        }
                    }, 2000);
                    return;
                }
                // Out of tries on this server: a login with a backup moves to the other server.
                if (switchServer(url)) return;
                showError(error);
            }

            @Override
            public void onPlaybackStateChanged(int state) {
                stallHandler.removeCallbacksAndMessages(null);
                if (state != Player.STATE_BUFFERING) return;
                // Frozen: still waiting for data after a while.
                stallHandler.postDelayed(new Runnable() {
                    @Override public void run() {
                        if (isFinishing() || player == null) return;
                        if (player.getPlaybackState() == Player.STATE_BUFFERING && player.getPlayWhenReady()) switchServer(url);
                    }
                }, STALL_MS);
            }

            @Override
            public void onTracksChanged(Tracks tracks) {
                boolean audioPresent = false;
                boolean audioPlayable = false;
                for (Tracks.Group group : tracks.getGroups()) {
                    if (group.length > 0 && group.getType() == C.TRACK_TYPE_VIDEO) seenVideo = group.getTrackFormat(0);
                    if (group.length > 0 && group.getType() == C.TRACK_TYPE_AUDIO && seenAudio == null) seenAudio = group.getTrackFormat(0);
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
        androidx.media3.common.Format video = seenVideo != null ? seenVideo : (player == null ? null : player.getVideoFormat());
        if (video != null) {
            detail.append("\n\nVideo: ").append(video.sampleMimeType)
                .append(" ").append(video.codecs)
                .append(" ").append(video.width).append("x").append(video.height)
                .append(" ").append(video.frameRate > 0 ? Math.round(video.frameRate) + "fps" : "")
                .append(video.colorInfo == null ? "" : " " + video.colorInfo);
        }
        androidx.media3.common.Format audio = seenAudio != null ? seenAudio : (player == null ? null : player.getAudioFormat());
        if (audio != null) detail.append("\nAudio: ").append(audio.sampleMimeType).append(" ").append(audio.channelCount).append("ch");
        if (softwareDecoders) detail.append("\n(software decoder tried)");
        if (sourceRetries > 0) detail.append("\n(reading the stream was retried ").append(sourceRetries).append(sourceRetries == 1 ? " time)" : " times)");
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
        if (live && view != null && event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) {
            int keyCode = event.getKeyCode();
            boolean controls = view.isControllerFullyVisible();
            // Channel keys always change channel; up/down do too while the controls are hidden.
            int zap = 0;
            if (keyCode == KeyEvent.KEYCODE_CHANNEL_UP) zap = 1;
            else if (keyCode == KeyEvent.KEYCODE_CHANNEL_DOWN) zap = -1;
            else if (!controls && keyCode == KeyEvent.KEYCODE_DPAD_DOWN) zap = 1;
            else if (!controls && keyCode == KeyEvent.KEYCODE_DPAD_UP) zap = -1;
            if (zap != 0) {
                pendingZap = zap;
                finish();
                return true;
            }
        }
        if (view != null && player != null && event.getAction() == KeyEvent.ACTION_DOWN) {
            switch (event.getKeyCode()) {
                case KeyEvent.KEYCODE_DPAD_LEFT:
                    if (!live && !view.isControllerFullyVisible()) {
                        player.seekBack();
                        return true;
                    }
                    break;
                case KeyEvent.KEYCODE_DPAD_RIGHT:
                    if (!live && !view.isControllerFullyVisible()) {
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
        retryHandler.removeCallbacksAndMessages(null);
        stallHandler.removeCallbacksAndMessages(null);
        if (player != null) {
            player.release();
            player = null;
        }
        super.onDestroy();
    }
}
