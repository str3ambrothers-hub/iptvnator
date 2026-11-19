#!/usr/bin/env node
/**
 * Downloads, from TMDB, the titles each streaming service carries in one region
 * and writes them as `<outDir>/assets/streaming/streaming.json` (arrays of TMDB
 * ids), which the app matches against the provider's library.
 *
 *   TMDB_API_KEY=... node fetch-streaming-lists.mjs <web-output-dir> [region]
 *
 * Never fails the build: without a key, or when TMDB cannot be reached, it
 * writes an empty list and the app simply shows no Streaming categories.
 * Test hook: TMDB_BASE overrides the API address.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.argv[2];
const region = (process.argv[3] || process.env.TMDB_REGION || 'CA').toUpperCase();
const key = process.env.TMDB_API_KEY;
const base = process.env.TMDB_BASE || 'https://api.themoviedb.org/3';
if (!outDir) {
    console.error('usage: fetch-streaming-lists.mjs <web-output-dir> [region]');
    process.exit(2);
}

// TMDB watch-provider ids; names are checked against TMDB's list for the region.
const SERVICES = [
    { name: 'Netflix', id: 8, match: /^netflix$/i },
    { name: 'Disney+', id: 337, match: /^disney\s*(plus|\+)$/i },
    { name: 'Prime Video', id: 9, match: /^amazon prime video$/i },
    { name: 'Apple TV+', id: 350, match: /^apple tv(\s*(plus|\+))?$/i },
    { name: 'Crave (HBO)', id: 230, match: /^crave$/i },
    { name: 'Paramount+', id: 531, match: /^paramount\s*(plus|\+)$/i },
];
const MAX_PAGES = 500; // TMDB serves at most 500 pages per query
const CONCURRENCY = 6;

function write(services, note) {
    const dir = join(outDir, 'assets', 'streaming');
    mkdirSync(dir, { recursive: true });
    const file = { region, generatedAt: new Date().toISOString(), services };
    writeFileSync(join(dir, 'streaming.json'), JSON.stringify(file));
    console.log(`streaming.json: ${services.map((s) => `${s.name} ${s.movie.length}/${s.tv.length}`).join(', ') || 'empty'}${note ? ' (' + note + ')' : ''}`);
}

async function api(path, params, attempt = 0) {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries({ api_key: key, ...params })) url.searchParams.set(k, String(v));
    try {
        const res = await fetch(url);
        if (res.status === 429 || res.status >= 500) throw new Error('HTTP ' + res.status);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
    } catch (err) {
        if (attempt >= 4) throw err;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        return api(path, params, attempt + 1);
    }
}

/** Runs `tasks` (functions returning promises) with a fixed number in flight. */
async function pool(tasks) {
    const results = [];
    let next = 0;
    await Promise.all(
        Array.from({ length: CONCURRENCY }, async () => {
            while (next < tasks.length) {
                const i = next++;
                results[i] = await tasks[i]();
            }
        })
    );
    return results;
}

/** Every id of one query; a range that hits the 500-page cap is split in two by year. */
async function collect(kind, providerId, from, to, ids) {
    const dateField = kind === 'movie' ? 'primary_release_date' : 'first_air_date';
    const params = (page) => ({
        with_watch_providers: providerId,
        watch_region: region,
        with_watch_monetization_types: 'flatrate',
        'vote_count.gte': 0,
        sort_by: kind === 'movie' ? 'primary_release_date.asc' : 'first_air_date.asc',
        [`${dateField}.gte`]: `${from}-01-01`,
        [`${dateField}.lte`]: `${to}-12-31`,
        page,
    });
    const first = await api(`/discover/${kind}`, params(1));
    if (first.total_pages >= MAX_PAGES && from < to) {
        const mid = Math.floor((from + to) / 2);
        await collect(kind, providerId, from, mid, ids);
        await collect(kind, providerId, mid + 1, to, ids);
        return;
    }
    for (const r of first.results || []) ids.add(r.id);
    const pages = Math.min(first.total_pages || 1, MAX_PAGES);
    const tasks = [];
    for (let page = 2; page <= pages; page++) {
        tasks.push(async () => {
            const data = await api(`/discover/${kind}`, params(page));
            for (const r of data.results || []) ids.add(r.id);
        });
    }
    await pool(tasks);
}

async function main() {
    if (!key) {
        write([], 'no TMDB_API_KEY');
        return;
    }
    const names = new Map();
    for (const kind of ['movie', 'tv']) {
        const list = await api(`/watch/providers/${kind}`, { watch_region: region });
        for (const p of list.results || []) names.set(p.provider_id, p.provider_name);
    }
    const thisYear = new Date().getFullYear() + 1;
    const out = [];
    for (const service of SERVICES) {
        const known = names.get(service.id);
        if (!known) {
            console.log(`skip ${service.name}: provider ${service.id} is not offered in ${region}`);
            continue;
        }
        if (!service.match.test(known)) console.log(`note: ${service.name} (id ${service.id}) is called "${known}" by TMDB`);
        const movie = new Set();
        const tv = new Set();
        await collect('movie', service.id, 1900, thisYear, movie);
        await collect('tv', service.id, 1900, thisYear, tv);
        out.push({ name: service.name, movie: [...movie].sort((a, b) => a - b), tv: [...tv].sort((a, b) => a - b) });
        console.log(`${service.name}: ${movie.size} movies, ${tv.size} series`);
    }
    write(out);
}

main().catch((err) => {
    console.error('could not download the streaming lists:', err.message);
    write([], 'download failed');
});
