/**
 * StreamBros on Samsung (Tizen): the embedded backend, inside the page.
 *
 * On Android the PWA talks to a Java server on loopback (TvShellServer.java)
 * that calls the provider for it. A Tizen web app has no such server, but a
 * packaged app whose config.xml has <access origin="*"> may call any site
 * directly. So this script answers the same `/api/*` contract in the page:
 * it intercepts fetch() and XMLHttpRequest calls to `/api/...` and calls the
 * provider itself. Routes (same shapes as tv-shell/devserver/server.mjs):
 *
 *   GET  /api/health                    -> { status: 'ok' }
 *   POST /api/provider-targets  { url } -> { targetId }
 *   POST /api/connectivity-guard/reset  -> { reset: false }
 *   GET  /api/xtream?targetId=&...      -> { action, payload } | error body
 *   GET  /api/stalker, /api/parse, /api/parse-xml, /api/image -> 501 (not yet)
 *
 * Xtream errors keep the web backend's body shape ({ message, status }, HTTP
 * 200) so the backup-server failover sees 502/503/504 exactly as on Android.
 *
 * Kill switch: localStorage['tizen-backend'] = 'off' (then nothing answers
 * /api and the app cannot reach providers: for diagnosis only).
 *
 * Plain ES2017, no modules: older Samsung TVs run old Chromium.
 */
(function (root) {
    'use strict';

    var API_PATH = /^\/api(?:\/|$)/;
    var XTREAM_ENDPOINT = /\/(?:get|player_api|panel_api)\.php$/i;
    var NOT_YET = { '/stalker': 1, '/parse': 1, '/parse-xml': 1, '/image': 1 };

    function normalizeXtreamServerUrl(value) {
        var trimmed = String(value || '').trim();
        if (!trimmed) throw new Error('Xtream URL is required');
        var url = new URL(trimmed);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            throw new Error('Only http and https Xtream URLs are supported');
        }
        if (url.username || url.password) throw new Error('URL credentials are not supported');
        var path = url.pathname.replace(/\/+$/, '').replace(XTREAM_ENDPOINT, '');
        return url.origin + path;
    }

    /** Stable id for a provider URL (FNV-1a, 32 bit, plus length). */
    function targetIdFor(url) {
        var hash = 0x811c9dc5;
        for (var i = 0; i < url.length; i++) {
            hash ^= url.charCodeAt(i);
            hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
        }
        return 't' + hash.toString(16) + url.length.toString(16);
    }

    function providerError(error) {
        if (error && typeof error.status === 'number') {
            return { message: error.statusText || 'Bad Gateway', status: error.status };
        }
        var code = error && typeof error.code === 'string' ? error.code : undefined;
        var body = { message: code ? 'Bad Gateway (' + code + ')' : 'Bad Gateway', status: 502 };
        if (code) body.code = code;
        return body;
    }

    function connectionFailure(error, url) {
        if (error && typeof error.status === 'number' && error.status >= 100 && error.status <= 599) {
            return { kind: 'http', status: error.status, canTryHttp: false };
        }
        var code = error && typeof error.code === 'string' ? error.code : '';
        if (!code) return { kind: 'unknown', canTryHttp: false };
        // A browser cannot tell "refused" from a TLS failure: offer plain http
        // only when the address was https and nothing answered at all.
        return { kind: 'connection', canTryHttp: code === 'ECONNECTION' && /^https:/i.test(url) };
    }

    function parsePayload(text) {
        try {
            return JSON.parse(String(text).replace(/^﻿/, ''));
        } catch (e) {
            return text;
        }
    }

    /**
     * The route handler, independent of the browser (tests drive it directly).
     * options.request(url, { timeoutMs }) -> Promise<string>; rejects with
     * { status, statusText } on an HTTP error or { code } when nothing answered.
     */
    function create(options) {
        var request = options.request;
        var targets = {};

        function reply(status, body) {
            return { status: status, body: body };
        }

        function target(query) {
            var id = (query.get('targetId') || '').trim();
            if (!id) return reply(400, { message: 'Missing targetId', status: 400 });
            if (!Object.prototype.hasOwnProperty.call(targets, id)) {
                return reply(404, { message: 'Provider target not found', status: 404 });
            }
            return targets[id];
        }

        function xtream(query) {
            var url = target(query);
            if (typeof url !== 'string') return Promise.resolve(url);
            var action = (query.get('action') || '').trim() || undefined;
            var connectionTest = query.get('connectionTest') === 'true';
            var apiUrl;
            try {
                apiUrl = new URL(normalizeXtreamServerUrl(url).replace(/\/+$/, '') + '/player_api.php');
            } catch (e) {
                return Promise.resolve(reply(200, { message: e.message, status: 400 }));
            }
            query.forEach(function (value, key) {
                if (key === 'targetId' || key === 'connectionTest' || key === 'userAgent') return;
                var v = String(value).trim();
                if (v) apiUrl.searchParams.set(key, v);
            });
            return request(apiUrl.href, { timeoutMs: 30000 }).then(
                function (text) {
                    return reply(200, { action: action, payload: parsePayload(text) });
                },
                function (error) {
                    if (connectionTest) return reply(200, { connectionFailure: connectionFailure(error, apiUrl.href) });
                    return reply(200, providerError(error));
                }
            );
        }

        function handle(method, href, bodyText) {
            var url = new URL(href);
            var path = url.pathname.replace(/^\/api/, '') || '/';
            method = String(method || 'GET').toUpperCase();
            if (method === 'OPTIONS') return Promise.resolve(reply(200, {}));
            if (method === 'GET' && (path === '/' || path === '/health')) {
                return Promise.resolve(reply(200, { status: 'ok', service: 'streambros-tizen-backend' }));
            }
            if (method === 'POST' && path === '/provider-targets') {
                var body = {};
                try {
                    body = JSON.parse(bodyText || '{}') || {};
                } catch (e) {
                    body = {};
                }
                var raw = typeof body.url === 'string' ? body.url.trim() : '';
                if (!raw) return Promise.resolve(reply(400, { message: 'Missing url', status: 400 }));
                var parsed;
                try {
                    parsed = new URL(raw);
                } catch (e) {
                    return Promise.resolve(reply(400, { message: 'Provider URL is not valid', status: 400 }));
                }
                if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                    return Promise.resolve(reply(400, { message: 'Only http and https provider URLs are supported', status: 400 }));
                }
                var id = targetIdFor(parsed.href);
                targets[id] = parsed.href;
                return Promise.resolve(reply(200, { targetId: id }));
            }
            if (method === 'POST' && path === '/connectivity-guard/reset') {
                return Promise.resolve(reply(200, { reset: false }));
            }
            if (method === 'GET' && path === '/xtream') return xtream(url.searchParams);
            if (NOT_YET[path]) {
                return Promise.resolve(reply(501, { message: 'Not available on Samsung TV yet', status: 501 }));
            }
            return Promise.resolve(reply(404, { message: 'Not found', status: 404 }));
        }

        return { handle: handle };
    }

    // ------------------------------------------------------------- browser

    /** A direct GET with the page's own XMLHttpRequest (before it is patched). */
    function xhrRequest(OriginalXhr) {
        return function (url, opts) {
            return new Promise(function (resolve, reject) {
                var xhr = new OriginalXhr();
                xhr.open('GET', url, true);
                xhr.timeout = (opts && opts.timeoutMs) || 30000;
                xhr.onload = function () {
                    if (xhr.status === 0) return reject({ code: 'ECONNECTION' });
                    if (xhr.status < 200 || xhr.status >= 300) {
                        return reject({ status: xhr.status, statusText: xhr.statusText || 'HTTP ' + xhr.status });
                    }
                    resolve(xhr.responseText);
                };
                xhr.onerror = function () { reject({ code: 'ECONNECTION' }); };
                xhr.ontimeout = function () { reject({ code: 'ETIMEDOUT' }); };
                xhr.send();
            });
        };
    }

    function install(win, opts) {
        opts = opts || {};
        if (win.__streamBrosTizenBackend) return win.__streamBrosTizenBackend;
        try {
            if (win.localStorage && win.localStorage.getItem('tizen-backend') === 'off') return null;
        } catch (e) { /* default on */ }

        var NativeXhr = win.XMLHttpRequest;
        var proto = NativeXhr.prototype;
        var origOpen = proto.open;
        var origSend = proto.send;
        var origSetHeader = proto.setRequestHeader;
        var origAbort = proto.abort;
        var origAllHeaders = proto.getAllResponseHeaders;
        var origHeader = proto.getResponseHeader;
        var backend = create({ request: opts.request || xhrRequest(NativeXhr) });

        function apiHref(url) {
            if (url == null) return null;
            var resolved;
            try {
                resolved = new URL(String(url), win.location.href);
            } catch (e) {
                return null;
            }
            var local = resolved.protocol === 'file:' || resolved.origin === win.location.origin;
            return local && API_PATH.test(resolved.pathname) ? resolved.href : null;
        }

        // ---- fetch
        var origFetch = win.fetch;
        if (typeof origFetch === 'function') {
            win.fetch = function (input, init) {
                var isRequest = input && typeof input === 'object' && typeof input.url === 'string';
                var href = apiHref(isRequest ? input.url : input);
                if (!href) return origFetch.apply(this, arguments);
                var method = (init && init.method) || (isRequest && input.method) || 'GET';
                var signal = (init && init.signal) || (isRequest && input.signal) || null;
                if (signal && signal.aborted) return Promise.reject(abortError(win));
                var bodyPromise = init && init.body != null
                    ? Promise.resolve(typeof init.body === 'string' ? init.body : String(init.body))
                    : isRequest && typeof input.text === 'function' && method.toUpperCase() !== 'GET'
                        ? input.text()
                        : Promise.resolve('');
                var work = bodyPromise.then(function (body) {
                    return backend.handle(method, href, body);
                }).then(function (result) {
                    return new win.Response(JSON.stringify(result.body), {
                        status: result.status,
                        headers: { 'Content-Type': 'application/json; charset=utf-8' },
                    });
                });
                if (!signal) return work;
                return new Promise(function (resolve, reject) {
                    signal.addEventListener('abort', function () { reject(abortError(win)); });
                    work.then(resolve, reject);
                });
            };
        }

        // ---- XMLHttpRequest (Angular's HttpClient here uses withXhr())
        proto.open = function (method, url) {
            var href = apiHref(url);
            if (!href) {
                this.__sb = null;
                return origOpen.apply(this, arguments);
            }
            this.__sb = { method: method, href: href, aborted: false, headers: '' };
            define(this, 'readyState', 1);
            this.dispatchEvent(new win.Event('readystatechange'));
        };
        proto.setRequestHeader = function () {
            if (this.__sb) return undefined;
            return origSetHeader.apply(this, arguments);
        };
        proto.getAllResponseHeaders = function () {
            if (this.__sb) return this.__sb.headers;
            return origAllHeaders.apply(this, arguments);
        };
        proto.getResponseHeader = function (name) {
            if (this.__sb) {
                return String(name).toLowerCase() === 'content-type' && this.__sb.headers
                    ? 'application/json; charset=utf-8'
                    : null;
            }
            return origHeader.apply(this, arguments);
        };
        proto.abort = function () {
            var sb = this.__sb;
            if (!sb) return origAbort.apply(this, arguments);
            if (sb.aborted || sb.done) return undefined;
            sb.aborted = true;
            define(this, 'readyState', 4);
            fire(this, win, ['readystatechange', 'abort', 'loadend']);
            return undefined;
        };
        proto.send = function (body) {
            var sb = this.__sb;
            if (!sb) return origSend.apply(this, arguments);
            var xhr = this;
            fire(xhr, win, ['loadstart']);
            backend.handle(sb.method, sb.href, typeof body === 'string' ? body : '').then(function (result) {
                if (sb.aborted) return;
                sb.done = true;
                var text = JSON.stringify(result.body);
                var type = xhr.responseType;
                sb.headers = 'content-type: application/json; charset=utf-8\r\n';
                define(xhr, 'status', result.status);
                define(xhr, 'statusText', result.status === 200 ? 'OK' : String(result.status));
                define(xhr, 'responseURL', sb.href);
                define(xhr, 'responseText', type === '' || type === 'text' ? text : '');
                define(xhr, 'response', type === 'json' ? result.body : text);
                define(xhr, 'readyState', 4);
                fire(xhr, win, ['readystatechange', 'load', 'loadend']);
            }, function () {
                if (sb.aborted) return;
                sb.done = true;
                define(xhr, 'status', 0);
                define(xhr, 'readyState', 4);
                fire(xhr, win, ['readystatechange', 'error', 'loadend']);
            });
            return undefined;
        };

        win.__streamBrosTizenBackend = backend;
        return backend;
    }

    function define(obj, name, value) {
        Object.defineProperty(obj, name, { value: value, configurable: true, writable: true });
    }

    function fire(target, win, names) {
        names.forEach(function (name) {
            var Ev = name === 'readystatechange' ? win.Event : (win.ProgressEvent || win.Event);
            target.dispatchEvent(new Ev(name));
        });
    }

    function abortError(win) {
        try {
            return new win.DOMException('The operation was aborted.', 'AbortError');
        } catch (e) {
            var error = new Error('The operation was aborted.');
            error.name = 'AbortError';
            return error;
        }
    }

    root.StreamBrosTizenBackend = {
        create: create,
        install: install,
        normalizeXtreamServerUrl: normalizeXtreamServerUrl,
        targetIdFor: targetIdFor,
    };
})(typeof window !== 'undefined' ? window : globalThis);
