import {
    computed,
    DestroyRef,
    effect,
    inject,
    Injectable,
    signal,
    untracked,
} from '@angular/core';
import { createDevLogger, EpgProgram } from '@iptvnator/shared/interfaces';
import {
    changedCoverage,
    createCoverageRefreshBudget,
    NO_PROGRAMMES,
    type CoverageCheck,
    type CoverageScan,
} from './epg-guide-coverage-refresh';
import {
    EPG_GUIDE_SOURCE,
    EpgGuideChannel,
    EpgGuideWindow,
} from './epg-guide-source';

/** Channels per `loadPrograms` call (the programme IPC caps at 100 keys). */
export const EPG_GUIDE_LOAD_CHUNK = 100;
/** TV app: channels whose programmes stay loaded after they scroll away (switch: `guide-keep`). */
const KEPT_ROWS = 1500;

function keepLoaded(): boolean {
    try {
        return (
            document.documentElement.classList.contains('tv-shell') &&
            localStorage.getItem('guide-keep') !== 'off'
        );
    } catch {
        return false;
    }
}

/**
 * Channels per `loadCoverage` call. Deliberately half the IPC's 2000-key cap:
 * it leaves headroom for the host to append keys to the same request (e.g. a
 * scope change mid-flight) without immediately needing a second chunk and a
 * new round-trip contract.
 */
export const EPG_GUIDE_COVERAGE_CHUNK = 1000;

export type EpgGuideRowStatus =
    'idle' | 'loading' | 'loaded' | 'none' | 'error';
type RowScheduleStatus = EpgGuideRowStatus | 'stale';

const EMPTY: readonly EpgProgram[] = [];
const COVERAGE_BATCH_MS = 200;
const ROW_RETRY_MS = 30_000;

const debugEpgGuidePrograms = createDevLogger('EpgGuideProgramsService');

/** A channel is only ever requested when it carries a real, non-blank key. */
function hasEpgKey(channel: EpgGuideChannel): boolean {
    return (
        typeof channel.epgKey === 'string' && channel.epgKey.trim().length > 0
    );
}

/**
 * Per-day programme cache for the guide. Programmes load lazily for the rows
 * the viewport asks about. Coverage checks the whole scope, on demand for
 * per-stream providers. Window, scope and source changes abort old reads.
 */
@Injectable()
export class EpgGuideProgramsService {
    private readonly source = inject(EPG_GUIDE_SOURCE);

    private readonly programs = signal<
        ReadonlyMap<string, readonly EpgProgram[]>
    >(new Map());
    private readonly statuses = signal<ReadonlyMap<string, RowScheduleStatus>>(
        new Map()
    );
    private readonly coverage = signal<ReadonlyMap<
        string,
        CoverageCheck
    > | null>(null);

    private range: { fromMs: number; toMs: number } | null = null;
    private readonly programRequests = new Map<
        AbortController,
        EpgGuideChannel[]
    >();
    private coverageRequest?: CoverageScan;
    private coverageRequested = false;
    private readonly failedCoverage = new Set<string>();
    private readonly coverageRefresh = createCoverageRefreshBudget(
        this.failedCoverage
    );
    private readonly rowExpiry = new Map<string, number>();
    private visibleRows = new Set<string>();
    /** Last channel reference seen by the constructor effect (see below). */
    private seenChannels: readonly EpgGuideChannel[] | null = null;
    private seenRevision: unknown;

    readonly coverageLoaded = computed(() => this.coverage() !== null);
    readonly coverageStatus = signal<'idle' | 'loading' | 'error'>('idle');

    /** Scan results waiting to be written in one go (TV app), see `queueStore`. */
    private queuedStores: Array<[string, readonly EpgProgram[]]> = [];
    private queueTimer: ReturnType<typeof setTimeout> | undefined;

    constructor() {
        inject(DestroyRef).onDestroy(() => {
            this.cancelProgramRequests();
            this.cancelCoverageRequest();
            this.dropQueuedStores();
            const host = window as unknown as { __tvGuideStats?: unknown };
            if (host.__tvGuideStats === this.statsFn) delete host.__tvGuideStats;
        });
        if (keepLoaded())
            (window as unknown as { __tvGuideStats?: unknown }).__tvGuideStats =
                this.statsFn;
        // A new channel set (scope change) invalidates everything, including
        // coverage: the toggle must be answered for the new rows. The first
        // effect run must NOT invalidate: a host can call `setWindow` (and
        // thus `ensureLoaded`) before the initial change-detection flush, and
        // invalidating here would bump the generation and drop that
        // in-flight request's answer along with any coverage it kicked off.
        effect(() => {
            const next = this.source.channels();
            const revision = this.source.revision?.();
            if (next === this.seenChannels && revision === this.seenRevision)
                return;
            const first = this.seenChannels === null;
            this.seenChannels = next;
            this.seenRevision = revision;
            if (first) return;
            this.invalidate();
            this.requestCoverage();
        });
        if (this.source.recoveredPrograms) {
            effect(() => {
                const id = this.source.activeChannelId();
                if (!this.canRecover(id) || !id || !this.range) return;
                const recovered = this.source.recoveredPrograms?.(this.range);
                if (recovered)
                    untracked(() => this.storePrograms([[id, recovered]]));
            });
        }
    }

    setCoverageRequested(requested: boolean): void {
        if (
            !this.source.deferredCoverage ||
            requested === this.coverageRequested
        )
            return;
        this.coverageRequested = requested;
        if (requested) this.requestCoverage();
        else {
            this.cancelCoverageRequest();
            this.coverageStatus.set('idle');
        }
    }

    setWindow(fromMs: number, toMs: number): void {
        if (this.range?.fromMs === fromMs && this.range?.toMs === toMs) return;
        this.range = { fromMs, toMs };
        this.invalidate();
        this.requestCoverage();
    }

    programsFor(channelId: string): readonly EpgProgram[] {
        return this.programs().get(channelId) ?? EMPTY;
    }

    statusFor(channelId: string): EpgGuideRowStatus {
        const status = this.statuses().get(channelId);
        return status === 'stale' ? 'loaded' : (status ?? 'idle');
    }

    private readonly statsFn = () => ({
        channels: this.source.channels().length,
        loaded: this.programs().size,
        visible: this.visibleRows.size,
        requests: this.programRequests.size,
        scanning: this.coverageStatus() === 'loading',
        scanned: this.coverage()?.size ?? 0,
        queued: this.queuedStores.length,
    });

    /**
     * Scan results for channels not on screen are written together every 300 ms instead of one by
     * one: each write copies the whole list of loaded channels and redraws, so this keeps the guide
     * smooth. Requests are unchanged. Rows on screen are still written at once.
     */
    private queueStore(id: string, programs: readonly EpgProgram[]): void {
        this.queuedStores.push([id, programs]);
        this.queueTimer ??= setTimeout(() => {
            this.queueTimer = undefined;
            const batch = this.queuedStores;
            this.queuedStores = [];
            if (batch.length) this.storePrograms(batch);
        }, 300);
    }

    private dropQueuedStores(): void {
        clearTimeout(this.queueTimer);
        this.queueTimer = undefined;
        this.queuedStores = [];
    }

    /** TV app: a scanned channel that is not on screen yet is kept, so scrolling to it shows it at once. */
    private canKeepAhead(id: string): boolean {
        return (
            keepLoaded() &&
            !this.visibleRows.has(id) &&
            this.statuses().get(id) !== 'loaded'
        );
    }

    /** Keep at most KEPT_ROWS loaded channels; drop the oldest ones that are not on screen. */
    private trimKept(): void {
        const programs = this.programs();
        if (programs.size <= KEPT_ROWS) return;
        const next = new Map(programs);
        const statuses = new Map(this.statuses());
        for (const id of programs.keys()) {
            if (next.size <= KEPT_ROWS) break;
            if (this.visibleRows.has(id)) continue;
            next.delete(id);
            if (statuses.get(id) !== 'none') statuses.delete(id);
            this.rowExpiry.delete(id);
        }
        this.programs.set(next);
        this.statuses.set(statuses);
    }

    private canRecover(id: string | null): boolean {
        const status = this.statuses().get(id ?? '');
        return (
            !!id &&
            (status === 'error' || status === 'stale') &&
            this.visibleRows.has(id)
        );
    }

    /** Unknown (coverage not loaded yet, or a chunk failed) counts as covered
     * so rows never blink. */
    isCovered(channelId: string): boolean {
        return this.coverage()?.get(channelId)?.hasPrograms !== false;
    }

    refreshExpiredCoverage(nowMs: number): void {
        const checks = this.coverage();
        if (!this.coverageRequested || this.coverageRequest || !checks) return;
        const scope = this.source.channels();
        const expired = this.coverageRefresh.collect(nowMs, scope, checks);
        if (expired.length) this.requestCoverage(expired);
    }

    /** Request programmes for rows that are idle, discarding obsolete per-stream work. */
    ensureLoaded(channels: readonly EpgGuideChannel[]): void {
        const range = this.range;
        if (!range) return;
        const previousRows = this.visibleRows;
        const visible = new Set(channels.map((channel) => channel.id));
        this.visibleRows = visible;
        if (this.source.programBatchSize) {
            for (const [request, rows] of this.programRequests) {
                if (rows.some((row) => visible.has(row.id))) continue;
                request.abort();
                this.programRequests.delete(request);
                if (keepLoaded()) {
                    // Cancelled before it finished: forget "loading" so the row asks again later.
                    const statuses = new Map(this.statuses());
                    for (const row of rows)
                        if (statuses.get(row.id) === 'loading')
                            statuses.delete(row.id);
                    this.statuses.set(statuses);
                }
            }
            const departed = keepLoaded()
                ? []
                : [...previousRows].filter((id) => !visible.has(id));
            if (keepLoaded()) this.trimKept();
            if (departed.length) {
                const programs = new Map(this.programs());
                const statuses = new Map(this.statuses());
                for (const id of departed) {
                    programs.delete(id);
                    if (statuses.get(id) !== 'none') statuses.delete(id);
                    this.rowExpiry.delete(id);
                }
                this.programs.set(programs);
                this.statuses.set(statuses);
            }
        }
        const now = Date.now();
        const pending = channels.filter((channel) => {
            const status = this.statusFor(channel.id);
            return (
                hasEpgKey(channel) &&
                (status === 'idle' ||
                    (status === 'loaded' &&
                        (this.rowExpiry.get(channel.id) ?? Infinity) <= now) ||
                    (status === 'error' && !previousRows.has(channel.id)))
            );
        });
        if (!pending.length) return;
        this.patchStatuses(pending.map((channel) => [channel.id, 'loading']));
        const batchSize = this.source.programBatchSize ?? EPG_GUIDE_LOAD_CHUNK;
        for (let start = 0; start < pending.length; start += batchSize) {
            const chunk = pending.slice(start, start + batchSize);
            const request = new AbortController();
            this.programRequests.set(request, chunk);
            this.loadChunk(
                { channels: chunk, ...range, signal: request.signal },
                request
            );
        }
    }

    private loadChunk(
        request: EpgGuideWindow,
        controller: AbortController
    ): void {
        this.source
            .loadPrograms(request)
            .then(
                (result) => result,
                () => {
                    if (!controller.signal.aborted)
                        debugEpgGuidePrograms(
                            'loadPrograms failed for a chunk',
                            { channelCount: request.channels.length }
                        );
                    return null;
                }
            )
            .then((result) => {
                this.programRequests.delete(controller);
                if (controller.signal.aborted) return;
                this.storePrograms(
                    request.channels
                        .filter(
                            ({ id }) =>
                                !this.source.programBatchSize ||
                                this.visibleRows.has(id)
                        )
                        .map(({ id }) => [id, result?.get(id)]),
                    result ?? []
                );
            });
    }

    private storePrograms(
        entries: ReadonlyArray<
            readonly [string, readonly EpgProgram[] | undefined]
        >,
        coverageEntries: Iterable<
            readonly [string, readonly EpgProgram[] | undefined]
        > = entries
    ): void {
        const next = new Map(this.programs());
        const statuses = new Map(this.statuses());
        for (const [id, programs] of entries) {
            if (programs) next.set(id, programs);
            const retry = !programs && this.rowExpiry.has(id);
            const expiresAt = retry
                ? Date.now() + ROW_RETRY_MS
                : programs && this.source.programsExpireAt?.(id);
            if (expiresAt !== undefined) this.rowExpiry.set(id, expiresAt);
            statuses.set(id, programs ? 'loaded' : retry ? 'stale' : 'error');
        }
        this.programs.set(next);
        this.statuses.set(statuses);
        if (!this.source.deferredCoverage) return;
        const checks = this.coverage();
        const scan = this.coverageRequest;
        let updated: Map<string, CoverageCheck> | undefined;
        for (const [id, programs] of coverageEntries) {
            if (!programs) continue;
            const hasPrograms = programs.length > 0;
            if (scan?.progress) {
                this.reportCoverage(scan, id, hasPrograms);
            } else if (checks) {
                if (this.failedCoverage.delete(id) && !this.failedCoverage.size)
                    this.coverageStatus.set('idle');
                const check = changedCoverage(
                    checks.get(id),
                    hasPrograms,
                    this.source.programsExpireAt?.(id) ?? Infinity
                );
                if (check) (updated ??= new Map(checks)).set(id, check);
            }
        }
        if (updated) this.coverage.set(updated);
    }

    private reportCoverage(
        scan: CoverageScan,
        id: string,
        hasPrograms: boolean | null
    ): void {
        const progress = scan.progress;
        if (!progress) return;
        if (hasPrograms === null) {
            if (progress.confirmed.has(id)) return;
            this.failedCoverage.add(id);
            if (!progress.checks.delete(id)) return;
        } else {
            progress.confirmed.add(id);
            this.failedCoverage.delete(id);
            const check = changedCoverage(
                progress.checks.get(id),
                hasPrograms,
                this.source.programsExpireAt?.(id) ?? Infinity
            );
            if (!check) return;
            progress.checks.set(id, check);
        }
        progress.timer ??= setTimeout(() => {
            progress.timer = undefined;
            this.coverage.set(new Map(progress.checks));
        }, COVERAGE_BATCH_MS);
    }

    private requestCoverage(recheck?: readonly EpgGuideChannel[]): void {
        const range = this.range;
        if (!range || (this.source.deferredCoverage && !this.coverageRequested))
            return;
        const request = new AbortController();
        const scan: CoverageScan = { controller: request };
        if (this.source.deferredCoverage) {
            scan.progress = {
                confirmed: new Set(),
                checks: new Map(recheck ? this.coverage() : null),
            };
            if (!recheck) this.coverage.set(null);
        }
        this.coverageRequest = scan;
        this.coverageStatus.set('loading');
        const channels = recheck ?? this.source.channels();
        const keyed = channels.filter(hasEpgKey);
        const chunks: EpgGuideChannel[][] = [];
        for (
            let start = 0;
            start < keyed.length;
            start += EPG_GUIDE_COVERAGE_CHUNK
        ) {
            chunks.push(keyed.slice(start, start + EPG_GUIDE_COVERAGE_CHUNK));
        }
        Promise.all(
            chunks.map((channels) =>
                this.source
                    .loadCoverage(
                        {
                            channels,
                            ...range,
                            signal: request.signal,
                            focusId: () => this.visibleRows.values().next().value,
                        },
                        (id, programs) => {
                            if (request.signal.aborted) return;
                            this.reportCoverage(
                                scan,
                                id,
                                programs && programs.length > 0
                            );
                            if (programs && this.canRecover(id))
                                this.storePrograms([[id, programs]]);
                            else if (programs && this.canKeepAhead(id))
                                this.queueStore(id, programs);
                        }
                    )
                    .catch(() => {
                        if (!request.signal.aborted)
                            for (const { id } of channels)
                                this.reportCoverage(scan, id, null);
                        return null;
                    })
            )
        ).then((sets) => {
            if (request.signal.aborted) return;
            this.coverageRequest = undefined;
            clearTimeout(scan.progress?.timer);
            if (sets.some((set) => set === null)) {
                if (scan.progress) this.coverage.set(scan.progress.checks);
                debugEpgGuidePrograms(
                    'loadCoverage failed for a chunk; leaving coverage unknown',
                    { chunkCount: sets.length }
                );
                this.coverageStatus.set('error');
                return;
            }
            const merged = new Set<string>();
            for (const set of sets) set?.forEach((id) => merged.add(id));
            const checks =
                scan.progress?.checks ?? new Map<string, CoverageCheck>();
            for (const { id } of channels) {
                if (scan.progress?.confirmed.has(id)) continue;
                if (merged.has(id)) checks.delete(id);
                else checks.set(id, NO_PROGRAMMES);
            }
            this.coverage.set(checks);
            this.coverageStatus.set(
                this.failedCoverage.size ? 'error' : 'idle'
            );
        });
    }

    private invalidate(): void {
        this.dropQueuedStores();
        this.cancelProgramRequests();
        this.rowExpiry.clear();
        this.visibleRows.clear();
        this.cancelCoverageRequest();
        this.coverageStatus.set('idle');
        this.programs.set(new Map());
        this.statuses.set(
            new Map(
                this.source
                    .channels()
                    .filter((channel) => !hasEpgKey(channel))
                    .map((channel) => [channel.id, 'none' as const])
            )
        );
        this.coverage.set(null);
    }

    private cancelCoverageRequest(): void {
        this.coverageRequest?.controller.abort();
        clearTimeout(this.coverageRequest?.progress?.timer);
        this.coverageRequest = undefined;
        this.coverageRefresh.reset();
        this.failedCoverage.clear();
    }

    private cancelProgramRequests(): void {
        this.programRequests.forEach((_rows, controller) => controller.abort());
        this.programRequests.clear();
    }

    private patchStatuses(entries: Array<[string, EpgGuideRowStatus]>): void {
        const next = new Map(this.statuses());
        for (const [id, status] of entries) next.set(id, status);
        this.statuses.set(next);
    }
}
