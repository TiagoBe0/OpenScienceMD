// Crossref: journal articles and preprints (ChemRxiv, Research Square…) registered with a DOI.
// Abstracts are often missing, so many papers are judged by their title alone.
import { getJson, sleep, stripTags, preprintServer, MD_QUERY } from './common.js';

export const name = 'Crossref';
const PAGE_SIZE = 500;
const MAX_PAGES = 4;

const dateOf = (x) => {
  const [y, m = 1, d = 1] = x.published?.['date-parts']?.[0] ?? x.created?.['date-parts']?.[0] ?? [];
  return y ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
};

export async function fetchPapers({ from, to }) {
  const papers = [];
  for (const type of ['journal-article', 'posted-content']) {
    let cursor = '*';
    for (let page = 0; page < MAX_PAGES && cursor; page++) {
      const q = new URLSearchParams({
        'query.bibliographic': MD_QUERY,
        filter: `from-pub-date:${from},until-pub-date:${to},type:${type}`,
        rows: String(PAGE_SIZE),
        cursor,
        select: 'DOI,title,abstract,container-title,published,created,author,URL,type',
      });
      const { message } = await getJson(`https://api.crossref.org/works?${q}`);
      for (const x of message.items) {
        const preprint = type === 'posted-content';
        papers.push({
          title: stripTags(x.title?.[0]),
          authors: (x.author ?? []).map((a) => [a.given, a.family].filter(Boolean).join(' ') || a.name).filter(Boolean),
          abstract: stripTags(x.abstract).replace(/^Abstract\s*/i, ''),
          published: dateOf(x),
          venue: preprint ? preprintServer(x.DOI) ?? 'Preprint' : x['container-title']?.[0] ?? null,
          kind: preprint ? 'preprint' : 'journal',
          doi: x.DOI,
          url: x.URL ?? `https://doi.org/${x.DOI}`,
          pdfUrl: null,
        });
      }
      cursor = message.items.length === PAGE_SIZE ? message['next-cursor'] : null;
      await sleep(1000);
    }
  }
  return papers;
}
