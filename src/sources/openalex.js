// OpenAlex: broad index of journals and repositories. The free tier only allows filtering by
// publication date (not by date added), which is what we need anyway.
import { getJson, sleep } from './common.js';

export const name = 'OpenAlex';

const abstractFrom = (inverted) => {
  if (!inverted) return '';
  const words = [];
  for (const [word, positions] of Object.entries(inverted)) for (const p of positions) words[p] = word;
  return words.join(' ');
};

export async function fetchPapers({ from, to }) {
  const papers = [];
  let cursor = '*';
  for (let page = 0; page < 10 && cursor; page++) {
    const q = new URLSearchParams({
      search: '"molecular dynamics"',
      // Only papers: OpenAlex also lists datasets and supplementary files (Zenodo, Figshare…).
      filter: `from_publication_date:${from},to_publication_date:${to},type:article|preprint|review|letter`,
      'per-page': '200',
      cursor,
      select: 'doi,title,abstract_inverted_index,authorships,publication_date,primary_location,best_oa_location,type',
    });
    const data = await getJson(`https://api.openalex.org/works?${q}`);
    for (const x of data.results ?? []) {
      const source = x.primary_location?.source;
      const landing = x.primary_location?.landing_page_url ?? '';
      const arxivId = landing.match(/arxiv\.org\/abs\/([^v?#]+)/)?.[1] ?? null;
      papers.push({
        title: x.title ?? '',
        authors: (x.authorships ?? []).map((a) => a.author?.display_name).filter(Boolean),
        abstract: abstractFrom(x.abstract_inverted_index),
        published: x.publication_date,
        venue: source?.display_name ?? null,
        kind: x.type === 'preprint' || source?.type === 'repository' ? 'preprint' : 'journal',
        doi: x.doi,
        arxivId,
        url: x.doi ?? landing,
        pdfUrl: x.best_oa_location?.pdf_url ?? null,
      });
    }
    cursor = data.meta?.next_cursor;
    await sleep(500);
  }
  return papers;
}
