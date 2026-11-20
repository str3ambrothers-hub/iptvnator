import {
    STREAMING_CATEGORY_ID_BASE,
    STREAMING_GENRE_ID_BASE,
    STREAMING_GENRE_ID_STRIDE,
    StreamingGroups,
    isStreamingGroupsEnabled,
    tmdbIdOf,
} from './streaming-groups';

const SPAN = 2 ** 21;
const ACTION = 0;
const ANIMATION = 2;
const ANIME = 3;
const COMEDY = 4;
const KIDS = 20;
/** A title as the build stores it: tmdb id and its genre bits. */
const code = (id: number, ...bits: number[]) =>
    id * SPAN + bits.reduce((mask, bit) => mask | (1 << bit), 0);

const file = {
    format: 2,
    services: [
        { name: 'Netflix', movie: [code(10, ACTION), code(11, COMEDY, KIDS)], tv: [code(100, ANIME)] },
        { name: 'Disney+', movie: [code(11, COMEDY, KIDS), code(12, ANIMATION, KIDS)], tv: [] },
    ],
};

describe('tmdbIdOf', () => {
    it('reads tmdb or tmdb_id and ignores empty values', () => {
        expect(tmdbIdOf({ tmdb: '603' })).toBe(603);
        expect(tmdbIdOf({ tmdb_id: 7 })).toBe(7);
        expect(tmdbIdOf({ tmdb: '' })).toBeNull();
        expect(tmdbIdOf({ tmdb: '0' })).toBeNull();
        expect(tmdbIdOf({})).toBeNull();
        expect(tmdbIdOf(null)).toBeNull();
    });
});

describe('StreamingGroups', () => {
    let groups: StreamingGroups;
    beforeEach(() => {
        groups = new StreamingGroups();
        groups.apply(file);
    });

    it('lists only the services that have titles of the type', () => {
        expect(groups.categories('vod').map((c) => c.category_name)).toEqual([
            'Netflix',
            'Disney+',
        ]);
        expect(groups.categories('series').map((c) => c.category_name)).toEqual([
            'Netflix',
        ]);
        expect(groups.categories('vod')[0].category_id).toBe(
            String(STREAMING_CATEGORY_ID_BASE)
        );
    });

    it('matches an item by tmdb id, in several services at once', () => {
        const both = { tmdb: '11' };
        expect(groups.includes('vod', STREAMING_CATEGORY_ID_BASE, both)).toBe(true);
        expect(groups.includes('vod', STREAMING_CATEGORY_ID_BASE + 1, both)).toBe(true);
        expect(groups.includes('vod', STREAMING_CATEGORY_ID_BASE, { tmdb: '12' })).toBe(false);
        expect(groups.includes('vod', STREAMING_CATEGORY_ID_BASE, {})).toBe(false);
        expect(groups.includes('series', STREAMING_CATEGORY_ID_BASE, { tmdb: '10' })).toBe(false);
    });

    it('counts matching items per service', () => {
        const counts = new Map<number, number>([[5, 3]]);
        groups.addCounts('vod', [{ tmdb: '10' }, { tmdb: '11' }, { tmdb: '99' }, {}], counts);
        expect(counts.get(STREAMING_CATEGORY_ID_BASE)).toBe(2);
        expect(counts.get(STREAMING_CATEGORY_ID_BASE + 1)).toBe(1);
        expect(counts.get(5)).toBe(3);
    });

    it('has no groups without a file, and a failed load is not an error', async () => {
        const empty = new StreamingGroups();
        await empty.load(async () => {
            throw new Error('offline');
        });
        expect(empty.categories('vod')).toEqual([]);
        empty.apply(null);
        expect(empty.categories('series')).toEqual([]);
    });
});

describe('StreamingGroups genres', () => {
    const NETFLIX = STREAMING_CATEGORY_ID_BASE;
    const DISNEY = STREAMING_CATEGORY_ID_BASE + 1;
    const genre = (service: number, bit: number) =>
        STREAMING_GENRE_ID_BASE +
        (service - STREAMING_CATEGORY_ID_BASE) * STREAMING_GENRE_ID_STRIDE +
        bit;
    let groups: StreamingGroups;
    beforeEach(() => {
        groups = new StreamingGroups();
        groups.apply(file);
    });

    it('maps a genre id back to its service and genre', () => {
        expect(groups.serviceIdOf(genre(DISNEY, KIDS))).toBe(DISNEY);
        expect(groups.genreBitOf(genre(DISNEY, KIDS))).toBe(KIDS);
        expect(groups.serviceIdOf(NETFLIX)).toBe(NETFLIX);
        expect(groups.serviceIdOf(5)).toBeNull();
        expect(groups.serviceIdOf(null)).toBeNull();
        expect(groups.genreBitOf(NETFLIX)).toBeNull();
    });

    it('keeps only the service titles that carry the genre', () => {
        expect(groups.includes('vod', genre(NETFLIX, ACTION), { tmdb: '10' })).toBe(true);
        expect(groups.includes('vod', genre(NETFLIX, COMEDY), { tmdb: '10' })).toBe(false);
        expect(groups.includes('vod', genre(NETFLIX, KIDS), { tmdb: '11' })).toBe(true);
        expect(groups.includes('vod', genre(NETFLIX, KIDS), { tmdb: '99' })).toBe(false);
        expect(groups.includes('vod', genre(DISNEY, ANIMATION), { tmdb: '12' })).toBe(true);
        expect(groups.includes('series', genre(NETFLIX, ANIME), { tmdb: '100' })).toBe(true);
        expect(groups.includes('series', genre(NETFLIX, ANIMATION), { tmdb: '100' })).toBe(false);
    });

    it('counts each service genre and lists only genres that hold titles, Kids first', () => {
        const counts = new Map<number, number>();
        groups.addCounts('vod', [{ tmdb: '10' }, { tmdb: '11' }, { tmdb: '99' }, {}], counts);

        expect(counts.get(NETFLIX)).toBe(2);
        expect(counts.get(genre(NETFLIX, KIDS))).toBe(1);
        expect(counts.get(genre(NETFLIX, ACTION))).toBe(1);
        expect(counts.get(genre(DISNEY, KIDS))).toBe(1);

        expect(
            groups.genreCategories(NETFLIX, counts).map((c) => c.category_name)
        ).toEqual(['› Kids', '› Action', '› Comedy']);
        expect(groups.genreCategories(genre(NETFLIX, ACTION), counts).length).toBe(3);
        expect(groups.genreCategories(5, counts)).toEqual([]);
        expect(groups.genreCategories(null, counts)).toEqual([]);
    });

    it('labels a service and one of its genres', () => {
        expect(groups.labelOf('vod', NETFLIX)).toBe('Netflix');
        expect(groups.labelOf('vod', genre(NETFLIX, COMEDY))).toBe('Netflix: Comedy');
        expect(groups.labelOf('vod', 5)).toBeNull();
    });
});

describe('isStreamingGroupsEnabled', () => {
    afterEach(() => {
        document.documentElement.classList.remove('tv-shell');
        localStorage.removeItem('streaming-groups');
    });

    it('is on in the TV shell until switched off', () => {
        expect(isStreamingGroupsEnabled(document)).toBe(false);
        expect(isStreamingGroupsEnabled(null)).toBe(false);
        document.documentElement.classList.add('tv-shell');
        expect(isStreamingGroupsEnabled(document)).toBe(true);
        localStorage.setItem('streaming-groups', 'off');
        expect(isStreamingGroupsEnabled(document)).toBe(false);
    });
});
