// Permanent private archive of Molecular Dynamics papers (arXiv, and open-access papers from
// the other sources): the PDF on disk, and the paper's
// data plus the PDF's full text in SQLite (with an FTS5 index for full-text search).
// Unlike data/papers.json, nothing here is ever dropped. Enabled with ARCHIVE_PDFS=true.
import { createWriteStream, mkdirSync } from 'node:fs';
import { mkdir, rename, rm, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export const enabled = ['1', 'true', 'yes'].includes(String(process.env.ARCHIVE_PDFS ?? '').toLowerCase());
export const ARCHIVE_DIR = path.resolve(process.env.ARCHIVE_DIR || path.join(import.meta.dirname, '..', 'archive'));
const DB_FILE = path.join(ARCHIVE_DIR, 'papers.sqlite');
// export.arxiv.org is the host arXiv asks automated clients to use.
const pdfUrlOf = (p) => (p.source === 'arXiv' ? `https://export.arxiv.org/pdf/${p.id}` : p.pdfUrl);
// Columns added after the first version; older databases get them on open.
const LATER_COLUMNS = { source: 'TEXT', venue: 'TEXT', doi: 'TEXT', pdf_url: 'TEXT' };
const DOWNLOAD_DELAY_MS = 5000;
const MAX_PDF_BYTES = 100 * 1024 * 1024;
const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MS = 6 * 60 * 60 * 1000;

let db = null;
let running = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

export function open() {
  if (db) return db;
  mkdirSync(ARCHIVE_DIR, { recursive: true });
  db = new Database(DB_FILE);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS papers (
      id               TEXT PRIMARY KEY,
      title            TEXT NOT NULL,
      authors          TEXT NOT NULL,          -- JSON array
      abstract         TEXT NOT NULL,
      published        TEXT,
      updated          TEXT,
      primary_category TEXT,
      categories       TEXT,                   -- JSON array
      comment          TEXT,
      abs_url          TEXT,
      md_score         INTEGER,
      md_terms         TEXT,                   -- JSON array
      figure_url       TEXT,
      figure_caption   TEXT,
      pdf_path         TEXT,                   -- relative to the archive folder
      pdf_bytes        INTEGER,
      pdf_sha256       TEXT,
      pages            INTEGER,
      status           TEXT NOT NULL DEFAULT 'pending',  -- pending | done | failed
      attempts         INTEGER NOT NULL DEFAULT 0,
      last_error       TEXT,
      last_attempt_at  TEXT,
      archived_at      TEXT
    );
    CREATE INDEX IF NOT EXISTS papers_status ON papers(status);
    CREATE INDEX IF NOT EXISTS papers_published ON papers(published);
    CREATE VIRTUAL TABLE IF NOT EXISTS papers_fts USING fts5(
      id UNINDEXED, title, abstract, body, tokenize = 'porter unicode61'
    );
  `);
  const existing = new Set(db.prepare('PRAGMA table_info(papers)').all().map((c) => c.name));
  for (const [column, type] of Object.entries(LATER_COLUMNS)) {
    if (!existing.has(column)) db.exec(`ALTER TABLE papers ADD COLUMN ${column} ${type}`);
  }
  // Papers archived before sources existed all came from arXiv.
  db.exec(`UPDATE papers SET source = 'arXiv' WHERE source IS NULL`);
  db.exec(`UPDATE papers SET pdf_url = 'https://export.arxiv.org/pdf/' || id WHERE pdf_url IS NULL AND source = 'arXiv'`);
  return db;
}

/** Saves (or updates) the data of these papers; their PDFs are downloaded later. */
function upsert(papers) {
  const stmt = open().prepare(`
    INSERT INTO papers (id, title, authors, abstract, published, updated, primary_category, categories,
                        comment, abs_url, md_score, md_terms, figure_url, figure_caption,
                        source, venue, doi, pdf_url)
    VALUES (@id, @title, @authors, @abstract, @published, @updated, @primaryCategory, @categories,
            @comment, @absUrl, @mdScore, @mdTerms, @figureUrl, @figureCaption,
            @source, @venue, @doi, @pdfUrl)
    ON CONFLICT(id) DO UPDATE SET
      venue = COALESCE(excluded.venue, papers.venue), doi = COALESCE(excluded.doi, papers.doi),
      pdf_url = COALESCE(papers.pdf_url, excluded.pdf_url),
      title = excluded.title, authors = excluded.authors, abstract = excluded.abstract,
      updated = excluded.updated, categories = excluded.categories, comment = excluded.comment,
      md_score = excluded.md_score, md_terms = excluded.md_terms,
      figure_url = COALESCE(excluded.figure_url, papers.figure_url),
      figure_caption = COALESCE(excluded.figure_caption, papers.figure_caption)
  `);
  const run = open().transaction((rows) => {
    for (const p of rows) {
      stmt.run({
        id: p.id,
        title: p.title,
        authors: JSON.stringify(p.authors),
        abstract: p.abstract,
        published: p.published,
        updated: p.updated,
        primaryCategory: p.primaryCategory,
        categories: JSON.stringify(p.categories),
        comment: p.comment,
        absUrl: p.absUrl,
        mdScore: p.md.score,
        mdTerms: JSON.stringify(p.md.terms),
        figureUrl: p.figure?.images?.[0] ?? null,
        figureCaption: p.figure?.caption || null,
        source: p.source ?? 'arXiv',
        venue: p.venue ?? null,
        doi: p.doi ?? null,
        pdfUrl: pdfUrlOf({ source: 'arXiv', ...p }) ?? null,
      });
    }
  });
  run(papers);
}

function pendingIds() {
  const retryBefore = new Date(Date.now() - RETRY_AFTER_MS).toISOString();
  return open()
    .prepare(
      `SELECT id FROM papers
       WHERE pdf_url IS NOT NULL
         AND (status = 'pending' OR (status = 'failed' AND attempts < ? AND last_attempt_at < ?))
       ORDER BY published DESC`
    )
    .all(MAX_ATTEMPTS, retryBefore)
    .map((r) => r.id);
}

const pdfRelPath = (id, published) => {
  const [year, month] = (published ?? now()).split('-');
  // Ids from other sources are DOIs ("doi:10.1021/…"), so keep file names to safe characters.
  return path.join('pdf', year, month, `${id.replace(/[^\w.-]+/g, '_')}.pdf`);
};

async function download(url, file) {
  const res = await fetch(url, { headers: { 'User-Agent': 'arxiv-alert/1.0 (personal reading app)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!/pdf/i.test(res.headers.get('content-type') ?? '')) throw new Error(`not a PDF (${res.headers.get('content-type')})`);
  const length = Number(res.headers.get('content-length'));
  if (length > MAX_PDF_BYTES) throw new Error(`PDF too large (${length} bytes)`);

  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.part`;
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    await pipeline(
      Readable.fromWeb(res.body),
      async function* (source) {
        for await (const chunk of source) {
          bytes += chunk.length;
          if (bytes > MAX_PDF_BYTES) throw new Error('PDF too large');
          hash.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(tmp)
    );
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return { bytes, sha256: hash.digest('hex') };
}

async function extractText(file) {
  const doc = await getDocument({
    data: new Uint8Array(await readFile(file)),
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
  try {
    let text = '';
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      text += `${content.items.map((it) => it.str + (it.hasEOL ? '\n' : ' ')).join('')}\n\n`;
      page.cleanup();
    }
    return { text: text.replace(/[ \t]+/g, ' ').trim(), pages: doc.numPages };
  } finally {
    await doc.destroy();
  }
}

async function archiveOne(id, log) {
  const row = open().prepare('SELECT * FROM papers WHERE id = ?').get(id);
  const rel = pdfRelPath(id, row.published);
  const file = path.join(ARCHIVE_DIR, rel);
  try {
    const { bytes, sha256 } = await download(row.pdf_url, file);
    // A PDF whose text cannot be extracted (e.g. scanned) is still kept.
    let extracted = { text: '', pages: null };
    try {
      extracted = await extractText(file);
    } catch (err) {
      log(`  ${id}: PDF saved but text extraction failed (${err.message})`);
    }
    open().transaction(() => {
      db.prepare('DELETE FROM papers_fts WHERE id = ?').run(id);
      db.prepare('INSERT INTO papers_fts (id, title, abstract, body) VALUES (?, ?, ?, ?)').run(id, row.title, row.abstract, extracted.text);
      db.prepare(
        `UPDATE papers SET status = 'done', pdf_path = ?, pdf_bytes = ?, pdf_sha256 = ?, pages = ?,
           attempts = attempts + 1, last_error = NULL, last_attempt_at = ?, archived_at = ? WHERE id = ?`
      ).run(rel, bytes, sha256, extracted.pages, now(), now(), id);
    })();
    log(`  archived ${id} (${(bytes / 1e6).toFixed(1)} MB, ${extracted.pages ?? '?'} pages, ${extracted.text.length} chars)`);
  } catch (err) {
    // A publisher that refuses automated downloads will keep refusing: don't ask again.
    const blocked = /HTTP 40[13]|not a PDF/.test(err.message);
    open()
      .prepare(`UPDATE papers SET status = 'failed', attempts = ?, last_error = ?, last_attempt_at = ? WHERE id = ?`)
      .run(blocked ? MAX_ATTEMPTS : (row.attempts ?? 0) + 1, err.message, now(), id);
    log(`  failed ${id}: ${err.message}`);
  }
}

/**
 * Records these Molecular Dynamics papers and downloads the PDFs not archived yet,
 * one at a time. Returns the number of papers processed.
 */
export function archivePapers(papers, { log = console.log } = {}) {
  if (!enabled) return Promise.resolve(0);
  upsert(papers);
  running ??= (async () => {
    try {
      const ids = pendingIds();
      if (ids.length) log(`Archiving ${ids.length} Molecular Dynamics PDFs…`);
      for (const [i, id] of ids.entries()) {
        if (i > 0) await sleep(DOWNLOAD_DELAY_MS);
        await archiveOne(id, log);
      }
      return ids.length;
    } finally {
      running = null;
    }
  })();
  return running;
}

export function stats() {
  const counts = open()
    .prepare(`SELECT status, COUNT(*) n, COALESCE(SUM(pdf_bytes), 0) bytes FROM papers GROUP BY status`)
    .all();
  const by = Object.fromEntries(counts.map((c) => [c.status, c]));
  const range = open().prepare(`SELECT MIN(published) first, MAX(published) last FROM papers WHERE status = 'done'`).get();
  return {
    archived: by.done?.n ?? 0,
    pending: by.pending?.n ?? 0,
    failed: by.failed?.n ?? 0,
    bytes: by.done?.bytes ?? 0,
    first: range.first,
    last: range.last,
    folder: ARCHIVE_DIR,
  };
}

// Snippet markers that cannot appear in PDF text; the web page turns them into <mark>.
export const MARK_START = '\u0002';
export const MARK_END = '\u0003';

const ROW_COLUMNS = `p.id, p.title, p.authors, p.published, p.primary_category, p.abs_url, p.md_terms,
  p.figure_url, p.pages, p.pdf_bytes, p.pdf_path, p.source, p.venue, p.doi`;

function toResult(r) {
  return {
    id: r.id,
    title: r.title,
    authors: JSON.parse(r.authors),
    published: r.published,
    primaryCategory: r.primary_category,
    source: r.source ?? 'arXiv',
    venue: r.venue,
    doi: r.doi,
    absUrl: r.abs_url,
    mdTerms: JSON.parse(r.md_terms ?? '[]'),
    figureUrl: r.figure_url,
    pages: r.pages,
    bytes: r.pdf_bytes,
    snippet: r.snippet ?? null,
    pdfFile: r.pdf_path && path.join(ARCHIVE_DIR, r.pdf_path),
  };
}

/** FTS5 query from free text: every word must appear, and nothing is read as query syntax. */
function ftsQuery(query) {
  const terms = String(query).match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu) ?? [];
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
}

/** Full-text search over title, abstract and PDF text. Returns { total, results }. */
export function search(query, limit = 20, offset = 0) {
  const match = ftsQuery(query);
  if (!match) return { total: 0, results: [] };
  const total = open().prepare('SELECT COUNT(*) n FROM papers_fts WHERE papers_fts MATCH ?').get(match).n;
  const results = open()
    .prepare(
      `SELECT ${ROW_COLUMNS}, snippet(papers_fts, 3, '${MARK_START}', '${MARK_END}', '…', 24) AS snippet
       FROM papers_fts JOIN papers p ON p.id = papers_fts.id
       WHERE papers_fts MATCH ? AND p.status = 'done'
       ORDER BY bm25(papers_fts, 0, 10, 4, 1) LIMIT ? OFFSET ?`
    )
    .all(match, limit, offset)
    .map(toResult);
  return { total, results };
}

/** Archived papers, newest first. Returns { total, results }. */
export function list(limit = 20, offset = 0) {
  const total = open().prepare(`SELECT COUNT(*) n FROM papers WHERE status = 'done'`).get().n;
  const results = open()
    .prepare(`SELECT ${ROW_COLUMNS} FROM papers p WHERE status = 'done' ORDER BY published DESC LIMIT ? OFFSET ?`)
    .all(limit, offset)
    .map(toResult);
  return { total, results };
}

/** The archived PDF of a paper, looked up by id (never by a path from the request). */
export function pdfFor(id) {
  const row = open().prepare(`SELECT title, pdf_path FROM papers WHERE id = ? AND status = 'done'`).get(id);
  if (!row?.pdf_path) return null;
  const file = path.resolve(ARCHIVE_DIR, row.pdf_path);
  if (!file.startsWith(ARCHIVE_DIR + path.sep)) return null;
  return { file, filename: `${id.replace(/[^\w.-]+/g, '_')}.pdf` };
}

/** Checks that every archived PDF is still on disk with the recorded size. */
export async function verify() {
  const rows = open().prepare(`SELECT id, pdf_path, pdf_bytes FROM papers WHERE status = 'done'`).all();
  const problems = [];
  for (const r of rows) {
    try {
      const s = await stat(path.join(ARCHIVE_DIR, r.pdf_path));
      if (s.size !== r.pdf_bytes) problems.push(`${r.id}: size ${s.size} != ${r.pdf_bytes}`);
    } catch {
      problems.push(`${r.id}: missing ${r.pdf_path}`);
    }
  }
  return { checked: rows.length, problems };
}
