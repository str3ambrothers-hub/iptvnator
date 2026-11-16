import type { XtreamCachedContentItem } from './pwa-cached-content';

/**
 * A saved copy of each playlist's catalogue, so the TV shell starts from the
 * device instead of downloading and parsing tens of megabytes of provider
 * JSON on every launch (the PWA data source otherwise keeps catalogues in
 * memory only). Active in the TV shell only (its `tv.js` puts the `tv-shell`
 * class on `<html>`). Kill switch: `localStorage['catalogue-cache'] = 'off'`.
 *
 * A saved catalogue is served at once; older than an hour, the data source
 * also fetches a fresh one in the background and replaces it. Nothing here
 * ever throws into the caller: storage that is missing, full or damaged
 * simply means the catalogue is downloaded as before.
 */

export const CATALOGUE_CACHE_SHELL_CLASS = 'tv-shell';
export const CATALOGUE_CACHE_KILL_SWITCH_KEY = 'catalogue-cache';
/** A saved catalogue older than this is ignored and deleted. */
export const CATALOGUE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** A saved catalogue older than this is served, then refreshed in the background. */
export const CATALOGUE_REVALIDATE_AFTER_MS = 60 * 60 * 1000;

/** Both waits keep large catalogue work off the launch path. */
const SAVE_DELAY_MS = 1500;
const REFRESH_DELAY_MS = 20_000;

const DB_NAME = 'iptvnator-catalogue';
const STORE_NAME = 'catalogues';

export interface PersistedCatalogue {
    readonly savedAt: number;
    readonly items: XtreamCachedContentItem[];
}

export interface LoadedCatalogue {
    readonly items: XtreamCachedContentItem[];
    readonly ageMs: number;
}

/** The few operations the store needs, so tests need no IndexedDB. */
export interface CatalogueBackend {
    get(key: string): Promise<PersistedCatalogue | undefined>;
    put(key: string, value: PersistedCatalogue): Promise<void>;
    delete(key: string): Promise<void>;
    keys(): Promise<string[]>;
}

export function isCatalogueCacheEnabled(doc: Document | null): boolean {
    if (
        !doc?.documentElement?.classList.contains(CATALOGUE_CACHE_SHELL_CLASS)
    ) {
        return false;
    }
    try {
        return (
            doc.defaultView?.localStorage?.getItem(
                CATALOGUE_CACHE_KILL_SWITCH_KEY
            ) !== 'off'
        );
    } catch {
        return true;
    }
}

function request<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

export class IndexedDbCatalogueBackend implements CatalogueBackend {
    private opened: Promise<IDBDatabase> | null = null;
    private readonly factory: IDBFactory;

    constructor(factory: IDBFactory) {
        this.factory = factory;
    }

    private open(): Promise<IDBDatabase> {
        if (!this.opened) {
            this.opened = new Promise<IDBDatabase>((resolve, reject) => {
                const req = this.factory.open(DB_NAME, 1);
                req.onupgradeneeded = () => {
                    req.result.createObjectStore(STORE_NAME);
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
                req.onblocked = () => reject(new Error('blocked'));
            });
            // A failed open is retried on the next call.
            this.opened.catch(() => {
                this.opened = null;
            });
        }
        return this.opened;
    }

    private async store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
        return (await this.open())
            .transaction(STORE_NAME, mode)
            .objectStore(STORE_NAME);
    }

    async get(key: string): Promise<PersistedCatalogue | undefined> {
        return request<PersistedCatalogue | undefined>(
            (await this.store('readonly')).get(key)
        );
    }

    async put(key: string, value: PersistedCatalogue): Promise<void> {
        const store = await this.store('readwrite');
        const tx = store.transaction;
        const done = new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
        store.put(value, key);
        await done;
    }

    async delete(key: string): Promise<void> {
        await request((await this.store('readwrite')).delete(key));
    }

    async keys(): Promise<string[]> {
        const keys = await request(
            (await this.store('readonly')).getAllKeys()
        );
        return keys.map(String);
    }
}

export class CatalogueStore {
    private readonly backend: CatalogueBackend | null;
    private readonly now: () => number;
    private readonly refreshing = new Set<string>();

    constructor(
        backend: CatalogueBackend | null,
        now: () => number = () => Date.now()
    ) {
        this.backend = backend;
        this.now = now;
    }

    get enabled(): boolean {
        return this.backend !== null;
    }

    /** The saved catalogue for `key`, or null when absent, expired, damaged or unreadable. */
    async load(key: string): Promise<LoadedCatalogue | null> {
        if (!this.backend) return null;
        try {
            const saved = await this.backend.get(key);
            if (
                !saved ||
                typeof saved.savedAt !== 'number' ||
                !Array.isArray(saved.items) ||
                saved.items.length === 0
            ) {
                return null;
            }
            const ageMs = this.now() - saved.savedAt;
            if (ageMs < 0 || ageMs > CATALOGUE_MAX_AGE_MS) {
                await this.backend.delete(key).catch(() => undefined);
                return null;
            }
            return { items: saved.items, ageMs };
        } catch {
            return null;
        }
    }

    async save(
        key: string,
        items: readonly XtreamCachedContentItem[]
    ): Promise<void> {
        if (!this.backend || items.length === 0) return;
        try {
            await this.backend.put(key, {
                savedAt: this.now(),
                items: items as XtreamCachedContentItem[],
            });
        } catch {
            // Full or unavailable storage: the catalogue is simply not kept.
        }
    }

    /** Saved once the first screen has settled: a large write competes with rendering. */
    saveLater(key: string, items: readonly XtreamCachedContentItem[]): void {
        if (!this.backend) return;
        setTimeout(() => void this.save(key, items), SAVE_DELAY_MS);
    }

    /**
     * Downloads a fresh catalogue some time after launch and saves it. `apply`
     * puts it in the session cache and returns false when the playlist is gone
     * meanwhile, which drops it. Screens already built keep the older copy; the
     * next read and the next launch get this one. A failure keeps the old copy.
     */
    refreshLater(
        key: string,
        download: () => Promise<XtreamCachedContentItem[]>,
        apply: (fresh: XtreamCachedContentItem[]) => boolean
    ): void {
        if (!this.backend || this.refreshing.has(key)) return;
        this.refreshing.add(key);
        setTimeout(() => {
            void (async () => {
                try {
                    const fresh = await download();
                    if (fresh.length > 0 && apply(fresh)) {
                        await this.save(key, fresh);
                    }
                } catch {
                    // Offline or a provider error: the saved copy stays.
                } finally {
                    this.refreshing.delete(key);
                }
            })();
        }, REFRESH_DELAY_MS);
    }

    /** Forget every saved catalogue of a playlist (keys are `<playlistId>-<type>-content`). */
    async removePlaylist(playlistId: string): Promise<void> {
        if (!this.backend) return;
        try {
            for (const key of await this.backend.keys()) {
                if (key.startsWith(`${playlistId}-`)) {
                    await this.backend.delete(key);
                }
            }
        } catch {
            // ignore
        }
    }
}

/** A store backed by IndexedDB in the TV shell, an inert one everywhere else. */
export function createCatalogueStore(doc: Document | null): CatalogueStore {
    const factory = doc?.defaultView?.indexedDB;
    if (!doc || !factory || !isCatalogueCacheEnabled(doc)) {
        return new CatalogueStore(null);
    }
    return new CatalogueStore(new IndexedDbCatalogueBackend(factory));
}
