import {
    STREAMING_CATEGORY_ID_BASE,
    STREAMING_GENRE_ID_BASE,
    STREAMING_GENRE_ID_STRIDE,
    StreamingGroups,
    isStreamingGroupsEnabled,
    tmdbIdOf,
} from './streaming-groups';

const file = {
    services: [
        { name: 'Netflix', movie: [10, 11], tv: [100] },
        { name: 'Disney+', movie: [11, 12], tv: [] },
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
    const genre = (service: number, provider: number) =>
        STREAMING_GENRE_ID_BASE +
        (service - STREAMING_CATEGORY_ID_BASE) * STREAMING_GENRE_ID_STRIDE +
        provider;
    const provider = [
        { category_id: '5', category_name: 'Action' },
        { category_id: '6', category_name: 'Comedy' },
        { category_id: '7', category_name: 'Drama' },
    ];
    const items = [
        { tmdb: '10', category_id: '5' },
        { tmdb: '11', category_id: '5' },
        { tmdb: '11', category_id: '6' },
        { tmdb: '12', category_id: '7' },
        { tmdb: '99', category_id: '5' },
    ];
    let groups: StreamingGroups;
    beforeEach(() => {
        groups = new StreamingGroups();
        groups.apply(file);
    });

    it('maps a genre id back to its service and provider category', () => {
        expect(groups.serviceIdOf(genre(DISNEY, 6))).toBe(DISNEY);
        expect(groups.providerCategoryOf(genre(DISNEY, 6))).toBe(6);
        expect(groups.serviceIdOf(NETFLIX)).toBe(NETFLIX);
        expect(groups.serviceIdOf(5)).toBeNull();
        expect(groups.serviceIdOf(null)).toBeNull();
        expect(groups.providerCategoryOf(NETFLIX)).toBeNull();
    });

    it('keeps only the service titles that sit in the provider category', () => {
        expect(groups.includes('vod', genre(NETFLIX, 5), items[0])).toBe(true);
        expect(groups.includes('vod', genre(NETFLIX, 6), items[0])).toBe(false);
        expect(groups.includes('vod', genre(NETFLIX, 5), items[4])).toBe(false);
        expect(groups.includes('vod', genre(DISNEY, 6), items[2])).toBe(true);
    });

    it('counts each service genre, and lists only genres that hold titles', () => {
        const counts = new Map<number, number>();
        groups.addCounts('vod', items, counts);

        expect(counts.get(NETFLIX)).toBe(3);
        expect(counts.get(genre(NETFLIX, 5))).toBe(2);
        expect(counts.get(genre(NETFLIX, 6))).toBe(1);
        expect(counts.get(genre(DISNEY, 7))).toBe(1);

        expect(
            groups.genreCategories(NETFLIX, counts, provider).map((c) => c.category_name)
        ).toEqual(['› Action', '› Comedy']);
        expect(
            groups.genreCategories(genre(NETFLIX, 5), counts, provider).length
        ).toBe(2);
        expect(groups.genreCategories(5, counts, provider)).toEqual([]);
        expect(groups.genreCategories(null, counts, provider)).toEqual([]);
    });

    it('labels a service and one of its genres', () => {
        expect(groups.labelOf('vod', NETFLIX, provider)).toBe('Netflix');
        expect(groups.labelOf('vod', genre(NETFLIX, 6), provider)).toBe(
            'Netflix: Comedy'
        );
        expect(groups.labelOf('vod', 5, provider)).toBeNull();
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
