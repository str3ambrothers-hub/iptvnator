import { inject, Injector, type Signal } from '@angular/core';
import {
    XtreamApiService,
    XtreamFullEpgService,
    type XtreamCredentials,
} from '@iptvnator/portal/xtream/data-access';
import {
    foldSearchText,
    type EpgItem,
    type EpgProgram,
} from '@iptvnator/shared/interfaces';
import type { EpgGuideSearchHit, EpgGuideWindow } from '@iptvnator/ui/epg';
import { toSharedEpgProgram } from '../portal-channels-list/epg-preview-program';
import type { XtreamLiveChannelItem } from './xtream-live-channel-navigation.service';
import { XtreamBulkGuide, type BulkScopeEntry } from './xtream-bulk-guide';
import { XtreamGuideScheduleCache } from './xtream-guide-schedule-cache';

export type XtreamGuideSchedule = { items: EpgItem[]; programs: EpgProgram[] };
type ScheduleRevision = {
    playlist?: (XtreamCredentials & { id?: string }) | null;
};
const EMPTY: XtreamGuideSchedule = { items: [], programs: [] };

/**
 * TV app: keep only the programmes from an hour ago to 12 hours ahead (the guide window is a whole
 * day), so far more channels fit in memory. Kill switch: localStorage['guide-window'] = 'off'.
 */
function trimmedWindow<T extends { fromMs: number; toMs: number }>(window: T): T {
    try {
        if (
            !document.documentElement.classList.contains('tv-shell') ||
            localStorage.getItem('guide-window') === 'off'
        )
            return window;
        const now = Date.now();
        const fromMs = Math.max(window.fromMs, now - 3_600_000);
        const toMs = Math.min(window.toMs, now + 12 * 3_600_000);
        return fromMs < toMs ? { ...window, fromMs, toMs } : window;
    } catch {
        return window;
    }
}

/**
 * Channel ids in scan order. Normally the list order; in the TV app the scan restarts from the top
 * of the screen whenever the viewer has moved on (switch: localStorage['guide-scan-follow'] = 'off').
 */
function* scanOrder(window: EpgGuideWindow): Generator<string> {
    const ids = window.channels.map((channel) => channel.id);
    let follow = false;
    try {
        follow =
            !!window.focusId &&
            document.documentElement.classList.contains('tv-shell') &&
            localStorage.getItem('guide-scan-follow') !== 'off';
    } catch {
        follow = false;
    }
    if (!follow) {
        yield* ids;
        return;
    }
    const index = new Map(ids.map((id, i) => [id, i]));
    const done = new Uint8Array(ids.length);
    let left = ids.length;
    let cursor = 0;
    let lastFocus: string | undefined;
    while (left > 0) {
        const focus = window.focusId?.();
        if (focus !== lastFocus) {
            lastFocus = focus;
            const at = focus === undefined ? undefined : index.get(focus);
            if (at !== undefined) cursor = at;
        }
        let steps = 0;
        while (done[cursor] && steps++ < ids.length) cursor = (cursor + 1) % ids.length;
        if (done[cursor]) return;
        done[cursor] = 1;
        left--;
        yield ids[cursor];
        cursor = (cursor + 1) % ids.length;
    }
}

/** Retry failed or empty schedule loads. Kill switch: localStorage['guide-epg-retry'] = 'off'. */
function guideRetryEnabled(): boolean {
    try {
        return globalThis.localStorage?.getItem('guide-epg-retry') !== 'off';
    } catch {
        return true;
    }
}

function pauseFor(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason);
        };
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

export function scheduleKey(item: XtreamLiveChannelItem): string {
    return `${item.xtream_id}:${item.epg_channel_id ?? ''}`;
}

export function isNewGuideSearchMatch(
    channelId: string,
    program: EpgProgram,
    term: string,
    hits: readonly EpgGuideSearchHit[]
): boolean {
    return (
        foldSearchText(`${program.title} ${program.desc ?? ''}`).includes(
            term
        ) &&
        !hits.some(
            ({ channelId: id, program: previous }) =>
                id === channelId &&
                previous.title === program.title &&
                (previous.startTimestamp ?? previous.start) ===
                    (program.startTimestamp ?? program.start) &&
                (previous.stopTimestamp ?? previous.stop) ===
                    (program.stopTimestamp ?? program.stop)
        )
    );
}

export function programmeOverlapsGuideWindow(
    program: EpgProgram,
    window: Pick<EpgGuideWindow, 'fromMs' | 'toMs'>
): boolean {
    const start = program.startTimestamp
        ? program.startTimestamp * 1000
        : Date.parse(program.start);
    const stop = program.stopTimestamp
        ? program.stopTimestamp * 1000
        : Date.parse(program.stop);
    return stop > start && start < window.toMs && stop > window.fromMs;
}

export function injectXtreamGuideSchedules(
    revision: Signal<ScheduleRevision>,
    session: Signal<AbortController | null>,
    scopedRows: Signal<ReadonlyMap<string, XtreamLiveChannelItem>>,
    publish: (
        key: string,
        revision: unknown,
        schedule: XtreamGuideSchedule
    ) => void
) {
    const injector = inject(Injector);
    let api: XtreamApiService | undefined;
    let cachedRevision: ScheduleRevision | undefined;
    const cache = new XtreamGuideScheduleCache<XtreamGuideSchedule>(
        (sessionId) => void api?.cancelSession(sessionId)
    );
    // TV app: the provider's whole-guide file, when it is ready (see xtream-bulk-guide.ts).
    const bulk = new XtreamBulkGuide(() => (api ??= injector.get(XtreamApiService)));
    let scopeRows: ReadonlyMap<string, XtreamLiveChannelItem> | undefined;
    let scopeIds: readonly BulkScopeEntry[] = [];
    const bulkScope = () => {
        const rows = scopedRows();
        if (rows !== scopeRows) {
            scopeRows = rows;
            scopeIds = [...rows.values()].map((row) => ({
                epg: row.epg_channel_id,
                name: row.name ?? row.title,
            }));
        }
        return scopeIds;
    };

    function reader(signal?: AbortSignal, background = false) {
        const current = revision();
        const owner = session()?.signal;
        if (!owner) throw new DOMException('EPG guide closed', 'AbortError');
        const fullEpg = injector.get(XtreamFullEpgService);
        api ??= injector.get(XtreamApiService);
        if (cachedRevision !== current) {
            cachedRevision = current;
            cache.clear();
        }
        const checkCurrent = () => {
            signal?.throwIfAborted();
            owner.throwIfAborted();
            if (current !== revision())
                throw new DOMException('EPG source changed', 'AbortError');
        };
        const readSchedule = async (
            item: XtreamLiveChannelItem | undefined
        ) => {
            const playlist = current.playlist;
            if (!playlist || !item) return EMPTY;
            const key = scheduleKey(item);
            if (!cache.peek(key)) {
                const bulked = await bulk
                    .lookup(playlist, item.epg_channel_id, bulkScope, background, item.name ?? item.title)
                    .catch(() => undefined);
                checkCurrent();
                if (bulked)
                    cache.put(key, {
                        items: bulked,
                        programs: bulked.map(toSharedEpgProgram),
                    });
            }
            const schedule = await cache.load(
                key,
                checkCurrent,
                async (options) => {
                    const retry = guideRetryEnabled();
                    for (let attempt = 0; ; attempt++) {
                        try {
                            const items = await fullEpg.load(
                                playlist,
                                item.xtream_id,
                                item.epg_channel_id ?? null,
                                options
                            );
                            // A throttled provider can answer "nothing" for a channel that has a
                            // schedule: ask once more for the rows on screen (not the background scan).
                            if (retry && !items.length && !background && attempt < 1) {
                                await pauseFor(900, options.signal);
                                continue;
                            }
                            return {
                                items,
                                programs: items.map(toSharedEpgProgram),
                            };
                        } catch (error) {
                            options.signal.throwIfAborted();
                            if (!retry || attempt >= 2) throw error;
                            await pauseFor(800 * (attempt + 1), options.signal);
                        }
                    }
                },
                signal,
                background
            );
            checkCurrent();
            publish(key, current, schedule);
            return schedule;
        };
        return {
            readSchedule,
            read: async (item: XtreamLiveChannelItem | undefined) =>
                (await readSchedule(item)).programs,
            checkCurrent,
        };
    }

    const expiresAt = (item: XtreamLiveChannelItem | undefined) =>
        item ? cache.expiresAt(scheduleKey(item)) : 0;
    return {
        reader,
        async loadWindow(
            window: EpgGuideWindow
        ): Promise<Map<string, EpgProgram[]>> {
            const { read } = reader(window.signal);
            const rows = scopedRows();
            const results = await Promise.all(
                window.channels.map(async ({ id }) => {
                    try {
                        return [
                            id,
                            (await read(rows.get(id))).filter((program) =>
                                programmeOverlapsGuideWindow(
                                    program,
                                    trimmedWindow(window)
                                )
                            ),
                        ] as const;
                    } catch {
                        return null;
                    }
                })
            );
            return new Map(results.filter((result) => result !== null));
        },
        async loadCoverage(
            window: EpgGuideWindow,
            reportPrograms?: (
                channelId: string,
                programs: EpgProgram[] | null
            ) => void
        ): Promise<Set<string>> {
            const { read, checkCurrent } = reader(window.signal, true);
            // Wait for the whole-guide file (when there is one): judging channels by the slow
            // per-channel answers first would hide channels that the file does cover.
            const playlist = revision().playlist;
            if (playlist) await bulk.settled(playlist, window.signal).catch(() => undefined);
            const rows = scopedRows();
            const covered = new Set<string>();
            // TV app: scan outwards from where the viewer is, not always from the top.
            const order = scanOrder(window);
            for (const id of order) {
                const programs = await read(rows.get(id)).catch(() => {
                    checkCurrent();
                    return null;
                });
                const matches = programs?.filter((item) =>
                    programmeOverlapsGuideWindow(item, trimmedWindow(window))
                );
                if (!matches || matches.length) covered.add(id);
                reportPrograms?.(id, matches ?? null);
            }
            return covered;
        },
        clear: () => cache.clear(),
        expiresAt,
        rowExpiresAt: (id: string) => expiresAt(scopedRows().get(id)),
        async forPlayback(
            item: XtreamLiveChannelItem,
            signal?: AbortSignal
        ): Promise<EpgItem[] | null> {
            signal?.throwIfAborted();
            const owner = session();
            if (!owner) return null;
            const cached =
                cachedRevision === revision() && cache.peek(scheduleKey(item));
            if (cached) return cached.items;
            try {
                return (await reader(signal).readSchedule(item)).items;
            } catch (error) {
                signal?.throwIfAborted();
                if (owner.signal.aborted && !session()) return null;
                throw error;
            }
        },
    };
}
