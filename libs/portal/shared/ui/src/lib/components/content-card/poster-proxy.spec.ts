import {
    isPosterProxyEnabled,
    POSTER_PROXY_KILL_SWITCH_KEY,
    POSTER_PROXY_SHELL_CLASS,
    posterProxyUrl,
} from './poster-proxy';

describe('poster proxy', () => {
    const poster = 'https://img.example.test/p/one.jpg?size=big&x=1';

    afterEach(() => {
        document.documentElement.classList.remove(POSTER_PROXY_SHELL_CLASS);
        localStorage.removeItem(POSTER_PROXY_KILL_SWITCH_KEY);
        delete (window as { __IPTVNATOR_CONFIG__?: unknown })
            .__IPTVNATOR_CONFIG__;
    });

    it('leaves posters alone outside the TV shell', () => {
        expect(isPosterProxyEnabled(document)).toBe(false);
        expect(posterProxyUrl(document, poster)).toBe(poster);
    });

    it('routes remote posters through the backend image cache in the TV shell', () => {
        document.documentElement.classList.add(POSTER_PROXY_SHELL_CLASS);

        expect(posterProxyUrl(document, poster)).toBe(
            `/api/image?url=${encodeURIComponent(poster)}&w=240`
        );
    });

    it('follows the runtime backend url', () => {
        document.documentElement.classList.add(POSTER_PROXY_SHELL_CLASS);
        (
            window as { __IPTVNATOR_CONFIG__?: { BACKEND_URL?: string } }
        ).__IPTVNATOR_CONFIG__ = { BACKEND_URL: '/shell-api/' };

        expect(posterProxyUrl(document, poster)).toMatch(
            /^\/shell-api\/image\?url=/
        );
    });

    it('does not touch bundled assets or data URIs', () => {
        document.documentElement.classList.add(POSTER_PROXY_SHELL_CLASS);

        expect(posterProxyUrl(document, './assets/images/default-poster.png')).toBe(
            './assets/images/default-poster.png'
        );
        expect(posterProxyUrl(document, 'data:image/png;base64,AAAA')).toBe(
            'data:image/png;base64,AAAA'
        );
    });

    it("is switched off by localStorage['poster-cache'] = 'off'", () => {
        document.documentElement.classList.add(POSTER_PROXY_SHELL_CLASS);
        localStorage.setItem(POSTER_PROXY_KILL_SWITCH_KEY, 'off');

        expect(isPosterProxyEnabled(document)).toBe(false);
        expect(posterProxyUrl(document, poster)).toBe(poster);
    });
});
