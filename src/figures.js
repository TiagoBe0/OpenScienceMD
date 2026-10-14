// "Graphical abstract" for a paper. arXiv has none, so we take a figure from the
// paper's HTML version (arxiv.org/html/<id>), preferring one named like a TOC /
// graphical abstract and otherwise the first figure. Not every paper has an HTML version.
// Papers from other sources get the publisher's graphical abstract when we can reach it
// (see publisher-figures.js).
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import * as publishers from './publisher-figures.js';

const DATA_DIR = path.resolve(import.meta.dirname, '..', 'data');
const FIGURES_FILE = path.join(DATA_DIR, 'figures.json');
const REQUEST_DELAY_MS = 1500; // be gentle with arxiv.org and the publishers' servers
const DAY_MS = 24 * 60 * 60 * 1000;
// The HTML version on arXiv, or the figures on a publisher's site, may appear later.
const RETRY_MISSING_MS = { arxiv: 3 * DAY_MS, publisher: DAY_MS };
// The first figure is near the top, so we stop reading the page once we have it.
const MAX_HTML_BYTES = 4 * 1024 * 1024;
const MAX_IMAGES = 4; // a figure made of panels has several images
const CAPTION_CHARS = 400;

// id -> { images: [url], caption, graphicalAbstract, checkedAt } or { images: [], checkedAt }
let cache = {};
let saveTimer = null;
// One queue per kind, so slow publisher checks don't hold up arXiv figures.
const queues = { arxiv: Promise.resolve(), publisher: Promise.resolve() };
const inFlight = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function load() {
  try {
    cache = JSON.parse(await readFile(FIGURES_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('Could not read data/figures.json:', err.message);
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await mkdir(DATA_DIR, { recursive: true });
    const tmp = `${FIGURES_FILE}.tmp`;
    await writeFile(tmp, JSON.stringify(cache));
    await rename(tmp, FIGURES_FILE);
  }, 1000);
}

/** Drops cached entries for papers that are no longer stored. */
export function prune(keepIds) {
  for (const id of Object.keys(cache)) if (!keepIds.has(id)) delete cache[id];
  scheduleSave();
}

const decodeEntities = (s) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');

// Caption as plain text; LaTeXML math becomes $…$ so MathJax can render it in the page.
function captionText(html) {
  const text = decodeEntities(
    html
      .replace(/<math[^>]*\balttext="([^"]*)"[\s\S]*?<\/math>/g, (_, tex) => `$${decodeEntities(tex)}$`)
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim()
    // Drop the "Figure 3:" label.
    .replace(/^(?:Figure|Fig\.)\s*[\dA-Z]+[a-z]?\s*/i, '')
    .replace(/^[:.|]\s*/, '');
  return text.length > CAPTION_CHARS ? `${text.slice(0, CAPTION_CHARS).replace(/\s+\S*$/, '')}…` : text;
}

// Figures can contain panel sub-figures, so match <figure> tags by nesting depth.
function topLevelFigures(html) {
  const blocks = [];
  let depth = 0;
  let start = 0;
  for (const m of html.matchAll(/<(\/?)figure\b[^>]*>/g)) {
    if (!m[1]) {
      if (depth++ === 0) start = m.index;
    } else if (depth > 0 && --depth === 0) {
      const block = html.slice(start, m.index + m[0].length);
      if (/^<figure[^>]*class="ltx_figure/.test(block)) blocks.push(block);
    }
  }
  return blocks;
}

/** Picks the best figure from a paper's HTML. Exported for testing. */
export function pickFigure(html, pageUrl) {
  const figures = topLevelFigures(html)
    .map((block) => {
      const images = [...block.matchAll(/<img[^>]*\bsrc="([^"]+)"/g)].map((i) => new URL(decodeEntities(i[1]), pageUrl).href);
      // Panels have their own captions; the figure's own caption is the last one.
      const captions = [...block.matchAll(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/g)];
      return { images, captionHtml: captions.at(-1)?.[1] ?? '' };
    })
    .filter((f) => f.images.length);
  if (!figures.length) return null;

  const isToc = (f) => f.images.some((src) => /toc|graphical|abstract/i.test(src.split('/').pop()));
  const figure = figures.find(isToc) ?? figures[0];
  return {
    images: figure.images.slice(0, MAX_IMAGES),
    caption: captionText(figure.captionHtml),
    graphicalAbstract: isToc(figure),
  };
}

async function fetchFigure(id) {
  const res = await fetch(`https://arxiv.org/html/${id}`, {
    headers: { 'User-Agent': 'arxiv-alert/1.0 (personal reading app)' },
    redirect: 'follow',
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let html = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      if (html.length > MAX_HTML_BYTES) break;
      // Stop at the first complete figure that has an image (some figures are pure SVG/text).
      if (html.includes('</figure>') && pickFigure(html, res.url)) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return pickFigure(html, res.url);
}

const isArxiv = (paper) => (paper.source ?? 'arXiv') === 'arXiv';
const laneOf = (paper) => (isArxiv(paper) ? 'arxiv' : 'publisher');

function isFresh(entry, lane) {
  return entry && (entry.images.length || Date.now() - entry.checkedAt < RETRY_MISSING_MS[lane]);
}

/** Whether a figure can be looked for at all (arXiv papers, and some publishers). */
const canHaveFigure = (paper) => isArxiv(paper) || publishers.supports(paper.doi);

/**
 * Returns the cached figure, or downloads it. `paper` needs `id`, plus `source`, `doi` and
 * `absUrl` for papers outside arXiv. Requests are queued, one at a time per queue.
 */
export function getFigure(paper) {
  const { id } = paper;
  const lane = laneOf(paper);
  if (isFresh(cache[id], lane)) return Promise.resolve(cache[id]);
  if (inFlight.has(id)) return inFlight.get(id);

  const task = queues[lane].then(async () => {
    try {
      const figure = isArxiv(paper) ? await fetchFigure(id) : await publishers.findFigure(paper);
      cache[id] = { images: [], ...figure, checkedAt: Date.now() };
      scheduleSave();
      return cache[id];
    } finally {
      inFlight.delete(id);
      // Pause after failures too, or a server that is struggling gets hammered.
      await sleep(REQUEST_DELAY_MS);
    }
  });
  // Keep the queue alive if one request fails.
  queues[lane] = task.catch(() => {});
  inFlight.set(id, task);
  return task;
}

/** How many of these papers have not been checked for a figure yet. */
export const uncheckedCount = (papers) => papers.filter((p) => canHaveFigure(p) && !cache[p.id]).length;

/** Cached figure only, without downloading. */
export const cachedFigure = (id) => cache[id] ?? null;

/** Downloads figures for these papers in the background, skipping cached ones. */
export function prefetch(papers, log = console.log) {
  const missing = papers.filter((p) => canHaveFigure(p) && !isFresh(cache[p.id], laneOf(p)));
  if (!missing.length) return;
  log(`Fetching figures for ${missing.length} papers in the background…`);
  for (const p of missing) getFigure(p).catch((err) => console.warn(`Figure for ${p.id} failed:`, err.message));
}
