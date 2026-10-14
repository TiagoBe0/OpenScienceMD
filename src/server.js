import './env.js';
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { AREAS } from './categories.js';
import { scoreMd, mdMatches } from './focus.js';
import * as store from './store.js';
import * as topics from './topics.js';
import * as digest from './digest.js';
import * as figures from './figures.js';
import * as auth from './auth.js';
import * as archive from './archive.js';
import * as external from './external.js';

const PORT = Number(process.env.PORT ?? 3000);
// Only reachable from this machine by default: the app has no login.
const HOST = process.env.HOST ?? '127.0.0.1';
const MAX_BODY_BYTES = 64 * 1024;
// URL prefix when served behind a proxy, e.g. "/sbs/openscience". Empty when served at the root.
const BASE_PATH = (process.env.BASE_PATH ?? '').replace(/\/+$/, '');
const REFRESH_HOURS = Number(process.env.REFRESH_HOURS ?? 3);
// The list is compact (title + authors), so a page can hold many papers.
const PAGE_SIZE = 100;
const PUBLIC_DIR = path.resolve(import.meta.dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Request body too large.'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('Invalid JSON.'), { status: 400 });
  }
}

// MD scores only depend on the paper, so they are cached per paper object.
const mdCache = new WeakMap();
function mdOf(paper) {
  let md = mdCache.get(paper);
  if (!md) {
    md = scoreMd(paper);
    md.words = md.isMd ? mdMatches(paper) : [];
    mdCache.set(paper, md);
  }
  return md;
}

const hasFigure = (p) => Boolean(p.figure?.images.length);
// arXiv papers without a figure are hidden by default. Papers from the other sources are
// always listed: many publishers don't let us reach their graphical abstracts.
const listedByDefault = (p) => p.source !== 'arXiv' || hasFigure(p);

/**
 * All papers (arXiv, plus Molecular Dynamics papers from the other sources) with their MD
 * score and topic matches, optionally limited to MD papers.
 */
function annotatedPapers(scope) {
  const arxiv = store.allPapers().map((p) => ({
    ...p,
    source: 'arXiv',
    md: mdOf(p),
    topics: topics.matchPaper(p),
    figure: figures.cachedFigure(p.id),
  }));
  const others = external.allPapers().map((p) => ({
    ...p,
    md: mdOf(p),
    topics: topics.matchPaper(p),
    figure: figures.cachedFigure(p.id),
  }));
  const papers = [...arxiv, ...others];
  return scope === 'all' ? papers : papers.filter((p) => p.md.isMd);
}

const SOURCE_ORDER = ['arXiv', 'bioRxiv', 'ChemRxiv', 'Other preprints', 'Journals'];

// Molecular Dynamics first, then papers matching a topic, then the rest.
// Within each group, papers with a figure (graphical abstract) come first.
const rank = (p) => (p.md.isMd ? 2 : p.topics.length ? 1 : 0);

// The APIs expose no readership data, and brand-new papers have no citations yet, so "interest"
// is a heuristic: how central MD is, topic matches, a figure, peer-reviewed venue, being indexed
// by several sources, and (when a source reports them) citations.
function interest(p) {
  return (
    p.md.score +
    2 * p.topics.length +
    (hasFigure(p) ? 2 : 0) +
    (p.kind === 'journal' ? 2 : 0) +
    (p.foundIn?.length ?? 0) +
    2 * Math.log2(1 + (p.citations ?? 0))
  );
}

function listPapers(params) {
  const scope = params.get('scope') === 'all' ? 'all' : 'md';
  const sort = params.get('sort') === 'relevance' ? 'relevance' : 'date';
  const area = params.get('area');
  const topic = params.get('topic'); // a topic id, or "__any" for any topic
  const day = params.get('day'); // YYYY-MM-DD
  const source = params.get('source');
  const terms = (params.get('q') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const page = Math.max(1, Number(params.get('page')) || 1);
  // By default only papers with a figure are listed; "fig=all" includes the rest.
  const allFigures = params.get('fig') === 'all';

  const filtered = annotatedPapers(scope).filter((p) => {
    if (topic === '__any' && !p.topics.length) return false;
    if (topic && topic !== '__any' && !p.topics.some((t) => t.id === topic)) return false;
    if (area && !p.areas.includes(area)) return false;
    if (day && !p.published.startsWith(day)) return false;
    if (source && p.source !== source) return false;
    if (terms.length) {
      const text = `${p.title} ${p.abstract} ${p.authors.join(' ')} ${p.id} ${p.venue ?? ''}`.toLowerCase();
      if (!terms.every((t) => text.includes(t))) return false;
    }
    return true;
  });
  const matches = allFigures ? filtered : filtered.filter(listedByDefault);
  const withoutFigure = filtered.filter((p) => !listedByDefault(p));

  // Default: newest day first, and within a day the most interesting papers first.
  // "relevance" ignores the day and puts the most interesting papers first overall.
  const day10 = (p) => p.published.slice(0, 10);
  matches.sort(
    sort === 'relevance'
      ? (a, b) => rank(b) - rank(a) || interest(b) - interest(a) || b.published.localeCompare(a.published)
      : (a, b) =>
          day10(b).localeCompare(day10(a)) ||
          rank(b) - rank(a) ||
          interest(b) - interest(a) ||
          b.published.localeCompare(a.published)
  );

  return {
    total: matches.length,
    page,
    pages: Math.max(1, Math.ceil(matches.length / PAGE_SIZE)),
    papers: matches.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    // Papers left out for lack of a figure: known to have none, or not checked yet.
    withoutFigure: withoutFigure.length,
    unchecked: figures.uncheckedCount(withoutFigure),
  };
}

function stats(params, admin) {
  const scope = params.get('scope') === 'all' ? 'all' : 'md';
  const stored = annotatedPapers('all');
  const all = stored.filter((p) => params.get('fig') === 'all' || listedByDefault(p));
  const papers = scope === 'all' ? all : all.filter((p) => p.md.isMd);
  const byArea = Object.fromEntries(AREAS.map((a) => [a.id, 0]));
  const byTopic = Object.fromEntries(topics.list().map((t) => [t.id, 0]));
  const byDay = {};
  const bySource = {};
  let anyTopic = 0;
  for (const p of papers) {
    bySource[p.source] = (bySource[p.source] ?? 0) + 1;
    if (p.topics.length) anyTopic++;
    for (const t of p.topics) byTopic[t.id]++;
    for (const a of p.areas) byArea[a]++;
    const day = p.published.slice(0, 10);
    byDay[day] = (byDay[day] ?? 0) + 1;
  }
  return {
    scope,
    total: papers.length,
    scopes: { md: all.filter((p) => p.md.isMd).length, all: all.length },
    stored: store.allPapers().length,
    otherSources: external.allPapers().length,
    sources: SOURCE_ORDER.filter((s) => bySource[s]).map((s) => ({ id: s, label: s, count: bySource[s] })),
    lastRefresh: store.lastRefresh(),
    lastRefreshOther: external.lastRefresh(),
    refreshHours: REFRESH_HOURS,
    refreshing: store.isRefreshing() || external.isRunning(),
    areas: AREAS.map((a) => ({ id: a.id, label: a.label, count: byArea[a.id] })),
    topics: topics.list().map((t) => ({ ...t, count: byTopic[t.id] })),
    topicsTotal: anyTopic,
    // The recipient address is only shown to the admin.
    email: admin ? digest.status() : { ...digest.status(), to: null },
    days: Object.entries(byDay)
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([day, count]) => ({ day, count })),
  };
}

async function serveStatic(res, pathname) {
  const file = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'Forbidden' });
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
  }
}

async function handleTopics(req, res, id) {
  if (!id && req.method === 'GET') return sendJson(res, 200, topics.list());
  if (!id && req.method === 'POST') return sendJson(res, 201, await topics.create(await readJson(req)));
  if (id && req.method === 'PUT') {
    const topic = await topics.update(id, await readJson(req));
    return topic ? sendJson(res, 200, topic) : sendJson(res, 404, { error: 'Topic not found.' });
  }
  if (id && req.method === 'DELETE') {
    return (await topics.remove(id)) ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: 'Topic not found.' });
  }
  sendJson(res, 405, { error: 'Method not allowed' });
}

// The private PDF archive: admin only, reading included.
const ARCHIVE_PAGE_SIZE = 20;

async function handleArchive(req, res, pathname, params) {
  if (!archive.enabled) return sendJson(res, 404, { error: 'The archive is not enabled.' });
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
  if (pathname === '/api/archive/stats') return sendJson(res, 200, archive.stats());
  if (pathname === '/api/archive/papers') {
    const page = Math.max(1, Number(params.get('page')) || 1);
    const offset = (page - 1) * ARCHIVE_PAGE_SIZE;
    const q = (params.get('q') ?? '').trim();
    const { total, results } = q ? archive.search(q, ARCHIVE_PAGE_SIZE, offset) : archive.list(ARCHIVE_PAGE_SIZE, offset);
    return sendJson(res, 200, {
      total,
      page,
      pages: Math.max(1, Math.ceil(total / ARCHIVE_PAGE_SIZE)),
      // The file path stays on the server.
      results: results.map(({ pdfFile, ...r }) => r),
    });
  }
  const pdfRoute = pathname.match(/^\/api\/archive\/pdf\/(.+)$/);
  if (pdfRoute) {
    const pdf = archive.pdfFor(decodeURIComponent(pdfRoute[1]));
    if (!pdf) return sendJson(res, 404, { error: 'Not in the archive.' });
    const { size } = await stat(pdf.file);
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': size,
      'Content-Disposition': `inline; filename="${pdf.filename}"`,
      'Cache-Control': 'private, max-age=86400',
    });
    return createReadStream(pdf.file).pipe(res);
  }
  sendJson(res, 404, { error: 'Not found' });
}

async function handleLogin(req, res) {
  if (!auth.allowAttempt(auth.clientIp(req))) {
    return sendJson(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
  }
  const { password } = await readJson(req);
  if (!auth.checkPassword(String(password ?? ''))) return sendJson(res, 401, { error: 'Wrong password.' });
  res.setHeader('Set-Cookie', auth.sessionCookie(req, BASE_PATH || '/'));
  sendJson(res, 200, { admin: true });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = url.pathname;
  if (BASE_PATH) {
    // Relative links in the page need the trailing slash.
    if (pathname === BASE_PATH) {
      res.writeHead(301, { Location: `${BASE_PATH}/${url.search}` });
      return res.end();
    }
    if (!pathname.startsWith(`${BASE_PATH}/`)) return sendJson(res, 404, { error: 'Not found' });
    pathname = pathname.slice(BASE_PATH.length);
  }
  try {
    // Requests that change data must come from the app itself (basic CSRF protection).
    if (req.method !== 'GET' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) {
      return sendJson(res, 403, { error: 'Origin not allowed.' });
    }
    const admin = auth.isAdmin(req);
    if (pathname === '/api/session' && req.method === 'GET') {
      return sendJson(res, 200, { authRequired: auth.required(), admin, archive: admin && archive.enabled });
    }
    if (pathname === '/api/login' && req.method === 'POST') return await handleLogin(req, res);
    if (pathname === '/api/logout' && req.method === 'POST') {
      res.setHeader('Set-Cookie', auth.clearedCookie(req, BASE_PATH || '/'));
      return sendJson(res, 200, { admin: false });
    }
    // Everything that changes data or triggers work is for the admin only.
    if (req.method !== 'GET' && !admin) return sendJson(res, 401, { error: 'Admin login required.' });
    if (pathname.startsWith('/api/archive/')) {
      if (!admin) return sendJson(res, 401, { error: 'Admin login required.' });
      return await handleArchive(req, res, pathname, url.searchParams);
    }

    if (pathname === '/api/papers' && req.method === 'GET') return sendJson(res, 200, listPapers(url.searchParams));
    if (pathname === '/api/stats' && req.method === 'GET') return sendJson(res, 200, stats(url.searchParams, admin));
    const topicRoute = pathname.match(/^\/api\/topics(?:\/([\w-]+))?$/);
    if (topicRoute) return await handleTopics(req, res, topicRoute[1]);
    if (pathname === '/api/digest/preview' && req.method === 'GET') {
      const { html } = digest.build({ basePath: BASE_PATH });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (pathname === '/api/digest/send' && req.method === 'POST') {
      return sendJson(res, 200, { sent: await digest.send() });
    }
    if (pathname === '/api/refresh' && req.method === 'POST') {
      store.refresh().catch((err) => console.error('Refresh failed:', err.message));
      return sendJson(res, 202, { refreshing: true });
    }
    if (req.method === 'GET') return serveStatic(res, pathname);
    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    if (err.status) return sendJson(res, err.status, { error: err.message });
    console.error(err);
    sendJson(res, 500, { error: err.message || 'Internal error' });
  }
});

function scheduleRefresh() {
  const run = () => store.refresh().catch((err) => console.error('Refresh failed:', err.message));
  const last = store.lastRefresh();
  const stale = !last || Date.now() - last.getTime() > REFRESH_HOURS * 60 * 60 * 1000;
  if (stale) run();
  setInterval(run, REFRESH_HOURS * 60 * 60 * 1000);
}

// After each refresh, fetch figures in the background: Molecular Dynamics papers first.
// arXiv papers are only listed once their figure is known, so every paper gets checked.
function prefetchFigures() {
  const papers = store.allPapers();
  const others = external.allPapers();
  figures.prune(new Set([...papers, ...others].map((p) => p.id)));
  const md = papers.filter((p) => mdOf(p).isMd);
  const rest = papers.filter((p) => !mdOf(p).isMd);
  figures.prefetch([...md, ...rest]);
  figures.prefetch(others);
}

// Molecular Dynamics PDFs go to the permanent archive (when ARCHIVE_PDFS is enabled):
// every arXiv MD paper, and the papers from other sources that have an open-access PDF.
function archiveMd() {
  const papers = annotatedPapers('md').filter((p) => p.source === 'arXiv' || p.pdfUrl);
  archive.archivePapers(papers).catch((err) => console.error('Archive failed:', err.message));
}

// After arXiv, ask the other sources, then look for their figures and archive. Runs in the background.
function refreshOtherSources() {
  external
    .refresh(store.allPapers())
    .catch((err) => console.error('Other sources failed:', err.message))
    .finally(() => {
      figures.prefetch(external.allPapers());
      archiveMd();
    });
}

store.onRefreshed(prefetchFigures);
store.onRefreshed(refreshOtherSources);

await Promise.all([store.load(), topics.load(), digest.load(), figures.load(), external.load()]);
server.listen(PORT, HOST, () => {
  console.log(`arXiv Physics → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}${BASE_PATH}/`);
  console.log(auth.required() ? 'Admin login enabled.' : 'No ADMIN_PASSWORD: anyone can change topics and trigger actions.');
  scheduleRefresh();
  digest.schedule();
  if (!store.isRefreshing()) {
    prefetchFigures();
    const last = external.lastRefresh();
    if (!last || Date.now() - last.getTime() > REFRESH_HOURS * 60 * 60 * 1000) refreshOtherSources();
    else archiveMd();
  }
  if (archive.enabled) console.log(`PDF archive: ${archive.ARCHIVE_DIR}`);
});
