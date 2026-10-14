import { XMLParser } from 'fast-xml-parser';
import { PHYSICS_QUERY, areasOf } from './categories.js';

const API_URL = 'https://export.arxiv.org/api/query';
const PAGE_SIZE = 200;
// arXiv asks clients to make at most one request every 3 seconds.
const REQUEST_DELAY_MS = 3100;
const MAX_RETRIES = 3;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  isArray: (name) => ['entry', 'author', 'category', 'link'].includes(name),
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function toPaper(entry) {
  // id looks like http://arxiv.org/abs/2610.13946v1
  const versioned = String(entry.id).split('/abs/')[1];
  const id = versioned.replace(/v\d+$/, '');
  const categories = (entry.category ?? []).map((c) => c.term);
  const pdf = (entry.link ?? []).find((l) => l.title === 'pdf')?.href;
  return {
    id,
    title: clean(entry.title),
    authors: (entry.author ?? []).map((a) => clean(a.name)),
    abstract: clean(entry.summary),
    published: entry.published,
    updated: entry.updated,
    primaryCategory: entry['arxiv:primary_category']?.term ?? categories[0],
    categories,
    areas: areasOf(categories),
    comment: entry['arxiv:comment'] ? clean(entry['arxiv:comment']) : null,
    absUrl: `https://arxiv.org/abs/${id}`,
    pdfUrl: pdf ?? `https://arxiv.org/pdf/${id}`,
  };
}

async function fetchPage(start) {
  const params = new URLSearchParams({
    search_query: PHYSICS_QUERY,
    sortBy: 'submittedDate',
    sortOrder: 'descending',
    start: String(start),
    max_results: String(PAGE_SIZE),
  });
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${API_URL}?${params}`, {
        headers: { 'User-Agent': 'arxiv-alert/1.0 (personal reading app)' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const feed = parser.parse(await res.text()).feed;
      return (feed.entry ?? []).map(toPaper);
    } catch (err) {
      if (attempt >= MAX_RETRIES) throw err;
      await sleep(REQUEST_DELAY_MS * attempt * 2);
    }
  }
}

/**
 * Downloads the most recent physics papers, newest first,
 * until reaching one submitted before `since`.
 */
export async function fetchRecentPhysics({ since, maxPapers = 5000, log = () => {} }) {
  const papers = [];
  for (let start = 0; start < maxPapers; start += PAGE_SIZE) {
    if (start > 0) await sleep(REQUEST_DELAY_MS);
    const page = await fetchPage(start);
    log(`  page ${start / PAGE_SIZE + 1}: ${page.length} papers`);
    if (page.length === 0) break;

    let reachedEnd = false;
    for (const p of page) {
      if (new Date(p.published) < since) {
        reachedEnd = true;
        break;
      }
      papers.push(p);
    }
    if (reachedEnd || page.length < PAGE_SIZE) break;
  }
  return papers;
}
