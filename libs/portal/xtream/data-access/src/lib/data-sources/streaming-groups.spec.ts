import {
    STREAMING_CATEGORY_ID_BASE,
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
