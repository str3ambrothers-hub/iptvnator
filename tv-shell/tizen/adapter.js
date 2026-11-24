/**
 * StreamBros on Samsung (Tizen): the platform adapter.
 *
 * tv.js (the remote-control layer shared with the Fire TV build) talks to its
 * host through `window.TvShell.postMessage(JSON.stringify([method, ...args]))`
 * and expects the host to call `window.__tvShell.back() / .menu() / .media()`
 * for the remote's special keys. On Android, MainActivity and TvShellBridge do
 * that. Here this script does, so tv.js runs unchanged. It must load before
 * tv.js (packaging puts it first) and after backend.js.
 *
 *   Return (10009)        -> __tvShell.back()  (tv.js exits on a second press)
 *   Tools (10135)         -> __tvShell.menu()
 *   Media keys            -> __tvShell.media('playpause' | 'play' | ...)
 *   exitApp               -> tizen.application.getCurrentApplication().exit()
 *   setKeepScreenOn       -> webapis.appcommon.setScreenSaver(...)
 *   toast / showExitHint  -> a small on-screen message
 *   openExternal, ...     -> "not available on Samsung TV" message
 *
 * Kill switches (localStorage):
 *   'tizen-keys' = 'off'           leave all remote keys to the browser
 *   'tizen-keep-switches' = 'on'   do not force the Android-only features off
 */
(function (win) {
    'use strict';

    var doc = win.document;
    var store = (function () {
        try { return win.localStorage; } catch (e) { return null; }
    })();
    function setting(name) {
        try { return store ? store.getItem(name) : null; } catch (e) { return null; }
    }

    // ------------------------------------------------------------ polyfills
    // Library code calls these; Samsung TVs before ~2023 ship Chromium < 100.
    // (Newer *syntax* cannot be polyfilled: see tv-shell/tizen/README.md.)
    if (win.AbortSignal && !win.AbortSignal.prototype.throwIfAborted) {
        win.AbortSignal.prototype.throwIfAborted = function () {
            if (this.aborted) {
                throw this.reason !== undefined ? this.reason : new win.DOMException('The operation was aborted.', 'AbortError');
            }
        };
    }
    if (!Array.prototype.at) {
        Object.defineProperty(Array.prototype, 'at', {
            configurable: true,
            writable: true,
            value: function (i) {
                i = Math.trunc(i) || 0;
                if (i < 0) i += this.length;
                return i < 0 || i >= this.length ? undefined : this[i];
            },
        });
    }
    if (!Object.hasOwn) {
        Object.hasOwn = function (obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); };
    }
    if (!String.prototype.replaceAll) {
        Object.defineProperty(String.prototype, 'replaceAll', {
            configurable: true,
            writable: true,
            value: function (search, replacement) {
                if (search instanceof RegExp) return this.replace(search, replacement);
                return this.split(String(search)).join(replacement);
            },
        });
    }

    // ------------------------------------------------------------ defaults
    // No native player, external player or poster cache on Samsung yet: keep
    // tv.js and the app on the page's own player and the original posters.
    if (store && setting('tizen-keep-switches') !== 'on') {
        try {
            store.setItem('native-live', 'off');
            store.setItem('native-movies', 'off');
            store.setItem('poster-cache', 'off');
        } catch (e) { /* storage full or blocked */ }
    }

    // --------------------------------------------------------------- backend
    if (win.StreamBrosTizenBackend) win.StreamBrosTizenBackend.install(win);

    // --------------------------------------------------------------- toast
    var toastEl = null;
    var toastTimer = 0;
    function toast(text) {
        if (!text || !doc.body) return;
        if (!toastEl) {
            toastEl = doc.createElement('div');
            toastEl.setAttribute('role', 'status');
            toastEl.style.cssText = 'position:fixed;left:50%;bottom:6%;transform:translateX(-50%);z-index:2147483647;' +
                'background:rgba(20,20,24,.92);color:#fff;font:500 22px/1.3 sans-serif;padding:14px 26px;' +
                'border-radius:10px;pointer-events:none;max-width:70%;text-align:center';
        }
        toastEl.textContent = String(text);
        if (!toastEl.isConnected) doc.body.appendChild(toastEl);
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () {
            if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
        }, 2500);
    }

    // --------------------------------------------------------------- bridge
    function tizenApi() { return win.tizen || null; }
    function webapis() { return win.webapis || null; }

    function exitApp() {
        try {
            tizenApi().application.getCurrentApplication().exit();
        } catch (e) {
            try { win.close(); } catch (err) { /* nothing else to try */ }
        }
    }

    function setKeepScreenOn(on) {
        try {
            var common = webapis().appcommon;
            var state = common.AppCommonScreenSaverState;
            common.setScreenSaver(on ? state.SCREEN_SAVER_OFF : state.SCREEN_SAVER_ON, function () {}, function () {});
        } catch (e) { /* no screensaver API on this model */ }
    }

    var handlers = {
        onReady: function () {},
        exitApp: exitApp,
        showExitHint: function () { toast('Press Back again to exit'); },
        toast: function (text) { toast(text); },
        setKeepScreenOn: function (on) { setKeepScreenOn(!!on); },
        // The TV shows its own keyboard when a text field gets focus.
        showKeyboard: function () {},
        hideKeyboard: function () {},
        openSettings: function () {},
        openExternal: function () { toast('Other player apps are not available on Samsung TV'); },
        onUrlCopied: function () { toast('Link copied'); },
        onSilentPlayback: function () { toast('This stream cannot play here yet'); },
        onPlaybackError: function () { toast('This stream cannot play on this TV'); },
    };

    win.TvShell = {
        platform: 'tizen',
        postMessage: function (message) {
            var parts;
            try { parts = JSON.parse(message); } catch (e) { return; }
            if (!Array.isArray(parts)) return;
            var handler = handlers[parts[0]];
            if (handler) {
                try { handler.apply(null, parts.slice(1)); } catch (e) { /* never break tv.js */ }
            }
        },
    };

    // ---------------------------------------------------------------- keys
    var KEYS = {
        10009: function (shell) { shell.back(); },          // Return / Back
        10135: function (shell) { shell.menu(); },          // Tools
        10252: function (shell) { shell.media('playpause'); },
        415: function (shell) { shell.media('play'); },
        19: function (shell) { shell.media('pause'); },
        413: function (shell) { shell.media('stop'); },
        412: function (shell) { shell.media('rewind'); },
        417: function (shell) { shell.media('fastforward'); },
    };
    var REGISTER = ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaRewind', 'MediaFastForward', 'Tools'];

    if (setting('tizen-keys') !== 'off') {
        try {
            var input = tizenApi() && tizenApi().tvinputdevice;
            if (input) {
                if (typeof input.registerKeyBatch === 'function') input.registerKeyBatch(REGISTER);
                else REGISTER.forEach(function (name) { try { input.registerKey(name); } catch (e) { /* model lacks key */ } });
            }
        } catch (e) { /* not a Samsung TV (browser test) */ }

        // Capture on window: runs before tv.js, which listens on document.
        win.addEventListener('keydown', function (event) {
            var action = KEYS[event.keyCode];
            var shell = win.__tvShell;
            if (!action || !shell) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            action(shell);
        }, true);
    }

    // The TV hides the app (Home, another app, standby): tv.js pauses media.
    doc.addEventListener('visibilitychange', function () {
        if (win.__tvShell && typeof win.__tvShell.setForeground === 'function') {
            win.__tvShell.setForeground(!doc.hidden);
        }
    });

    win.__streamBrosTizen = { toast: toast, handlers: handlers, keys: KEYS };
})(window);
