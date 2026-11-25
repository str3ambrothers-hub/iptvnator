import {
    EPG_GUIDE_PREVIEW_ENDED_EVENT,
    EPG_GUIDE_SELECT_EVENT,
    decideEpgGuideSelect,
} from './epg-guide-tv-preview';

describe('decideEpgGuideSelect', () => {
    let showing = false;
    let intents: string[];
    const listener = (e: Event) =>
        intents.push((e as CustomEvent).detail.intent);

    beforeEach(() => {
        intents = [];
        showing = false;
        document.documentElement.classList.add('tv-shell');
        (window as unknown as { __tvShell: object }).__tvShell = {
            previewCapable: () => true,
            previewShowing: () => showing,
        };
        document.addEventListener(EPG_GUIDE_SELECT_EVENT, listener);
        document.dispatchEvent(new CustomEvent(EPG_GUIDE_PREVIEW_ENDED_EVENT));
    });
    afterEach(() => {
        document.removeEventListener(EPG_GUIDE_SELECT_EVENT, listener);
        document.documentElement.classList.remove('tv-shell');
        delete (window as unknown as { __tvShell?: object }).__tvShell;
    });

    it('is inactive when the shell cannot preview', () => {
        delete (window as unknown as { __tvShell?: object }).__tvShell;
        expect(decideEpgGuideSelect('1')).toBe('inactive');
    });

    it('previews first, then goes full screen on the same channel', () => {
        expect(decideEpgGuideSelect('1')).toBe('preview');
        showing = true;
        expect(decideEpgGuideSelect('1')).toBe('commit');
        expect(intents).toEqual(['preview', 'commit']);
    });

    it('previews another channel instead of going full screen', () => {
        decideEpgGuideSelect('1');
        showing = true;
        expect(decideEpgGuideSelect('2')).toBe('preview');
    });

    it('falls back to full screen when the picture never appeared', () => {
        expect(decideEpgGuideSelect('1')).toBe('preview');
        expect(decideEpgGuideSelect('1')).toBe('normal');
        expect(decideEpgGuideSelect('1')).toBe('preview');
    });

    it('starts over once the picture has ended', () => {
        decideEpgGuideSelect('1');
        showing = true;
        document.dispatchEvent(new CustomEvent(EPG_GUIDE_PREVIEW_ENDED_EVENT));
        showing = false;
        expect(decideEpgGuideSelect('1')).toBe('preview');
    });
});
