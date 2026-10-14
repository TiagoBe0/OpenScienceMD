// DOAJ: articles from curated open-access journals, newest first.
import { getJson, sleep } from './common.js';

export const name = 'DOAJ';

export async function fetchPapers({ from }) {
  const papers = [];
  for (let page = 1; page <= 5; page++) {
    const data = await getJson(
      `https://doaj.org/api/search/articles/${encodeURIComponent('"molecular dynamics"')}?page=${page}&pageSize=100&sort=created_date:desc`
    );
    const results = data.results ?? [];
    for (const x of results) {
      if (x.created_date.slice(0, 10) < from) continue;
      const b = x.bibjson;
      const doi = b.identifier?.find((i) => i.type?.toLowerCase() === 'doi')?.id;
      const link = b.link?.find((l) => l.type === 'fulltext');
      papers.push({
        title: b.title ?? '',
        authors: (b.author ?? []).map((a) => a.name).filter(Boolean),
        abstract: b.abstract ?? '',
        published: x.created_date.slice(0, 10),
        venue: b.journal?.title ?? null,
        kind: 'journal',
        doi,
        url: doi ? `https://doi.org/${doi}` : link?.url,
        pdfUrl: link?.content_type?.toLowerCase() === 'pdf' ? link.url : null,
      });
    }
    // Sorted newest first: stop once a page reaches papers older than the window.
    if (!results.length || results.at(-1).created_date.slice(0, 10) < from) break;
    await sleep(1000);
  }
  return papers;
}
