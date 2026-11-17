import {
    CATALOGUE_CACHE_KILL_SWITCH_KEY,
    CATALOGUE_CACHE_SHELL_CLASS,
    CATALOGUE_MAX_AGE_MS,
    CatalogueStore,
    slimCatalogueItem,
    createCatalogueStore,
    isCatalogueCacheEnabled,
    type CatalogueBackend,
    type PersistedCatalogue,
} from './pwa-catalogue-store';

class MemoryBackend implements CatalogueBackend {
    readonly data = new Map<string, PersistedCatalogue>();
    failing = false;

    async get(key: string) {
        if (this.failing) throw new Error('unavailable');
        return this.data.get(key);
    }
    async put(key: string, value: PersistedCatalogue) {
        if (this.failing) throw new Error('quota');
        this.data.set(key, value);
    }
    async delete(key: string) {
        this.data.delete(key);
    }
    async keys() {
        return [...this.data.keys()];
    }
}

const items = [{ stream_id: 1, name: 'Sample One' }];

describe('CatalogueStore', () => {
    let backend: MemoryBackend;
    let now: number;
    let store: CatalogueStore;

    beforeEach(() => {
        backend = new MemoryBackend();
        now = 1_700_000_000_000;
        store = new CatalogueStore(backend, () => now);
    });

    it('is inert without a backend', async () => {
        const inert = new CatalogueStore(null);

        await inert.save('p-movie-content', items);

        expect(inert.enabled).toBe(false);
        expect(await inert.load('p-movie-content')).toBeNull();
    });

    it('returns a saved catalogue with its age', async () => {
        await store.save('p-movie-content', items);
        now += 5_000;

        expect(await store.load('p-movie-content')).toEqual({
            items,
            ageMs: 5_000,
        });
    });

    it('ignores and deletes a catalogue that is too old', async () => {
        await store.save('p-movie-content', items);
        now += CATALOGUE_MAX_AGE_MS + 1;

        expect(await store.load('p-movie-content')).toBeNull();
        expect(backend.data.has('p-movie-content')).toBe(false);
    });

    it('ignores damaged records', async () => {
        backend.data.set('a', { savedAt: now, items: [] });
        backend.data.set('b', {
            savedAt: 'x',
            items,
        } as unknown as PersistedCatalogue);
        backend.data.set('c', {
            savedAt: now,
            items: 'nope',
        } as unknown as PersistedCatalogue);

        for (const key of ['a', 'b', 'c', 'missing']) {
            expect(await store.load(key)).toBeNull();
        }
    });

    it('never throws when storage fails', async () => {
        backend.failing = true;

        await expect(store.save('p-movie-content', items)).resolves.toBeUndefined();
        expect(await store.load('p-movie-content')).toBeNull();
        await expect(store.removePlaylist('p')).resolves.toBeUndefined();
    });

    it('does not save an empty catalogue', async () => {
        await store.save('p-movie-content', []);

        expect(backend.data.size).toBe(0);
    });

    it('removes only the catalogues of one playlist', async () => {
        await store.save('p1-movie-content', items);
        await store.save('p1-series-content', items);
        await store.save('p10-movie-content', items);

        await store.removePlaylist('p1');

        expect([...backend.data.keys()]).toEqual(['p10-movie-content']);
    });

    describe('delayed work', () => {
        beforeEach(() => jest.useFakeTimers());
        afterEach(() => jest.useRealTimers());

        it('saves after the first screen has settled', async () => {
            store.saveLater('p-movie-content', items);
            expect(backend.data.size).toBe(0);

            await jest.advanceTimersByTimeAsync(2_000);

            expect(backend.data.has('p-movie-content')).toBe(true);
        });

        it('refreshes in the background and saves what was applied', async () => {
            const fresh = [{ stream_id: 2, name: 'Sample Two' }];
            const apply = jest.fn(() => true);

            store.refreshLater('p-movie-content', async () => fresh, apply);
            expect(apply).not.toHaveBeenCalled();
            await jest.advanceTimersByTimeAsync(30_000);

            expect(apply).toHaveBeenCalledWith(fresh);
            expect(backend.data.get('p-movie-content')?.items).toEqual(fresh);
        });

        it('drops a refresh whose playlist is gone', async () => {
            store.refreshLater(
                'p-movie-content',
                async () => items,
                () => false
            );

            await jest.advanceTimersByTimeAsync(30_000);

            expect(backend.data.size).toBe(0);
        });

        it('keeps the saved copy when the refresh fails', async () => {
            await store.save('p-movie-content', items);

            store.refreshLater(
                'p-movie-content',
                async () => {
                    throw new Error('offline');
                },
                () => true
            );
            await jest.advanceTimersByTimeAsync(30_000);

            expect(backend.data.get('p-movie-content')?.items).toEqual(items);
        });

        it('runs one refresh per catalogue at a time', async () => {
            const download = jest.fn(async () => items);

            store.refreshLater('p-movie-content', download, () => true);
            store.refreshLater('p-movie-content', download, () => true);
            await jest.advanceTimersByTimeAsync(30_000);

            expect(download).toHaveBeenCalledTimes(1);
        });
    });
});

describe('isCatalogueCacheEnabled', () => {
    afterEach(() => {
        document.documentElement.classList.remove(CATALOGUE_CACHE_SHELL_CLASS);
        localStorage.removeItem(CATALOGUE_CACHE_KILL_SWITCH_KEY);
    });

    it('is off outside the TV shell and without a document', () => {
        expect(isCatalogueCacheEnabled(document)).toBe(false);
        expect(isCatalogueCacheEnabled(null)).toBe(false);
        expect(createCatalogueStore(document).enabled).toBe(false);
    });

    it('is on in the TV shell until switched off', () => {
        document.documentElement.classList.add(CATALOGUE_CACHE_SHELL_CLASS);
        expect(isCatalogueCacheEnabled(document)).toBe(true);

        localStorage.setItem(CATALOGUE_CACHE_KILL_SWITCH_KEY, 'off');
        expect(isCatalogueCacheEnabled(document)).toBe(false);
    });
});

describe('slimmed saving', () => {
    const heavy = {
        stream_id: 7,
        name: 'Sample Seven',
        stream_icon: 'https://img.example.test/7.jpg',
        container_extension: 'mkv',
        plot: 'long text',
        cast: 'A, B',
        genre: 'Drama',
        backdrop_path: ['x'],
    };

    it('drops detail-only fields and keeps playback and grid fields', () => {
        expect(slimCatalogueItem(heavy)).toEqual({
            stream_id: 7,
            name: 'Sample Seven',
            stream_icon: 'https://img.example.test/7.jpg',
            container_extension: 'mkv',
        });
        expect(heavy.plot).toBe('long text');
    });

    it('returns rows without heavy fields untouched', () => {
        const row = { stream_id: 1 };
        expect(slimCatalogueItem(row)).toBe(row);
    });

    it('saves slim rows, or full rows with the switch off', async () => {
        const mem = new MemoryBackend();
        await new CatalogueStore(mem, () => 1).save('a-movie-content', [heavy]);
        await new CatalogueStore(mem, () => 1, false).save('b-movie-content', [
            heavy,
        ]);

        expect(mem.data.get('a-movie-content')?.items[0]).not.toHaveProperty(
            'plot'
        );
        expect(mem.data.get('b-movie-content')?.items[0]).toHaveProperty(
            'plot'
        );
    });
});
