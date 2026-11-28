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
/**
 * A service's genre list: one entry per genre that holds some of its titles, with the id
 * `GENRE_ID_BASE + serviceIndex * GENRE_ID_STRIDE + genreBit`.
 * Numeric ids ride the existing routing, selection and filtering unchanged.
 */
/** Entries the category list adds for navigating: back to the platforms, and the provider's other categories. */
export const STREAMING_BACK_ID = 989_998;
export const STREAMING_OTHER_ID = 989_999;
export const STREAMING_GENRE_ID_BASE = 1_000_000_000;
export const STREAMING_GENRE_ID_STRIDE = 1_000_000;

/** The app's genres, in the bit order of the lists the build writes (see fetch-streaming-lists.mjs). */
export const STREAMING_GENRES = [
    'Action', 'Adventure', 'Animation', 'Anime', 'Comedy', 'Crime', 'Documentary', 'Drama',
    'Family', 'Fantasy', 'History', 'Horror', 'Music', 'Mystery', 'Romance', 'Sci-Fi',
    'Thriller', 'War', 'Western', 'Reality & Talk', 'Kids',
] as const;
/** Order the genres are listed in under a service: Kids and animation first. */
const GENRE_DISPLAY_ORDER: readonly number[] = [
    20, 2, 3, 0, 1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
];
/** A title is stored as `tmdbId * MASK_SPAN + genreMask`. */
const MASK_SPAN = 2 ** 21;

export interface StreamingServiceFile {
    readonly format?: number;
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
    /** TMDB id -> genre mask */
    readonly members: ReadonlyMap<number, number>;
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
        const decode = (codes: readonly number[] | undefined) => {
            const members = new Map<number, number>();
            for (const code of codes ?? []) {
                if (file?.format === 2) {
                    members.set(Math.floor(code / MASK_SPAN), code % MASK_SPAN);
                } else {
                    members.set(code, 0);
                }
            }
            return members;
        };
        (file?.services ?? []).forEach((service, index) => {
            const id = STREAMING_CATEGORY_ID_BASE + index;
            const movies = decode(service.movie);
            const shows = decode(service.tv);
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

    /** The service entry id a selection belongs to (a service or one of its genres), or null. */
    serviceIdOf(categoryId: number | null | undefined): number | null {
        if (categoryId === null || categoryId === undefined) return null;
        if (categoryId >= STREAMING_GENRE_ID_BASE) {
            const index = Math.floor(
                (categoryId - STREAMING_GENRE_ID_BASE) / STREAMING_GENRE_ID_STRIDE
            );
            return STREAMING_CATEGORY_ID_BASE + index;
        }
        return categoryId >= STREAMING_CATEGORY_ID_BASE ? categoryId : null;
    }

    /** The genre (index into STREAMING_GENRES) inside a genre-list id, or null for any other id. */
    genreBitOf(categoryId: number): number | null {
        return categoryId >= STREAMING_GENRE_ID_BASE
            ? (categoryId - STREAMING_GENRE_ID_BASE) % STREAMING_GENRE_ID_STRIDE
            : null;
    }

    private genreId(serviceId: number, genreBit: number): number {
        return (
            STREAMING_GENRE_ID_BASE +
            (serviceId - STREAMING_CATEGORY_ID_BASE) * STREAMING_GENRE_ID_STRIDE +
            genreBit
        );
    }

    /** True when `item` belongs to the service (or service genre) category `categoryId` for `type`. */
    includes(type: StreamingContentType, categoryId: number, item: unknown): boolean {
        const serviceId = this.serviceIdOf(categoryId);
        if (serviceId === null) return false;
        const group = this.groups[type].find((g) => g.id === serviceId);
        if (!group) return false;
        const id = tmdbIdOf(item);
        const mask = id === null ? undefined : group.members.get(id);
        if (mask === undefined) return false;
        const bit = this.genreBitOf(categoryId);
        return bit === null || (mask & (1 << bit)) !== 0;
    }

    /** Adds each service's, and each service genre's, item count to `counts`. */
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
                const mask = group.members.get(id);
                if (mask === undefined) continue;
                counts.set(group.id, (counts.get(group.id) ?? 0) + 1);
                for (let bit = 0; bit < STREAMING_GENRES.length; bit++) {
                    if (mask & (1 << bit)) {
                        const genre = this.genreId(group.id, bit);
                        counts.set(genre, (counts.get(genre) ?? 0) + 1);
                    }
                }
            }
        }
    }

    /**
     * The genre entries to show under the selected service: the genres (from TMDB, not the
     * provider's categories) that hold at least one of its titles in the library.
     */
    genreCategories(
        selectedCategoryId: number | null | undefined,
        counts: ReadonlyMap<number, number>
    ) {
        const serviceId = this.serviceIdOf(selectedCategoryId);
        if (serviceId === null) return [];
        const result: { category_id: string; category_name: string; parent_id: number }[] = [];
        for (const bit of GENRE_DISPLAY_ORDER) {
            const id = this.genreId(serviceId, bit);
            if ((counts.get(id) ?? 0) > 0) {
                result.push({
                    category_id: String(id),
                    category_name: `› ${STREAMING_GENRES[bit]}`,
                    parent_id: serviceId,
                });
            }
        }
        return result;
    }

    /** "Netflix: Anime" for a service or genre-list id, for titles and search labels. */
    labelOf(type: StreamingContentType, categoryId: number): string | null {
        const serviceId = this.serviceIdOf(categoryId);
        const group = serviceId === null ? undefined : this.groups[type].find((g) => g.id === serviceId);
        if (!group) return null;
        const bit = this.genreBitOf(categoryId);
        return bit === null || !STREAMING_GENRES[bit]
            ? group.name
            : `${group.name}: ${STREAMING_GENRES[bit]}`;
    }
}

/** One shared instance: the data source fills it, the selection store reads it. */
export const streamingGroups = new StreamingGroups();

async function fetchBundledStreamingFile(
    doc: Document
): Promise<StreamingServiceFile | null> {
    const response = await fetch(
        new URL('assets/streaming/streaming.json', doc.baseURI).toString()
    );
    if (!response.ok) return null;
    const file = (await response.json()) as StreamingServiceFile;
    return Array.isArray(file?.services) ? file : null;
}

/**
 * TV app: the newest weekly copy the app saved from the build server (see the `streaming-lists`
 * release), served by the app's own backend. Kill switch: localStorage['streaming-weekly'] = 'off'.
 */
async function fetchWeeklyStreamingFile(): Promise<StreamingServiceFile | null> {
    try {
        if (localStorage.getItem('streaming-weekly') === 'off') return null;
        const base = (
            globalThis as {
                __IPTVNATOR_CONFIG__?: { BACKEND_URL?: string };
            }
        ).__IPTVNATOR_CONFIG__?.BACKEND_URL;
        if (!base || !document.documentElement.classList.contains('tv-shell')) {
            return null;
        }
        const response = await fetch(
            `${base.replace(/\/+$/, '')}/streaming-lists`,
            { signal: AbortSignal.timeout(6000) }
        );
        if (!response.ok) return null;
        const file = (await response.json()) as StreamingServiceFile;
        return Array.isArray(file?.services) && file.services.length > 0
            ? file
            : null;
    } catch {
        return null;
    }
}

/** The newer of the bundled lists and the weekly copy (by their generation time). */
export async function fetchStreamingFile(
    doc: Document
): Promise<StreamingServiceFile | null> {
    const [bundled, weekly] = await Promise.all([
        fetchBundledStreamingFile(doc).catch(() => null),
        fetchWeeklyStreamingFile(),
    ]);
    if (!weekly) return bundled;
    if (!bundled) return weekly;
    return String(weekly.generatedAt ?? '') >= String(bundled.generatedAt ?? '')
        ? weekly
        : bundled;
}
