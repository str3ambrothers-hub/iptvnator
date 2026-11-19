/**
 * "Streaming" categories (Netflix, Disney+, ...) added on top of the provider's
 * genre categories. Titles are matched by TMDB id against lists that the APK
 * build downloads from TMDB and bundles as `assets/streaming/streaming.json`,
 * so the device needs no key and makes no request to TMDB. A title can be in
 * its provider category and in a service category at once.
 *
 * Active in the TV shell only (its `tv.js` puts the `tv-shell` class on
 * `<html>`). Kill switch: `localStorage['streaming-groups'] = 'off'`.
 */

export const STREAMING_SHELL_CLASS = 'tv-shell';
export const STREAMING_KILL_SWITCH_KEY = 'streaming-groups';
/** Service categories get ids from here up, far above any provider's. */
export const STREAMING_CATEGORY_ID_BASE = 990_000;

export interface StreamingServiceFile {
    readonly region?: string;
    readonly generatedAt?: string;
    readonly services: readonly {
        readonly name: string;
        readonly movie: readonly number[];
        readonly tv: readonly number[];
    }[];
}

export type StreamingContentType = 'vod' | 'series';

interface StreamingGroup {
    readonly id: number;
    readonly name: string;
    readonly members: ReadonlySet<number>;
}

/** The TMDB id of a catalogue row, or null when it has none. */
export function tmdbIdOf(item: unknown): number | null {
    if (!item || typeof item !== 'object') return null;
    const row = item as { tmdb?: unknown; tmdb_id?: unknown };
    const value = Number(row.tmdb ?? row.tmdb_id);
    return Number.isInteger(value) && value > 0 ? value : null;
}

export function isStreamingGroupsEnabled(doc: Document | null): boolean {
    if (!doc?.documentElement?.classList.contains(STREAMING_SHELL_CLASS)) {
        return false;
    }
    try {
        return (
            doc.defaultView?.localStorage?.getItem(STREAMING_KILL_SWITCH_KEY) !==
            'off'
        );
    } catch {
        return true;
    }
}

export class StreamingGroups {
    private groups: Record<StreamingContentType, StreamingGroup[]> = {
        vod: [],
        series: [],
    };
    private loading: Promise<void> | null = null;

    /** Replaces the groups with those of `file`; services with no titles are dropped. */
    apply(file: StreamingServiceFile | null | undefined): void {
        const next: Record<StreamingContentType, StreamingGroup[]> = {
            vod: [],
            series: [],
        };
        (file?.services ?? []).forEach((service, index) => {
            const id = STREAMING_CATEGORY_ID_BASE + index;
            const movies = new Set(service.movie ?? []);
            const shows = new Set(service.tv ?? []);
            if (movies.size) next.vod.push({ id, name: service.name, members: movies });
            if (shows.size) next.series.push({ id, name: service.name, members: shows });
        });
        this.groups = next;
    }

    /** Fetches the bundled lists once; a missing or damaged file means no groups. */
    load(fetcher: () => Promise<StreamingServiceFile | null>): Promise<void> {
        this.loading ??= fetcher().then(
            (file) => this.apply(file),
            () => undefined
        );
        return this.loading;
    }

    categories(type: StreamingContentType) {
        return this.groups[type].map((group) => ({
            category_id: String(group.id),
            category_name: group.name,
            parent_id: 0,
        }));
    }

    isStreamingCategory(categoryId: number): boolean {
        return categoryId >= STREAMING_CATEGORY_ID_BASE;
    }

    /** True when `item` belongs to the service category `categoryId` for `type`. */
    includes(type: StreamingContentType, categoryId: number, item: unknown): boolean {
        const group = this.groups[type].find((g) => g.id === categoryId);
        if (!group) return false;
        const id = tmdbIdOf(item);
        return id !== null && group.members.has(id);
    }

    /** Adds each service's item count to `counts` (keyed by category id). */
    addCounts(
        type: StreamingContentType,
        items: readonly unknown[],
        counts: Map<number, number>
    ): void {
        const groups = this.groups[type];
        if (!groups.length) return;
        for (const item of items) {
            const id = tmdbIdOf(item);
            if (id === null) continue;
            for (const group of groups) {
                if (group.members.has(id)) {
                    counts.set(group.id, (counts.get(group.id) ?? 0) + 1);
                }
            }
        }
    }
}

/** One shared instance: the data source fills it, the selection store reads it. */
export const streamingGroups = new StreamingGroups();

export async function fetchStreamingFile(
    doc: Document
): Promise<StreamingServiceFile | null> {
    const response = await fetch(
        new URL('assets/streaming/streaming.json', doc.baseURI).toString()
    );
    if (!response.ok) return null;
    const file = (await response.json()) as StreamingServiceFile;
    return Array.isArray(file?.services) ? file : null;
}
