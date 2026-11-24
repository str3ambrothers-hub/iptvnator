#!/usr/bin/env node
/**
 * Turns the built StreamBros PWA into a Samsung (Tizen) app folder, ready for
 * `tizen package -t wgt -s <profile>` on the owner's computer.
 *
 *   node tv-shell/tizen/package.mjs --www dist/apps/web --out dist/tizen-shell [--version 1.2.3]
 *
 * What it does (the Tizen twin of TvShellServer's injection):
 *   - copies the PWA, without the service worker (a packaged app has no use for it)
 *   - adds tvshell/tv.js (unchanged) and tizenshell/backend.js + adapter.js
 *   - points the app at the in-page backend (assets/app-config.js: BACKEND_URL /api)
 *   - index.html: relative <base>, 1280px layout viewport like the Fire TV build,
 *     no CSP <meta> (Samsung's webapis.js is not 'self'), and the scripts in
 *     this order: webapis.js, backend.js, adapter.js, tv.js (defer), the app
 *   - writes config.xml with the version and the app icon
 * No dependencies: plain Node 18+.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TV_JS = join(HERE, '..', 'android', 'app', 'src', 'main', 'assets', 'tvshell', 'tv.js');
const DROP = ['ngsw-worker.js', 'ngsw.json', 'safety-worker.js', 'worker-basic.min.js'];
export const SAMSUNG_API = '<script src="$WEBAPIS/webapis/webapis.js"></script>';
export const SHELL_SCRIPTS = [
    SAMSUNG_API,
    '<script src="tizenshell/backend.js"></script>',
    '<script src="tizenshell/adapter.js"></script>',
    '<script src="tvshell/tv.js" defer></script>',
].join('\n        ');

export function transformIndex(html, layoutWidth = 1280) {
    let out = html.replace(/<base href="[^"]*"\s*\/?>/, '<base href="./" />');
    out = out.replace(/<meta name="viewport"[^>]*>/, `<meta name="viewport" content="width=${layoutWidth}" />`);
    out = out.replace(/\s*<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i, '');
    const anchor = out.indexOf('<script');
    if (anchor === -1) throw new Error('index.html has no <script>: is this the built PWA?');
    return out.slice(0, anchor) + SHELL_SCRIPTS + '\n        ' + out.slice(anchor);
}

function pickIcon(www) {
    for (const name of ['icon-tv-256.png', 'android-chrome-512x512.png', 'icon.png']) {
        const file = join(www, 'assets', 'icons', name);
        if (existsSync(file)) return file;
    }
    return null;
}

export function packageTizen({ www, out, version }) {
    www = resolve(www);
    out = resolve(out);
    if (!existsSync(join(www, 'index.html'))) {
        throw new Error(`no index.html in ${www}: build the PWA first (pnpm nx build web --configuration=pwa)`);
    }
    if (!/^\d{1,3}\.\d{1,3}\.\d{1,5}$/.test(version)) {
        throw new Error(`Tizen needs a version like 1.2.3, got "${version}"`);
    }
    rmSync(out, { recursive: true, force: true });
    cpSync(www, out, { recursive: true, filter: (file) => !DROP.includes(file.split(/[\\/]/).pop()) });

    mkdirSync(join(out, 'tvshell'), { recursive: true });
    cpSync(TV_JS, join(out, 'tvshell', 'tv.js'));
    mkdirSync(join(out, 'tizenshell'), { recursive: true });
    cpSync(join(HERE, 'backend.js'), join(out, 'tizenshell', 'backend.js'));
    cpSync(join(HERE, 'adapter.js'), join(out, 'tizenshell', 'adapter.js'));

    mkdirSync(join(out, 'assets'), { recursive: true });
    writeFileSync(join(out, 'assets', 'app-config.js'), 'window.__IPTVNATOR_CONFIG__ = {"BACKEND_URL":"/api"};\n');

    const index = join(out, 'index.html');
    writeFileSync(index, transformIndex(readFileSync(index, 'utf8')));

    const icon = pickIcon(www);
    if (!icon) throw new Error('no app icon found under assets/icons');
    cpSync(icon, join(out, 'icon.png'));

    const template = readFileSync(join(HERE, 'config.xml'), 'utf8');
    writeFileSync(join(out, 'config.xml'), template.replace('__VERSION__', version));
    return out;
}

function arg(name, fallback) {
    const i = process.argv.indexOf(name);
    return i === -1 ? fallback : process.argv[i + 1];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const out = packageTizen({
        www: arg('--www', 'dist/apps/web'),
        out: arg('--out', 'dist/tizen-shell'),
        version: arg('--version', '1.0.0'),
    });
    console.log(`Samsung app folder ready: ${out}`);
}
