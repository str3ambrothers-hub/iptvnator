/**
 * Poster URLs through the TV shell's poster cache.
 *
 * The shell's embedded backend downloads each poster once, shrinks it to card
 * size and serves it from disk (`GET <backend>/image?url=&w=`), so a grid of
 * tens of thousands of items neither waits on slow provider image servers nor
 * decodes full-size artwork on a small device. Active in the TV shell only
 * (its `tv.js` puts the `tv-shell` class on `<html>`; other runtimes have no
 * such endpoint). Kill switch: `localStorage['poster-cache'] = 'off'`.
 */

/** Class the TV shell sets on `<html>`. */
export const POSTER_PROXY_SHELL_CLASS = 'tv-shell';
export const POSTER_PROXY_KILL_SWITCH_KEY = 'poster-cache';
/** Card width in px the cache scales to: small to decode and keep in memory on a Stick. */
export const POSTER_PROXY_WIDTH = 240;
/** The earlier, larger size. Kill switch: `localStorage['poster-small'] = 'off'`. */
export const POSTER_PROXY_LARGE_WIDTH = 360;

function posterWidth(doc: Document): number {
    try {
        return doc.defaultView?.localStorage?.getItem('poster-small') === 'off'
            ? POSTER_PROXY_LARGE_WIDTH
            : POSTER_PROXY_WIDTH;
    } catch {
        return POSTER_PROXY_WIDTH;
    }
}

export function isPosterProxyEnabled(doc: Document | null): boolean {
    if (!doc?.documentElement?.classList.contains(POSTER_PROXY_SHELL_CLASS)) {
        return false;
    }
    try {
        return (
            doc.defaultView?.localStorage?.getItem(
                POSTER_PROXY_KILL_SWITCH_KEY
            ) !== 'off'
        );
    } catch {
        return true;
    }
}

function backendBase(doc: Document): string {
    const config = (
        doc.defaultView as
            | (Window & {
                  __IPTVNATOR_CONFIG__?: { BACKEND_URL?: string };
              })
            | null
    )?.__IPTVNATOR_CONFIG__;
    return (config?.BACKEND_URL?.trim() || '/api').replace(/\/+$/, '');
}

/**
 * The cached-image URL for a remote poster, or the URL unchanged when the
 * cache is off, or the poster is not an http(s) address (bundled assets,
 * data: URIs).
 */
export function posterProxyUrl(doc: Document | null, url: string): string {
    if (!doc || !/^https?:\/\//i.test(url) || !isPosterProxyEnabled(doc)) {
        return url;
    }
    return `${backendBase(doc)}/image?url=${encodeURIComponent(url)}&w=${posterWidth(doc)}`;
}
