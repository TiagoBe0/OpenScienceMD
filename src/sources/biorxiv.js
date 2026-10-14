// bioRxiv: the API lists every new preprint in a date range (no search), 100 per call.
import { getJson, sleep } from './common.js';

export const name = 'bioRxiv';

export async function fetchPapers({ from, to }) {
  const papers = [];
  for (let cursor = 0, total = Infinity; cursor < total; ) {
    const page = await getJson(`https://api.biorxiv.org/details/biorxiv/${from}/${to}/${cursor}`);
    total = Number(page.messages?.[0]?.total ?? 0);
    if (!page.collection?.length) break;
    for (const x of page.collection) {
      const url = `https://www.biorxiv.org/content/${x.doi}v${x.version}`;
      papers.push({
        title: x.title,
        authors: String(x.authors ?? '').split(';').map((a) => a.trim()).filter(Boolean),
        abstract: x.abstract,
        published: x.date,
        venue: 'bioRxiv',
        kind: 'preprint',
        doi: x.doi,
        url,
        pdfUrl: `${url}.full.pdf`,
      });
    }
    cursor += page.collection.length;
    await sleep(500);
  }
  return papers;
}
