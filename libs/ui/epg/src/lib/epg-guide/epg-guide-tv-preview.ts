/**
 * TV app only: the small live picture in the guide's corner. The first select on a channel plays
 * it there; a second select on the same channel opens it full screen. The picture itself is drawn
 * by the app (tv.js tells the native shell where), so everything here is inert in a browser and
 * when the shell reports the preview as off (`localStorage['guide-preview'] = 'off'`).
 */
interface TvPreviewHost {
    previewCapable?: () => boolean;
    previewShowing?: () => boolean;
}

export type EpgGuideSelectIntent = 'preview' | 'commit' | 'normal';

export const EPG_GUIDE_SELECT_EVENT = 'tv-guide-select';
export const EPG_GUIDE_PREVIEW_ENDED_EVENT = 'tv-guide-preview-ended';

let previewId: string | undefined;
let endedListening = false;

function host(): TvPreviewHost | undefined {
    if (typeof window === 'undefined') return undefined;
    return (window as unknown as { __tvShell?: TvPreviewHost }).__tvShell;
}

/** Whether the shell can show a preview here (Android app, built-in player on, switch not off). */
export function epgGuidePreviewCapable(): boolean {
    try {
        return (
            document.documentElement.classList.contains('tv-shell') &&
            host()?.previewCapable?.() === true
        );
    } catch {
        return false;
    }
}

function listenForEnd(): void {
    if (endedListening || typeof document === 'undefined') return;
    endedListening = true;
    document.addEventListener(EPG_GUIDE_PREVIEW_ENDED_EVENT, () => {
        previewId = undefined;
    });
}

function announce(intent: EpgGuideSelectIntent): void {
    document.dispatchEvent(
        new CustomEvent(EPG_GUIDE_SELECT_EVENT, { detail: { intent } })
    );
}

/**
 * What a select on `channelId` means right now:
 * - `preview`: tune it into the corner picture (guide stays open);
 * - `commit`: it is already in the corner, so go full screen (the shell does it);
 * - `normal`: preview is off or did not start, so the usual full-screen path.
 */
export function decideEpgGuideSelect(
    channelId: string
): EpgGuideSelectIntent | 'inactive' {
    if (!epgGuidePreviewCapable()) return 'inactive';
    listenForEnd();
    const showing = host()?.previewShowing?.() === true;
    let intent: EpgGuideSelectIntent;
    if (previewId === channelId && showing) intent = 'commit';
    else if (previewId === channelId) intent = 'normal'; // asked for, never appeared: do not loop
    else {
        previewId = channelId;
        intent = 'preview';
    }
    announce(intent);
    if (intent === 'normal') previewId = undefined;
    return intent;
}
