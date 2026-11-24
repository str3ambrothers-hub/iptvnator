import { normalizeXtreamServerUrl } from './xtream-portal.utils';

/**
 * Backup server for an Xtream login. When the main server cannot be reached (bad gateway, gateway
 * timeout, no network answer), requests are retried once on the backup, and the backup is kept for a
 * while so the next requests, and the stream links built from it, go straight to the working server.
 *
 * The backup is stored per main server address (not per playlist), so every call site that already
 * knows only the main address benefits without carrying a new field around.
 * Kill switch: localStorage['server-failover'] = 'off'.
 */
const STORAGE_KEY = 'xtream-backup-servers';
/** After switching to the backup, try the main server again after this long. */
const RETRY_MAIN_AFTER_MS = 15 * 60 * 1000;

const switched = new Map<string, number>();

function failoverOff(): boolean {
    try {
        return localStorage.getItem('server-failover') === 'off';
    } catch {
        return false;
    }
}

function normalized(url: string | null | undefined): string | null {
    if (!url?.trim()) return null;
    try {
        return normalizeXtreamServerUrl(url);
    } catch {
        return null;
    }
}

function readAll(): Record<string, string> {
    try {
        const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

export function getXtreamBackupServer(primaryUrl: string): string | null {
    const key = normalized(primaryUrl);
    return key ? (normalized(readAll()[key]) ?? null) : null;
}

/** Saves (or, with an empty value, removes) the backup server of a main server address. */
export function setXtreamBackupServer(
    primaryUrl: string,
    backupUrl: string | null | undefined
): void {
    const key = normalized(primaryUrl);
    if (!key) return;
    const all = readAll();
    const backup = normalized(backupUrl);
    if (backup && backup !== key) all[key] = backup;
    else delete all[key];
    switched.delete(key);
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    } catch {
        /* storage unavailable: the backup lasts only until the app closes */
    }
}

/** Servers to try, in order: the one that worked last first, then the other. */
export function xtreamServerCandidates(primaryUrl: string): string[] {
    const primary = normalized(primaryUrl) ?? primaryUrl;
    const backup = failoverOff() ? null : getXtreamBackupServer(primary);
    if (!backup) return [primary];
    const since = switched.get(primary);
    if (since !== undefined && Date.now() - since < RETRY_MAIN_AFTER_MS) {
        return [backup, primary];
    }
    switched.delete(primary);
    return [primary, backup];
}

/** The address stream links should be built on right now. */
export function activeXtreamServerUrl(primaryUrl: string): string {
    return xtreamServerCandidates(primaryUrl)[0];
}

export function noteXtreamServerWorked(
    primaryUrl: string,
    usedUrl: string
): void {
    const primary = normalized(primaryUrl) ?? primaryUrl;
    if (usedUrl === primary) switched.delete(primary);
    else if (!switched.has(primary)) switched.set(primary, Date.now());
}

/** A bad gateway / timeout / no answer: a reason to try the backup. Wrong logins and 4xx are not. */
export function isXtreamServerUnreachable(error: unknown): boolean {
    const e = error as { status?: number; message?: string } | null;
    if (!e) return false;
    if (typeof e.status === 'number') {
        return e.status === 502 || e.status === 503 || e.status === 504;
    }
    return /bad gateway|gateway time|timed? ?out|network|fetch failed|failed to fetch|ECONN|ENOTFOUND|EAI_AGAIN|unreachable/i.test(
        e.message ?? ''
    );
}

/**
 * Runs `attempt` on the main server and, if it cannot be reached, once on the backup. Anything
 * else (a wrong login, a missing page, the user cancelling) is thrown straight away.
 */
export async function withXtreamServerFailover<T>(
    primaryUrl: string,
    attempt: (serverUrl: string) => Promise<T>,
    signal?: AbortSignal
): Promise<T> {
    const candidates = xtreamServerCandidates(primaryUrl);
    const primary = normalized(primaryUrl) ?? primaryUrl;
    for (let i = 0; i < candidates.length; i++) {
        signal?.throwIfAborted();
        try {
            const result = await attempt(candidates[i]);
            if (candidates.length > 1) noteXtreamServerWorked(primary, candidates[i]);
            return result;
        } catch (error) {
            if (i < candidates.length - 1 && isXtreamServerUnreachable(error)) {
                continue;
            }
            throw error;
        }
    }
    throw new Error('No server to try');
}
