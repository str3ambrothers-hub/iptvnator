/**
 * StreamBros on Samsung (Tizen): the built-in player, on Samsung's AVPlay.
 *
 * The Samsung twin of NativePlayerActivity. tv.js hands a stream over exactly
 * as on Fire TV: it pauses the page's player and posts `onSilentPlayback(url,
 * title)`. The adapter routes that here. AVPlay draws the picture on a video
 * plane *under* the web page, so while it plays the page is hidden
 * (visibility only: Angular keeps its state) and its background made
 * transparent; only this overlay stays on screen.
 *
 * Remote, like the Fire TV player:
 *   Back / Stop             close (tv.js then puts the focus back on the channel)
 *   OK                      show the info bar; OK again: pause / play
 *   Play/Pause keys         pause / play
 *   Left / Right            movies: 10 s back / forward
 *   Rewind / Fast forward   movies: 30 s back / forward
 *   Up / Down (bar hidden)  live: previous / next channel of the guide
 *   Channel up / down       live: next / previous channel of the guide
 *
 * Load order: after adapter.js (it reads window.__streamBrosTizen), before tv.js.
 * Kill switch: localStorage['tizen-avplay'] = 'off' -> no player; the adapter
 * then keeps movies and live TV in the page's own player.
 */
(function (win) {
    'use strict';

    var doc = win.document;
    function setting(name) {
        try { return win.localStorage.getItem(name); } catch (e) { return null; }
    }

    var av = win.webapis && win.webapis.avplay;
    if (!av || setting('tizen-avplay') === 'off') {
        win.__streamBrosTizenPlayer = null;
        return;
    }

    var KEY = {
        ENTER: 13, LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40,
        RETURN: 10009, PLAYPAUSE: 10252, PLAY: 415, PAUSE: 19, STOP: 413,
        REWIND: 412, FASTFORWARD: 417, CHANNEL_UP: 427, CHANNEL_DOWN: 428,
    };
    var SEEK_STEP = 10000;
    var SEEK_JUMP = 30000;
    var BAR_MS = 4000;
    var OPEN_TIMEOUT_MS = 30000;
    var OPEN_CLASS = 'sb-avplay-open';
    var FAIL_TEXT = 'This stream cannot play on this TV. Press Back.';

    /** Same rule as NativePlayerActivity.looksLive: Xtream movies and episodes live under /movie/ and /series/. */
    function looksLive(url) {
        return !/\/(movie|series)\//.test(String(url || ''));
    }

    function pad(n) { return (n < 10 ? '0' : '') + n; }
    function clock(ms) {
        var s = Math.max(0, Math.floor((ms || 0) / 1000));
        var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
        return (h ? h + ':' + pad(m) : String(m)) + ':' + pad(s % 60);
    }

    // ---------------------------------------------------------------- view
    var ui = null;
    function el(tag, css, parent) {
        var node = doc.createElement(tag);
        if (css) node.style.cssText = css;
        if (parent) parent.appendChild(node);
        return node;
    }
    function buildUi() {
        if (ui) return ui;
        var style = el('style');
        style.textContent =
            'html.' + OPEN_CLASS + ',html.' + OPEN_CLASS + ' body{background:transparent!important}' +
            'html.' + OPEN_CLASS + ' body>*:not(#sb-avplay){visibility:hidden!important}';
        (doc.head || doc.body).appendChild(style);

        var root = el('div', 'position:fixed;left:0;top:0;width:100%;height:100%;z-index:2147483647;' +
            'background:transparent;color:#fff;font:500 22px/1.3 sans-serif;display:none');
        root.id = 'sb-avplay';
        var video = el('object', 'position:absolute;left:0;top:0;width:100%;height:100%', root);
        video.setAttribute('type', 'application/avplayer');
        var status = el('div', 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);' +
            'background:rgba(0,0,0,.65);padding:14px 26px;border-radius:10px;max-width:70%;text-align:center', root);
        var bar = el('div', 'position:absolute;left:0;right:0;bottom:0;padding:24px 48px 30px;' +
            'background:linear-gradient(transparent,rgba(0,0,0,.85))', root);
        var title = el('div', 'font-size:26px;margin-bottom:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', bar);
        var track = el('div', 'height:6px;background:rgba(255,255,255,.25);border-radius:3px;overflow:hidden', bar);
        var fill = el('div', 'height:100%;width:0;background:#7fdbca', track);
        var time = el('div', 'margin-top:10px;font-size:20px;opacity:.85', bar);
        ui = { root: root, status: status, bar: bar, title: title, track: track, fill: fill, time: time };
        return ui;
    }

    var s = null;        // the open stream, or null
    var openId = 0;      // callbacks of an older stream are ignored
    var barTimer = 0;
    var openTimer = 0;

    function render() {
        if (!s || !ui) return;
        ui.title.textContent = s.title || '';
        ui.status.textContent = s.error ? FAIL_TEXT : s.loading ? 'Loading…' :
            s.buffering ? 'Buffering' + (s.buffered ? ' ' + s.buffered + '%' : '…') : s.paused ? 'Paused' : '';
        ui.status.style.display = ui.status.textContent ? '' : 'none';
        var long = !s.live && s.duration > 0;
        ui.track.style.display = long ? '' : 'none';
        ui.fill.style.width = long ? Math.min(100, (s.position / s.duration) * 100) + '%' : '0';
        ui.time.textContent = s.live ? 'LIVE' : long ? clock(s.position) + ' / ' + clock(s.duration) : clock(s.position);
        ui.bar.style.display = s.bar ? '' : 'none';
    }
    function showBar() {
        if (!s) return;
        s.bar = true;
        clearTimeout(barTimer);
        barTimer = setTimeout(function () {
            if (!s || s.paused || s.error) return;
            s.bar = false;
            render();
        }, BAR_MS);
        render();
    }

    // ------------------------------------------------------------- player
    function guard(id, fn) {
        return function () { if (s && id === openId) fn.apply(null, arguments); };
    }
    function fail() {
        if (!s) return;
        clearTimeout(openTimer);
        s.error = true;
        s.loading = s.buffering = false;
        s.bar = true;
        try { av.stop(); } catch (e) { /* already stopped */ }
        render();
    }
    function release() {
        clearTimeout(openTimer);
        clearTimeout(barTimer);
        openId += 1;
        try { av.stop(); } catch (e) { /* not playing */ }
        try { av.close(); } catch (e) { /* not open */ }
        s = null;
    }

    function open(url, title) {
        if (!url) return;
        if (s) release();
        var id = ++openId;
        s = { url: String(url), title: title || '', live: looksLive(url), loading: true, buffering: false,
            buffered: 0, paused: false, error: false, position: 0, duration: 0, bar: true, seek: 0, seeking: false };
        buildUi();
        if (!ui.root.isConnected) doc.body.appendChild(ui.root);
        ui.root.style.display = '';
        doc.documentElement.classList.add(OPEN_CLASS);
        // The page is now behind the player, as on Fire TV when the player app opens.
        if (win.__tvShell && typeof win.__tvShell.setForeground === 'function') win.__tvShell.setForeground(false);
        render();

        openTimer = setTimeout(guard(id, fail), OPEN_TIMEOUT_MS);
        try {
            av.open(s.url);
            av.setListener({
                onbufferingstart: guard(id, function () { s.buffering = true; s.buffered = 0; render(); }),
                onbufferingprogress: guard(id, function (p) { s.buffered = p; render(); }),
                onbufferingcomplete: guard(id, function () { s.buffering = false; render(); }),
                oncurrentplaytime: guard(id, function (ms) { if (!s.seeking) s.position = ms; if (s.bar) render(); }),
                onstreamcompleted: guard(id, function () { close(0); }),
                onerror: guard(id, fail),
                onevent: function () {},
            });
            av.setDisplayRect(0, 0, 1920, 1080); // AVPlay always counts the screen as 1920x1080
            try { av.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX'); } catch (e) { /* older firmware */ }
            av.prepareAsync(guard(id, function () {
                clearTimeout(openTimer);
                var duration = 0;
                try { duration = av.getDuration(); } catch (e) { /* live */ }
                s.duration = duration > 0 ? duration : 0;
                if (!s.duration) s.live = true;
                s.loading = false;
                av.play();
                showBar();
            }), guard(id, fail));
        } catch (e) {
            fail();
        }
    }

    function close(zap) {
        if (!s) return;
        release();
        if (ui) ui.root.style.display = 'none';
        doc.documentElement.classList.remove(OPEN_CLASS);
        // Same order as MainActivity when the player activity finishes.
        if (typeof win.__tvNativeClosed === 'function') win.__tvNativeClosed(zap || 0);
        if (!doc.hidden && win.__tvShell && typeof win.__tvShell.setForeground === 'function') win.__tvShell.setForeground(true);
    }

    function setPaused(paused) {
        if (!s || s.error || s.loading || s.paused === paused) return;
        try {
            if (paused) av.pause(); else av.play();
            s.paused = paused;
        } catch (e) { /* wrong state: ignore the key */ }
        showBar();
    }

    /** Seek presses add up while AVPlay is still seeking; it gets one jump at a time. */
    function seek(ms) {
        if (!s || s.live || s.error || s.loading) return;
        s.seek += ms;
        var target = Math.max(0, Math.min(s.position + ms, s.duration ? s.duration - 1000 : Infinity));
        s.position = target;
        showBar();
        if (!s.seeking) nextSeek(openId);
    }
    function nextSeek(id) {
        if (!s || id !== openId || !s.seek) { if (s) s.seeking = false; return; }
        var step = s.seek;
        s.seek = 0;
        s.seeking = true;
        var done = function () { if (s && id === openId) { s.seeking = false; nextSeek(id); } };
        try {
            if (step > 0) av.jumpForward(step, done, done);
            else av.jumpBackward(-step, done, done);
        } catch (e) {
            done();
        }
    }

    /** Every key while the player is open is the player's: nothing reaches the hidden page. */
    function handleKey(event) {
        if (!s) return false;
        var code = event.keyCode;
        var first = !event.repeat;
        if (code === KEY.RETURN || code === KEY.STOP) {
            if (first) close(0);
            return true;
        }
        if (s.error) return true;
        switch (code) {
            case KEY.CHANNEL_UP: if (s.live && first) close(1); break;
            case KEY.CHANNEL_DOWN: if (s.live && first) close(-1); break;
            case KEY.UP:
            case KEY.DOWN:
                if (s.live && !s.bar && first) close(code === KEY.DOWN ? 1 : -1);
                else showBar();
                break;
            case KEY.LEFT: seek(-SEEK_STEP); break;
            case KEY.RIGHT: seek(SEEK_STEP); break;
            case KEY.REWIND: seek(-SEEK_JUMP); break;
            case KEY.FASTFORWARD: seek(SEEK_JUMP); break;
            case KEY.ENTER:
                if (!first) break;
                if (!s.bar) showBar(); else setPaused(!s.paused);
                break;
            case KEY.PLAYPAUSE: if (first) setPaused(!s.paused); break;
            case KEY.PLAY: setPaused(false); break;
            case KEY.PAUSE: setPaused(true); break;
            default: break;
        }
        return true;
    }

    win.addEventListener('keydown', function (event) {
        if (!s || !handleKey(event)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
    }, true);

    // Home, another app or standby: AVPlay must give the decoder back, then take it again.
    doc.addEventListener('visibilitychange', function () {
        if (!s) return;
        try {
            if (doc.hidden) av.suspend();
            else av.restore();
        } catch (e) { /* firmware without suspend/restore */ }
    });

    var shared = win.__streamBrosTizen;
    if (shared && shared.handlers) {
        shared.handlers.onSilentPlayback = function (url, title) { open(url, title); };
    }

    win.__streamBrosTizenPlayer = {
        open: open,
        close: close,
        isOpen: function () { return !!s; },
        handleKey: handleKey,
        state: function () { return s; },
    };
})(window);
