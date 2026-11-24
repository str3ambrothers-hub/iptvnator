// Samsung (Tizen) build: in-page backend, platform adapter and packaging.
// Plain `node --test`, no browser and no dependencies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { packageTizen, transformIndex } from '../tizen/package.mjs';

const TIZEN = join(dirname(fileURLToPath(import.meta.url)), '..', 'tizen');
const BACKEND_SRC = readFileSync(join(TIZEN, 'backend.js'), 'utf8');
const ADAPTER_SRC = readFileSync(join(TIZEN, 'adapter.js'), 'utf8');
const PAGE = 'file:///opt/usr/apps/StreamBros/res/wgt/index.html';
// Objects made inside the vm sandbox have its prototypes: compare as plain data.
const plain = (value) => JSON.parse(JSON.stringify(value));

function memoryStorage(initial = {}) {
    const data = { ...initial };
    return {
        getItem: (k) => (k in data ? data[k] : null),
        setItem: (k, v) => { data[k] = String(v); },
        removeItem: (k) => { delete data[k]; },
        data,
    };
}

class FakeXhr extends EventTarget {
    static sent = [];
    constructor() { super(); this.responseType = ''; this.readyState = 0; }
    open(method, url) { this.method = method; this.url = url; this.readyState = 1; }
    setRequestHeader() {}
    send() { FakeXhr.sent.push(this.url); }
    abort() {}
    getAllResponseHeaders() { return ''; }
    getResponseHeader() { return null; }
}

function makeWindow({ storage = memoryStorage(), request } = {}) {
    const win = new EventTarget();
    Object.assign(win, {
        location: { href: PAGE, origin: 'null' },
        localStorage: storage,
        XMLHttpRequest: class extends FakeXhr {},
        fetch: async (url) => ({ passedThrough: String(url) }),
        Response, Event, DOMException, URL, URLSearchParams,
        AbortSignal, Array, Object, String, JSON, Math, Promise,
        setTimeout, clearTimeout, console,
    });
    win.window = win;
    win.document = Object.assign(new EventTarget(), {
        hidden: false,
        body: { appendChild() {} },
        createElement: () => ({ style: {}, setAttribute() {}, isConnected: false }),
    });
    vm.createContext(win);
    vm.runInContext(BACKEND_SRC, win);
    if (request) win.StreamBrosTizenBackend.__request = request;
    return win;
}

function backendWith(responses) {
    const calls = [];
    const win = makeWindow();
    const backend = win.StreamBrosTizenBackend.create({
        request: (url) => {
            calls.push(url);
            const next = responses.shift();
            return next instanceof Error || (next && (next.status || next.code)) ? Promise.reject(next) : Promise.resolve(next);
        },
    });
    return { backend, calls };
}

async function register(backend, url) {
    const r = await backend.handle('POST', 'file:///api/provider-targets', JSON.stringify({ url }));
    assert.equal(r.status, 200);
    return r.body.targetId;
}

test('xtream: registers a provider and calls player_api.php on it directly', async () => {
    const { backend, calls } = backendWith(['﻿{"user_info":{"auth":1}}']);
    const id = await register(backend, 'http://provider.example:8080/player_api.php');
    const r = await backend.handle('GET', `file:///api/xtream?targetId=${id}&username=u&password=p&action=get_live_categories&userAgent=x&empty=`);
    assert.equal(r.status, 200);
    assert.deepEqual(plain(r.body), { action: 'get_live_categories', payload: { user_info: { auth: 1 } } });
    assert.equal(calls[0], 'http://provider.example:8080/player_api.php?username=u&password=p&action=get_live_categories');
});

test('xtream: provider 503 keeps the web backend error shape (backup server failover sees it)', async () => {
    const { backend } = backendWith([{ status: 503, statusText: 'Service Unavailable' }]);
    const id = await register(backend, 'http://p.example');
    const r = await backend.handle('GET', `file:///api/xtream?targetId=${id}&action=x`);
    assert.equal(r.status, 200);
    assert.deepEqual(plain(r.body), { message: 'Service Unavailable', status: 503 });
});

test('xtream: no answer at all is a 502 Bad Gateway with a code', async () => {
    const { backend } = backendWith([{ code: 'ECONNECTION' }]);
    const id = await register(backend, 'http://p.example');
    const r = await backend.handle('GET', `file:///api/xtream?targetId=${id}`);
    assert.deepEqual(plain(r.body), { message: 'Bad Gateway (ECONNECTION)', status: 502, code: 'ECONNECTION' });
});

test('xtream: connection test reports the failure kind', async () => {
    const { backend } = backendWith([{ code: 'ECONNECTION' }, { status: 401, statusText: 'Unauthorized' }]);
    const id = await register(backend, 'https://p.example');
    let r = await backend.handle('GET', `file:///api/xtream?targetId=${id}&connectionTest=true`);
    assert.deepEqual(plain(r.body), { connectionFailure: { kind: 'connection', canTryHttp: true } });
    r = await backend.handle('GET', `file:///api/xtream?targetId=${id}&connectionTest=true`);
    assert.deepEqual(plain(r.body), { connectionFailure: { kind: 'http', status: 401, canTryHttp: false } });
});

test('unknown target is a 404 so the app registers again', async () => {
    const { backend } = backendWith([]);
    const r = await backend.handle('GET', 'file:///api/xtream?targetId=nope');
    assert.equal(r.status, 404);
});

test('provider-targets rejects non-http URLs; unsupported routes answer 501', async () => {
    const { backend } = backendWith([]);
    let r = await backend.handle('POST', 'file:///api/provider-targets', JSON.stringify({ url: 'ftp://x' }));
    assert.equal(r.status, 400);
    r = await backend.handle('GET', 'file:///api/stalker?targetId=x');
    assert.equal(r.status, 501);
    r = await backend.handle('GET', 'file:///api/health');
    assert.equal(r.body.status, 'ok');
});

test('fetch shim answers /api and passes everything else through', async () => {
    const win = makeWindow();
    win.StreamBrosTizenBackend.install(win, { request: () => Promise.resolve('{"ok":true}') });
    const reg = await win.fetch('/api/provider-targets', { method: 'POST', body: JSON.stringify({ url: 'http://p.example' }) });
    assert.equal(reg.status, 200);
    const { targetId } = await reg.json();
    assert.match(targetId, /^t[0-9a-f]+$/);
    const other = await win.fetch('https://api.themoviedb.org/3/x');
    assert.deepEqual(other, { passedThrough: 'https://api.themoviedb.org/3/x' });
});

test('XMLHttpRequest shim delivers an Angular-style load event', async () => {
    const win = makeWindow();
    win.StreamBrosTizenBackend.install(win, { request: () => Promise.resolve('[{"category_id":"1"}]') });
    const reg = await win.fetch('/api/provider-targets', { method: 'POST', body: '{"url":"http://p.example"}' });
    const { targetId } = await reg.json();
    const xhr = new win.XMLHttpRequest();
    xhr.open('GET', `/api/xtream?targetId=${targetId}&action=get_vod_categories`);
    xhr.responseType = 'text';
    const loaded = new Promise((resolve) => xhr.addEventListener('load', resolve));
    xhr.send(null);
    await loaded;
    assert.equal(xhr.status, 200);
    assert.equal(xhr.readyState, 4);
    assert.deepEqual(JSON.parse(xhr.response), { action: 'get_vod_categories', payload: [{ category_id: '1' }] });
    assert.match(xhr.getAllResponseHeaders(), /application\/json/);
    // A provider URL still goes to the real XMLHttpRequest.
    const direct = new win.XMLHttpRequest();
    direct.open('GET', 'http://p.example/live/u/p/1.ts');
    direct.send();
    assert.ok(FakeXhr.sent.includes('http://p.example/live/u/p/1.ts'));
});

test('kill switch: tizen-backend=off installs nothing', () => {
    const win = makeWindow({ storage: memoryStorage({ 'tizen-backend': 'off' }) });
    assert.equal(win.StreamBrosTizenBackend.install(win), null);
});

function runAdapter(storage = memoryStorage()) {
    const win = makeWindow({ storage });
    const events = [];
    win.tizen = {
        application: { getCurrentApplication: () => ({ exit: () => events.push('exit') }) },
        tvinputdevice: { registerKeyBatch: (keys) => events.push('keys:' + keys.join(',')) },
    };
    vm.runInContext(ADAPTER_SRC, win);
    win.__tvShell = {
        back: () => events.push('back'),
        menu: () => events.push('menu'),
        media: (a) => events.push('media:' + a),
        setForeground: (on) => events.push('fg:' + on),
    };
    return { win, events, storage };
}

function press(win, keyCode) {
    const ev = new Event('keydown', { cancelable: true });
    Object.defineProperty(ev, 'keyCode', { value: keyCode });
    win.dispatchEvent(ev);
    return ev;
}

test('adapter: remote keys reach tv.js; Back, Tools and media keys', () => {
    const { win, events } = runAdapter();
    assert.ok(events[0].startsWith('keys:MediaPlayPause'));
    assert.equal(press(win, 10009).defaultPrevented, true);
    press(win, 10135);
    press(win, 10252);
    press(win, 417);
    assert.equal(press(win, 38).defaultPrevented, false); // arrows stay with tv.js
    assert.deepEqual(events.slice(1), ['back', 'menu', 'media:playpause', 'media:fastforward']);
});

test('adapter: bridge exits the app and forces the Android-only features off', () => {
    const { win, events, storage } = runAdapter();
    win.TvShell.postMessage(JSON.stringify(['exitApp']));
    win.TvShell.postMessage('not json');
    assert.deepEqual(events.slice(-1), ['exit']);
    assert.equal(storage.data['native-live'], 'off');
    assert.equal(storage.data['native-movies'], 'off');
    assert.equal(storage.data['poster-cache'], 'off');
    assert.ok(win.__streamBrosTizenBackend, 'adapter installs the in-page backend');
});

test('adapter: tizen-keys=off leaves keys alone; tizen-keep-switches=on keeps settings', () => {
    const { win, events, storage } = runAdapter(memoryStorage({ 'tizen-keys': 'off', 'tizen-keep-switches': 'on' }));
    press(win, 10009);
    assert.deepEqual(events, []);
    assert.equal(storage.data['native-live'], undefined);
});

const INDEX = `<!doctype html>
<html lang="en">
    <head>
        <base href="/" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta
            http-equiv="Content-Security-Policy"
            content="default-src 'self'"
        />
        <script src="assets/app-config.js" defer></script>
    </head>
    <body><app-root></app-root><script src="main-ABC.js" type="module"></script></body>
</html>`;

test('index.html: relative base, TV viewport, no CSP, shell scripts first in order', () => {
    const html = transformIndex(INDEX);
    assert.match(html, /<base href="\.\/" \/>/);
    assert.match(html, /<meta name="viewport" content="width=1280" \/>/);
    assert.doesNotMatch(html, /Content-Security-Policy/);
    const order = ['webapis/webapis.js', 'tizenshell/backend.js', 'tizenshell/adapter.js', 'tvshell/tv.js', 'assets/app-config.js', 'main-ABC.js']
        .map((s) => html.indexOf(s));
    assert.ok(order.every((i, n) => i > 0 && (n === 0 || i > order[n - 1])), `script order ${order}`);
});

test('packageTizen builds a complete app folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tizen-pkg-'));
    const www = join(dir, 'www');
    mkdirSync(join(www, 'assets', 'icons'), { recursive: true });
    writeFileSync(join(www, 'index.html'), INDEX);
    writeFileSync(join(www, 'main-ABC.js'), '');
    writeFileSync(join(www, 'ngsw-worker.js'), '');
    writeFileSync(join(www, 'assets', 'app-config.js'), 'window.__IPTVNATOR_CONFIG__ = {};');
    writeFileSync(join(www, 'assets', 'icons', 'icon-tv-256.png'), 'png');
    const out = packageTizen({ www, out: join(dir, 'out'), version: '1.4.2' });
    for (const f of ['index.html', 'main-ABC.js', 'icon.png', 'config.xml', 'tvshell/tv.js', 'tizenshell/backend.js', 'tizenshell/adapter.js']) {
        assert.ok(existsSync(join(out, f)), f);
    }
    assert.equal(existsSync(join(out, 'ngsw-worker.js')), false);
    assert.match(readFileSync(join(out, 'assets', 'app-config.js'), 'utf8'), /"BACKEND_URL":"\/api"/);
    const config = readFileSync(join(out, 'config.xml'), 'utf8');
    assert.match(config, /version="1\.4\.2"/);
    assert.match(config, /package="StreamBros"/);
    assert.match(config, /<access origin="\*"/);
    assert.throws(() => packageTizen({ www, out: join(dir, 'o2'), version: 'v1' }), /version/);
});
