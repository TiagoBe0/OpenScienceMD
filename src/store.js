import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { fetchRecentPhysics } from './arxiv.js';

const DATA_DIR = path.resolve(import.meta.dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'papers.json');
const DAY_MS = 24 * 60 * 60 * 1000;
// arXiv sorts by submission date, but a paper can be announced days after it was
// submitted, so every refresh re-checks the last few days.
const OVERLAP_DAYS = 4;

export const KEEP_DAYS = Number(process.env.KEEP_DAYS ?? 7);

const listeners = [];

/** Registers a callback run after every successful refresh. */
export function onRefreshed(fn) {
  listeners.push(fn);
}

const state = {
  papers: new Map(),
  lastRefresh: null,
  refreshing: null,
};

export async function load() {
  try {
    const data = JSON.parse(await readFile(DATA_FILE, 'utf8'));
    state.papers = new Map(data.papers.map((p) => [p.id, p]));
    state.lastRefresh = data.lastRefresh ? new Date(data.lastRefresh) : null;
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('Could not read data/papers.json:', err.message);
  }
}

async function save() {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify({ lastRefresh: state.lastRefresh, papers: [...state.papers.values()] }));
  await rename(tmp, DATA_FILE);
}

/** Fetches new papers and drops those older than KEEP_DAYS. */
export function refresh({ log = console.log } = {}) {
  // Avoid two downloads running at once.
  state.refreshing ??= (async () => {
    try {
      const keepSince = new Date(Date.now() - KEEP_DAYS * DAY_MS);
      const overlapSince = state.lastRefresh && new Date(state.lastRefresh.getTime() - OVERLAP_DAYS * DAY_MS);
      const since = overlapSince && overlapSince > keepSince ? overlapSince : keepSince;
      log(`Fetching physics papers submitted since ${since.toISOString()}…`);
      const fetched = await fetchRecentPhysics({ since, log });
      let added = 0;
      for (const p of fetched) {
        if (!state.papers.has(p.id)) added++;
        state.papers.set(p.id, p);
      }
      for (const [id, p] of state.papers) {
        if (new Date(p.published) < keepSince) state.papers.delete(id);
      }
      state.lastRefresh = new Date();
      await save();
      log(`Done: ${added} new, ${state.papers.size} total.`);
      for (const fn of listeners) fn();
      return added;
    } finally {
      state.refreshing = null;
    }
  })();
  return state.refreshing;
}

export function isRefreshing() {
  return state.refreshing !== null;
}

export function lastRefresh() {
  return state.lastRefresh;
}

export function allPapers() {
  return [...state.papers.values()].sort((a, b) => b.published.localeCompare(a.published));
}
