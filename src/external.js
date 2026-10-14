// Molecular Dynamics papers from sources other than arXiv (journals, bioRxiv, ChemRxiv…).
// Each refresh asks every source for recent papers, keeps only those passing the strict MD
// test, merges duplicates found by several sources, and drops those already on arXiv.
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { SOURCES } from './sources/index.js';
import { normDoi, preprintServer, isoDay, isRepositoryDeposit, stripTags } from './sources/common.js';
import { isStrictMd } from './focus.js';

const DATA_DIR = path.resolve(import.meta.dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'external.json');
const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_DAYS = Number(process.env.KEEP_DAYS ?? 7);
// Journals often register papers a few days late, so each refresh looks a bit further back.
const OVERLAP_DAYS = 3;

// uid -> stored record. uid is "doi:<doi>" when there is a DOI, otherwise "title:<normalized>".
let records = new Map();
let lastRun = null;
let running = null;
let cachedList = null;

const normTitle = (t) =>
  String(t ?? '')
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

export async function load() {
  try {
    const data = JSON.parse(await readFile(FILE, 'utf8'));
    records = new Map(data.papers.map((p) => [p.uid, p]));
    lastRun = data.lastRun ? new Date(data.lastRun) : null;
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('Could not read data/external.json:', err.message);
  }
}

async function save() {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  await writeFile(tmp, JSON.stringify({ lastRun, papers: [...records.values()] }));
  await rename(tmp, FILE);
}

// Some APIs return names with HTML entities ("Chemical &amp; Engineering").
const cleanVenue = (v) => (v ? stripTags(v) || null : null);
// A DOI from a preprint server settles it, whatever a source claims.
const kindOf = (p) => (preprintServer(p.doi) ? 'preprint' : p.kind);

/** Label used in the "Source" filter: the preprint server, or "Journals". */
function sourceLabel(p) {
  if (p.kind === 'journal') return 'Journals';
  const server = `${preprintServer(p.doi) ?? ''} ${p.venue ?? ''}`;
  if (/biorxiv/i.test(server)) return 'bioRxiv';
  if (/chemrxiv/i.test(server)) return 'ChemRxiv';
  return 'Other preprints';
}

// Keep the most complete version of each field when several sources found the same paper.
function merge(old, fresh, sourceName) {
  const pick = (a, b) => (String(b ?? '').length > String(a ?? '').length ? b : a);
  return {
    ...old,
    title: old.title || fresh.title,
    abstract: pick(old.abstract, fresh.abstract),
    authors: fresh.authors?.length > old.authors.length ? fresh.authors : old.authors,
    venue: old.kind === 'journal' ? old.venue : cleanVenue(fresh.venue) ?? old.venue,
    kind: preprintServer(old.doi) ? 'preprint' : old.kind === 'journal' || fresh.kind === 'journal' ? 'journal' : 'preprint',
    pdfUrl: old.pdfUrl ?? fresh.pdfUrl ?? null,
    published: old.published ?? fresh.published,
    foundIn: [...new Set([...old.foundIn, sourceName])],
  };
}

/**
 * Asks every source for recent papers and stores the new strict-MD ones.
 * `arxivPapers` are used to skip papers that arXiv already provides.
 */
export function refresh(arxivPapers, { log = console.log } = {}) {
  running ??= (async () => {
    try {
      const now = new Date();
      const keepSince = new Date(now.getTime() - KEEP_DAYS * DAY_MS);
      const overlapSince = lastRun && new Date(lastRun.getTime() - OVERLAP_DAYS * DAY_MS);
      const from = isoDay(overlapSince && overlapSince > keepSince ? overlapSince : keepSince);
      const to = isoDay(now);

      const onArxiv = new Set(arxivPapers.flatMap((p) => [`arxiv:${p.id}`, `doi:10.48550/arxiv.${p.id.toLowerCase()}`, `title:${normTitle(p.title)}`]));
      const byTitle = new Map([...records.values()].map((r) => [normTitle(r.title), r.uid]));
      let added = 0;

      log(`Fetching Molecular Dynamics papers from ${SOURCES.length} other sources (${from} to ${to})…`);
      for (const source of SOURCES) {
        let fetched;
        try {
          fetched = await source.fetchPapers({ from, to });
        } catch (err) {
          log(`  ${source.name}: failed (${err.message})`);
          continue;
        }
        let kept = 0;
        for (const raw of fetched) {
          const p = { ...raw, title: (raw.title ?? '').trim(), abstract: raw.abstract ?? '', authors: raw.authors ?? [] };
          if (!p.title || !isStrictMd(p)) continue;
          const doi = normDoi(p.doi);
          if (isRepositoryDeposit(doi) || /zenodo|figshare/i.test(p.venue ?? '')) continue;
          const title = normTitle(p.title);
          if (onArxiv.has(`title:${title}`) || (doi && onArxiv.has(`doi:${doi}`)) || (p.arxivId && onArxiv.has(`arxiv:${p.arxivId}`))) continue;
          // A paper on arXiv older than our window still shouldn't be listed as new elsewhere.
          if (p.arxivId || doi?.startsWith('10.48550/')) continue;

          const uid = (doi && `doi:${doi}`) || byTitle.get(title) || `title:${title}`;
          const existing = records.get(uid) ?? records.get(byTitle.get(title));
          if (existing) {
            records.set(existing.uid, merge(existing, p, source.name));
          } else {
            records.set(uid, {
              uid,
              doi,
              title: p.title,
              authors: p.authors,
              abstract: p.abstract,
              published: p.published ?? to,
              venue: cleanVenue(p.venue),
              kind: kindOf({ ...p, doi }),
              url: p.url ?? (doi ? `https://doi.org/${doi}` : null),
              pdfUrl: p.pdfUrl ?? null,
              foundIn: [source.name],
              seenAt: now.toISOString(),
            });
            byTitle.set(title, uid);
            added++;
          }
          kept++;
        }
        log(`  ${source.name}: ${fetched.length} fetched, ${kept} Molecular Dynamics`);
      }

      for (const [uid, r] of records) if (new Date(r.seenAt) < keepSince) records.delete(uid);
      lastRun = now;
      cachedList = null;
      await save();
      log(`Other sources done: ${added} new, ${records.size} kept.`);
      return added;
    } finally {
      running = null;
    }
  })();
  return running;
}

export const isRunning = () => running !== null;
export const lastRefresh = () => lastRun;

/**
 * Stored papers in the same shape as arXiv papers, so the rest of the app can treat them alike.
 * The objects are cached between refreshes (the MD cache in the server is keyed on them).
 */
export function allPapers() {
  cachedList ??= [...records.values()]
    .filter((r) => !isRepositoryDeposit(r.doi) && !/zenodo|figshare/i.test(r.venue ?? ''))
    .map((r) => ({ ...r, venue: cleanVenue(r.venue) }))
    .map((r) => ({
      id: r.uid,
      source: sourceLabel(r),
      kind: r.kind,
      venue: r.venue,
      doi: r.doi,
      foundIn: r.foundIn,
      title: r.title,
      authors: r.authors,
      abstract: r.abstract,
      published: r.published,
      updated: null,
      primaryCategory: r.venue ?? (r.kind === 'journal' ? 'Journal article' : 'Preprint'),
      categories: [],
      areas: [],
      comment: null,
      absUrl: r.url,
      pdfUrl: r.pdfUrl,
    }))
    .sort((a, b) => b.published.localeCompare(a.published));
  return cachedList;
}

