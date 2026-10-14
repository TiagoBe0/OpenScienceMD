// Semantic Scholar bulk search (no API key: shared rate limit, so 429s are retried).
import { getJson, sleep } from './common.js';

export const name = 'Semantic Scholar';

export async function fetchPapers({ from, to }) {
  const papers = [];
  let token = null;
  for (let page = 0; page < 5; page++) {
    const q = new URLSearchParams({
      query: '"molecular dynamics"',
      publicationDateOrYear: `${from}:${to}`,
      fields: 'title,abstract,authors,externalIds,venue,journal,publicationDate,publicationTypes,openAccessPdf,url,citationCount,influentialCitationCount',
    });
    if (token) q.set('token', token);
    const data = await getJson(`https://api.semanticscholar.org/graph/v1/paper/search/bulk?${q}`);
    for (const x of data.data ?? []) {
      const ids = x.externalIds ?? {};
      papers.push({
        title: x.title ?? '',
        authors: (x.authors ?? []).map((a) => a.name).filter(Boolean),
        abstract: x.abstract ?? '',
        published: x.publicationDate,
        venue: x.journal?.name || x.venue || null,
        kind: (x.publicationTypes ?? []).includes('JournalArticle') ? 'journal' : 'preprint',
        doi: ids.DOI ?? null,
        arxivId: ids.ArXiv ?? null,
        url: ids.DOI ? `https://doi.org/${ids.DOI}` : x.url,
        pdfUrl: x.openAccessPdf?.url || null,
        // Influential citations weigh more: they are the ones that build on the paper.
        citations: (x.citationCount ?? 0) + 3 * (x.influentialCitationCount ?? 0),
      });
    }
    token = data.token;
    if (!token) break;
    await sleep(3000);
  }
  return papers;
}
