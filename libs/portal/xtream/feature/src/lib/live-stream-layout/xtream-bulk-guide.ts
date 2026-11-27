import type {
    XtreamApiService,
    XtreamCredentials,
} from '@iptvnator/portal/xtream/data-access';
import type { EpgItem } from '@iptvnator/shared/interfaces';

/** TV app only. Kill switch: localStorage['guide-bulk'] = 'off'. */
export function bulkGuideEnabled(): boolean {
    try {
        return (
            document.documentElement.classList.contains('tv-shell') &&
            localStorage.getItem('guide-bulk') !== 'off'
        );
    } catch {
        return false;
    }
}

const CHUNK = 80; // ids per request: they travel in the address, which has a size limit
const POLL_MS = 2500;
const GIVE_UP_MS = 6 * 60_000;
const RETRY_AFTER_FAILURE_MS = 2 * 60_000;
const MEMO_MS = 20 * 60_000;

type Row = readonly [number, number, string, string];

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

function toItem(epgId: string, [start, stop, title, desc]: Row): EpgItem {
    return {
        id: `${epgId}:${start}`,
        epg_id: epgId,
        title,
        lang: '',
        start: iso(start),
        end: iso(stop),
        stop: iso(stop),
        description: desc,
        channel_id: epgId,
        start_timestamp: String(start),
        stop_timestamp: String(stop),
    };
}

/**
 * The provider's whole-guide file, read once by the app's backend and served per channel. The
 * first request starts it; until the backend says "ready" every lookup answers `undefined` and the
 * guide uses its usual one-request-per-channel loading, so nothing waits for the download.
 */
export class XtreamBulkGuide {
    private state: 'idle' | 'starting' | 'ready' = 'idle';
    private owner = '';
    private truncated = false;
    private channelCount = 0;
    private failedUntil = 0;
    private memoAt = 0;
    private readonly memo = new Map<string, EpgItem[]>();
    private readonly absent = new Set<string>();
    private readonly loading = new Map<string, Promise<void>>();
    private prefetching = false;
    private requests = 0;

    constructor(private readonly api: () => XtreamApiService) {
        (globalThis as { __tvGuideBulk?: unknown }).__tvGuideBulk = () => ({
            state: this.state,
            channels: this.channelCount,
            kept: this.memo.size,
            absent: this.absent.size,
            requests: this.requests,
            truncated: this.truncated,
        });
    }

    /** Schedules of the guide window, or `undefined` to use the per-channel request instead. */
    async lookup(
        credentials: XtreamCredentials,
        epgChannelId: string | null | undefined,
        scope: () => readonly (string | null | undefined)[],
        background: boolean
    ): Promise<EpgItem[] | undefined> {
        const id = epgChannelId?.trim();
        if (!id || !bulkGuideEnabled() || Date.now() < this.failedUntil) return undefined;
        this.ensure(credentials);
        if (this.state !== 'ready') return undefined;
        if (Date.now() - this.memoAt > MEMO_MS) this.expire(credentials);
        const key = id.toLowerCase();
        if (!this.memo.has(key) && !this.absent.has(key)) {
            await (this.loading.get(key) ?? this.fill(credentials, id, scope()));
        }
        void this.prefetch(credentials, scope());
        const found = this.memo.get(key);
        if (found) return found;
        // Not in the guide file: the rows on screen still try their own request; the background
        // scan counts it as "no guide" (unless the kept part was cut short).
        return this.absent.has(key) && background && !this.truncated && this.channelCount > 0
            ? []
            : undefined;
    }

    private expire(credentials: XtreamCredentials): void {
        this.memo.clear();
        this.absent.clear();
        this.memoAt = Date.now();
        // The backend rebuilds in the background while it keeps serving the old copy.
        void this.api().xmltvGuide(credentials, 'xmltv_guide_start').catch(() => undefined);
    }

    private ensure(credentials: XtreamCredentials): void {
        const owner = `${credentials.serverUrl}|${credentials.username}`;
        if (owner !== this.owner) {
            this.owner = owner;
            this.state = 'idle';
            this.memo.clear();
            this.absent.clear();
        }
        if (this.state === 'idle') {
            this.state = 'starting';
            void this.poll(credentials, owner);
        }
    }

    private async poll(credentials: XtreamCredentials, owner: string): Promise<void> {
        const began = Date.now();
        const fail = () => {
            if (this.owner !== owner) return;
            this.state = 'idle';
            this.failedUntil = Date.now() + RETRY_AFTER_FAILURE_MS;
        };
        try {
            for (;;) {
                this.requests++;
                const reply = await this.api().xmltvGuide(credentials, 'xmltv_guide_start');
                if (this.owner !== owner) return;
                if (reply?.state === 'ready') {
                    this.truncated = !!reply.truncated;
                    this.channelCount = reply.channelCount ?? 0;
                    this.memoAt = Date.now();
                    this.state = 'ready';
                    return;
                }
                if (reply?.state === 'error' || Date.now() - began > GIVE_UP_MS) return fail();
                await new Promise((resolve) => setTimeout(resolve, POLL_MS));
            }
        } catch {
            fail();
        }
    }

    /** Loads `first` plus the next channels of the same scope that are not loaded yet. */
    private fill(
        credentials: XtreamCredentials,
        first: string,
        scope: readonly (string | null | undefined)[]
    ): Promise<void> {
        const ids = [first];
        for (const candidate of scope) {
            if (ids.length >= CHUNK) break;
            const id = candidate?.trim();
            if (!id) continue;
            const key = id.toLowerCase();
            if (key === first.toLowerCase() || this.memo.has(key) || this.absent.has(key) || this.loading.has(key)) continue;
            ids.push(id);
        }
        const work = this.read(credentials, ids).finally(() => {
            for (const id of ids) this.loading.delete(id.toLowerCase());
        });
        for (const id of ids) this.loading.set(id.toLowerCase(), work);
        return work;
    }

    private async read(credentials: XtreamCredentials, ids: string[]): Promise<void> {
        try {
            this.requests++;
            const reply = await this.api().xmltvGuide(credentials, 'xmltv_guide_read', ids);
            if (reply?.state !== 'ready') return;
            this.truncated = !!reply.truncated;
            const channels = reply.channels ?? {};
            const byKey = new Map(Object.entries(channels).map(([id, rows]) => [id.toLowerCase(), { id, rows }]));
            for (const id of ids) {
                const key = id.toLowerCase();
                const hit = byKey.get(key);
                if (hit) this.memo.set(key, hit.rows.map((row) => toItem(hit.id, row)));
                else this.absent.add(key);
            }
        } catch {
            this.failedUntil = Date.now() + RETRY_AFTER_FAILURE_MS;
        }
    }

    /** Works through the rest of the scope in the background, so lookups find it ready. */
    private async prefetch(
        credentials: XtreamCredentials,
        scope: readonly (string | null | undefined)[]
    ): Promise<void> {
        if (this.prefetching || this.state !== 'ready') return;
        this.prefetching = true;
        try {
            for (const candidate of scope) {
                const id = candidate?.trim();
                if (!id) continue;
                const key = id.toLowerCase();
                if (this.memo.has(key) || this.absent.has(key) || this.loading.has(key)) continue;
                if (Date.now() < this.failedUntil || this.state !== 'ready') return;
                await this.fill(credentials, id, scope);
            }
        } finally {
            this.prefetching = false;
        }
    }
}
