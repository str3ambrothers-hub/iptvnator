import { EpgProgram } from '@iptvnator/shared/interfaces';

const CONCURRENT_REQUESTS = 2;
/** The whole-category "has EPG" scan may never take the last slot, so the rows on screen are always served first. */
const BACKGROUND_REQUESTS = CONCURRENT_REQUESTS - 1;
const REQUEST_PAUSE_MS = 200;
const CACHED_STREAMS = 256;
// TV app: the scan runs wider and faster so channels are already loaded by the time you scroll to
// them (kill switch: localStorage['guide-prefetch'] = 'off').
const TV_CONCURRENT_REQUESTS = 4;
const TV_BACKGROUND_REQUESTS = 3;
const TV_REQUEST_PAUSE_MS = 100;
const TV_CACHED_STREAMS = 1500;

function tvPrefetch(): boolean {
    try {
        return (
            globalThis.document?.documentElement.classList.contains(
                'tv-shell'
            ) === true && globalThis.localStorage?.getItem('guide-prefetch') !== 'off'
        );
    } catch {
        return false;
    }
}
const SCHEDULE_TTL_MS = 5 * 60_000;

type FetchSchedule<T> = (options: {
    signal: AbortSignal;
    sessionId?: string;
}) => Promise<T>;

interface PendingSchedule<T> {
    readonly work: Promise<T>;
    readonly abort: () => void;
    consumers: number;
}

function waitFor<T>(
    work: Promise<T>,
    signals: readonly AbortSignal[]
): Promise<T> {
    let abort!: (event: Event) => void;
    return new Promise<T>((resolve, reject) => {
        abort = (event) => reject((event.target as AbortSignal).reason);
        work.then(resolve, reject);
        const retired = signals.find((signal) => signal.aborted);
        if (retired) reject(retired.reason);
        else
            signals.forEach((signal) =>
                signal.addEventListener('abort', abort, { once: true })
            );
    }).finally(() =>
        signals.forEach((signal) => signal.removeEventListener('abort', abort))
    );
}

/** The guide can scan an entire portal without retaining every schedule. */
export class XtreamGuideScheduleCache<T = EpgProgram[]> {
    private readonly cached = new Map<
        string,
        { value: T; expiresAt: number }
    >();
    private readonly pending = new Map<string, PendingSchedule<T>>();
    private readonly slots = new Set<Promise<void>>();
    private controller = new AbortController();
    private foregroundWaiting = 0;
    private readonly prefetch = tvPrefetch();
    private readonly concurrent = tvPrefetch()
        ? TV_CONCURRENT_REQUESTS
        : CONCURRENT_REQUESTS;
    private readonly background = tvPrefetch()
        ? TV_BACKGROUND_REQUESTS
        : BACKGROUND_REQUESTS;
    private readonly pauseMs = tvPrefetch()
        ? TV_REQUEST_PAUSE_MS
        : REQUEST_PAUSE_MS;
    private readonly maxCached = tvPrefetch()
        ? TV_CACHED_STREAMS
        : CACHED_STREAMS;

    constructor(
        private readonly cancelTransport: (sessionId: string) => void
    ) {
        if (tvPrefetch())
            (globalThis as { __tvGuideCache?: unknown }).__tvGuideCache = () => ({
                cached: this.cached.size,
                running: this.slots.size,
                waiting: Math.max(0, this.pending.size - this.slots.size),
            });
    }

    clear(): void {
        this.controller.abort();
        for (const entry of this.pending.values()) entry.abort();
        this.controller = new AbortController();
        this.cached.clear();
        this.pending.clear();
    }

    expiresAt(id: string): number {
        return this.cached.get(id)?.expiresAt ?? 0;
    }

    /** Stores a schedule that did not need a request (read from the whole-guide file). */
    put(id: string, value: T): void {
        this.cached.delete(id);
        this.cached.set(id, { value, expiresAt: Date.now() + SCHEDULE_TTL_MS });
        if (this.cached.size > this.maxCached) {
            const oldest = this.cached.keys().next().value;
            if (oldest !== undefined) this.cached.delete(oldest);
        }
    }

    peek(id: string): T | undefined {
        const cached = this.cached.get(id);
        return cached && cached.expiresAt > Date.now()
            ? cached.value
            : undefined;
    }

    async load(
        id: string,
        checkCurrent: () => void,
        fetch: FetchSchedule<T>,
        consumer?: AbortSignal,
        background = false
    ): Promise<T> {
        const signals = consumer
            ? [this.controller.signal, consumer]
            : [this.controller.signal];
        for (;;) {
            signals.forEach((signal) => signal.throwIfAborted());
            checkCurrent();
            const cached = this.cached.get(id);
            if (cached) {
                this.cached.delete(id);
                if (cached.expiresAt > Date.now()) {
                    this.cached.set(id, cached);
                    return cached.value;
                }
            }
            const entry = this.pending.get(id);
            if (entry) return this.consume(id, entry, signals);
            const limit = background ? this.background : this.concurrent;
            // TV app: the scan steps aside while rows on screen are waiting for a connection.
            const yielding = background && this.prefetch && this.foregroundWaiting > 0;
            if (this.slots.size < limit && !yielding)
                return this.consume(id, this.start(id, fetch), signals);
            if (background) {
                await waitFor(
                    Promise.race([
                        ...this.slots,
                        new Promise<void>((resolve) => setTimeout(resolve, 150)),
                    ]),
                    signals
                );
                continue;
            }
            this.foregroundWaiting++;
            try {
                await waitFor(Promise.race([...this.slots]), signals);
            } finally {
                this.foregroundWaiting--;
            }
        }
    }

    private start(id: string, fetch: FetchSchedule<T>): PendingSchedule<T> {
        const controller = new AbortController();
        const sessionId = globalThis.crypto.randomUUID?.();
        // A cancelled consumer cannot settle native IPC that already started.
        const work = fetch({ signal: controller.signal, sessionId });
        const entry: PendingSchedule<T> = {
            work,
            consumers: 0,
            abort: () => {
                if (controller.signal.aborted) return;
                controller.abort();
                if (sessionId) this.cancelTransport(sessionId);
            },
        };
        this.pending.set(id, entry);
        const slot = work
            .then(
                (programs) => this.finish(id, entry, programs),
                () => this.finish(id, entry)
            )
            .then(() => this.pause())
            .finally(() => this.slots.delete(slot));
        this.slots.add(slot);
        return entry;
    }

    private async consume(
        id: string,
        entry: PendingSchedule<T>,
        signals: readonly AbortSignal[]
    ): Promise<T> {
        entry.consumers++;
        try {
            return await waitFor(entry.work, signals);
        } finally {
            if (--entry.consumers === 0 && this.pending.get(id) === entry) {
                this.pending.delete(id);
                entry.abort();
            }
        }
    }

    private finish(id: string, entry: PendingSchedule<T>, value?: T): void {
        if (this.pending.get(id) !== entry) return;
        this.pending.delete(id);
        if (value === undefined) return;
        this.cached.set(id, {
            value,
            expiresAt: Date.now() + SCHEDULE_TTL_MS,
        });
        if (this.cached.size > this.maxCached) {
            const oldest = this.cached.keys().next().value;
            if (oldest !== undefined) this.cached.delete(oldest);
        }
    }

    private pause(): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, this.pauseMs));
    }
}
