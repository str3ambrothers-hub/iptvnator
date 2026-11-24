import {
    activeXtreamServerUrl,
    isXtreamServerUnreachable,
    setXtreamBackupServer,
    withXtreamServerFailover,
} from './xtream-server-failover';

const MAIN = 'http://main.example:8080';
const BACKUP = 'http://backup.example';

describe('xtream server failover', () => {
    beforeEach(() => {
        localStorage.clear();
        setXtreamBackupServer(MAIN, undefined);
    });

    it('treats bad gateway, timeouts and no answer as unreachable, not logins or missing pages', () => {
        expect(isXtreamServerUnreachable({ status: 502 })).toBe(true);
        expect(isXtreamServerUnreachable({ status: 504 })).toBe(true);
        expect(isXtreamServerUnreachable({ message: 'Bad Gateway' })).toBe(true);
        expect(isXtreamServerUnreachable({ status: 401 })).toBe(false);
        expect(isXtreamServerUnreachable({ status: 404 })).toBe(false);
        expect(isXtreamServerUnreachable(null)).toBe(false);
    });

    it('only tries the main server when there is no backup', async () => {
        const attempt = jest.fn().mockRejectedValue({ status: 502 });
        await expect(withXtreamServerFailover(MAIN, attempt)).rejects.toEqual({
            status: 502,
        });
        expect(attempt).toHaveBeenCalledTimes(1);
    });

    it('moves to the backup on a bad gateway and keeps using it', async () => {
        setXtreamBackupServer(MAIN, BACKUP);
        const attempt = jest
            .fn()
            .mockRejectedValueOnce({ status: 502 })
            .mockResolvedValue('ok');
        await expect(withXtreamServerFailover(MAIN, attempt)).resolves.toBe('ok');
        expect(attempt).toHaveBeenNthCalledWith(1, MAIN);
        expect(attempt).toHaveBeenNthCalledWith(2, BACKUP);
        // Stream links are now built on the working server.
        expect(activeXtreamServerUrl(MAIN)).toBe(BACKUP);
    });

    it('does not switch servers for a wrong login', async () => {
        setXtreamBackupServer(MAIN, BACKUP);
        const attempt = jest.fn().mockRejectedValue({ status: 401 });
        await expect(withXtreamServerFailover(MAIN, attempt)).rejects.toEqual({
            status: 401,
        });
        expect(attempt).toHaveBeenCalledTimes(1);
        expect(activeXtreamServerUrl(MAIN)).toBe(MAIN);
    });

    it('can be switched off', async () => {
        setXtreamBackupServer(MAIN, BACKUP);
        localStorage.setItem('server-failover', 'off');
        const attempt = jest.fn().mockRejectedValue({ status: 502 });
        await expect(withXtreamServerFailover(MAIN, attempt)).rejects.toBeDefined();
        expect(attempt).toHaveBeenCalledTimes(1);
    });
});
