import type {
    XtreamApiService,
    XtreamCredentials,
} from '@iptvnator/portal/xtream/data-access';
import type { EpgItem } from '@iptvnator/shared/interfaces';

/** Matching channels by name when their id is not in the file. Switch: localStorage['guide-bulk-names'] = 'off'. */
function nameMatchEnabled(): boolean {
    try {
        return localStorage.getItem('guide-bulk-names') !== 'off';
    } catch {
        return true;
    }
}

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
/** A channel of the scope: its guide id and its name (for matching by name when the id is not in the file). */
export type BulkScopeEntry = { epg: string | null | undefined; name: string | undefined };

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
    private lastError = '';
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
            error: this.lastError,
            retryInMs: Math.max(0, this.failedUntil - Date.now()),
        });
    }

    /** Schedules of the guide window, or `undefined` to use the per-channel request instead. */
    async lookup(
        credentials: XtreamCredentials,
        epgChannelId: string | null | undefined,
        scope: () => readonly BulkScopeEntry[],
        background: boolean,
        channelName?: string
    ): Promise<EpgItem[] | undefined> {
        const id = epgChannelId?.trim();
        if (!id || !bulkGuideEnabled() || Date.now() < this.failedUntil) return undefined;
        this.ensure(credentials);
        // While the file is still coming, wait (rows on screen briefly, the background scan longer)
        // rather than judging channels by the slow per-channel answers: those would mark channels
        // the file covers as "no guide".
        if (this.state === 'starting') await this.settled(credentials, undefined, background ? 90_000 : 15_000);
        if (this.state !== 'ready') return undefined;
        if (Date.now() - this.memoAt > MEMO_MS) this.expire(credentials);
        const key = id.toLowerCase();
        if (!this.memo.has(key) && !this.absent.has(key)) {
            await (this.loading.get(key) ?? this.fill(credentials, { epg: id, name: channelName }, scope()));
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
        let polls = 0;
        const fail = (why: string) => {
            if (this.owner !== owner) return;
            this.lastError = why;
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
                    this.lastError = '';
                    return;
                }
                if (reply?.state === 'error') return fail(reply.error || 'error');
                if (Date.now() - began > GIVE_UP_MS) return fail('took too long');
                // Quick first checks (a copy that is already built answers at once), then slower.
                await new Promise((resolve) => setTimeout(resolve, ++polls < 5 ? 600 : POLL_MS));
            }
        } catch (e) {
            fail('request failed: ' + (e instanceof Error ? e.message : String(e)).slice(0, 60));
        }
    }

    /** Loads `first` plus the next channels of the same scope that are not loaded yet. */
    private fill(
        credentials: XtreamCredentials,
        first: BulkScopeEntry,
        scope: readonly BulkScopeEntry[]
    ): Promise<void> {
        const firstKey = first.epg?.trim().toLowerCase();
        const entries: BulkScopeEntry[] = [first];
        for (const candidate of scope) {
            if (entries.length >= CHUNK) break;
            const key = candidate.epg?.trim().toLowerCase();
            if (!key || key === firstKey || this.memo.has(key) || this.absent.has(key) || this.loading.has(key)) continue;
            entries.push(candidate);
        }
        const work = this.read(credentials, entries).finally(() => {
            for (const entry of entries) {
                const key = entry.epg?.trim().toLowerCase();
                if (key) this.loading.delete(key);
            }
        });
        for (const entry of entries) {
            const key = entry.epg?.trim().toLowerCase();
            if (key) this.loading.set(key, work);
        }
        return work;
    }

    private async read(credentials: XtreamCredentials, entries: BulkScopeEntry[]): Promise<void> {
        try {
            const api = this.api();
            this.requests++;
            const ids = entries.map((entry) => entry.epg!.trim());
            const reply = await api.xmltvGuide(credentials, 'xmltv_guide_read', ids);
            if (reply?.state !== 'ready') return;
            this.truncated = !!reply.truncated;
            const byKey = new Map(
                Object.entries(reply.channels ?? {}).map(([id, rows]) => [id.toLowerCase(), { id, rows }])
            );
            const missing: BulkScopeEntry[] = [];
            for (const entry of entries) {
                const id = entry.epg!.trim();
                const hit = byKey.get(id.toLowerCase());
                if (hit) this.memo.set(id.toLowerCase(), hit.rows.map((row) => toItem(hit.id, row)));
                else missing.push(entry);
            }
            // Not under that id in the file: try the channel's name (a playlist can name a channel
            // "USA Go Traveler" where the file has "Go Traveler" under another id).
            const named = missing.filter((entry) => entry.name?.trim());
            let byName: NonNullable<typeof reply.byName> = {};
            if (named.length && nameMatchEnabled()) {
                this.requests++;
                const second = await api.xmltvGuide(credentials, 'xmltv_guide_read', [], undefined, named.map((entry) => entry.name!.trim()));
                byName = second?.byName ?? {};
            }
            for (const entry of missing) {
                const id = entry.epg!.trim();
                const rows = entry.name ? byName[entry.name.trim()] : undefined;
                if (rows) this.memo.set(id.toLowerCase(), rows.map((row) => toItem(id, row)));
                else this.absent.add(id.toLowerCase());
            }
        } catch {
            this.failedUntil = Date.now() + RETRY_AFTER_FAILURE_MS;
        }
    }

    /** Works through the rest of the scope in the background, so lookups find it ready. */
    private async prefetch(
        credentials: XtreamCredentials,
        scope: readonly BulkScopeEntry[]
    ): Promise<void> {
        if (this.prefetching || this.state !== 'ready') return;
        this.prefetching = true;
        try {
            for (const candidate of scope) {
                const key = candidate.epg?.trim().toLowerCase();
                if (!key) continue;
                if (this.memo.has(key) || this.absent.has(key) || this.loading.has(key)) continue;
                if (Date.now() < this.failedUntil || this.state !== 'ready') return;
                await this.fill(credentials, candidate, scope);
            }
        } finally {
            this.prefetching = false;
        }
    }

    /**
     * Resolves once the guide file is ready or has failed (or after `waitMs`), so the "has a guide"
     * scan does not judge channels by the slow per-channel answers while the file is still coming.
     */
    async settled(credentials: XtreamCredentials, signal?: AbortSignal, waitMs = 90_000): Promise<void> {
        if (!bulkGuideEnabled() || Date.now() < this.failedUntil) return;
        this.ensure(credentials);
        const began = Date.now();
        while (this.state === 'starting' && Date.now() - began < waitMs) {
            signal?.throwIfAborted();
            await new Promise((resolve) => setTimeout(resolve, 300));
        }
    }
}
