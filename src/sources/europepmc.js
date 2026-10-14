// Europe PMC: life-science journals and preprints, with abstracts.
import { getJson, stripTags } from './common.js';

export const name = 'Europe PMC';

export async function fetchPapers({ from, to }) {
  const query = `(TITLE_ABS:"molecular dynamics" OR TITLE_ABS:"MD simulation" OR TITLE_ABS:"MD simulations") AND FIRST_PDATE:[${from} TO ${to}]`;
  const papers = [];
  let cursor = '*';
  for (let page = 0; page < 5; page++) {
    const q = new URLSearchParams({ query, format: 'json', resultType: 'core', pageSize: '1000', cursorMark: cursor });
    const data = await getJson(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?${q}`);
    for (const x of data.resultList?.result ?? []) {
      const preprint = x.source === 'PPR';
      const pdf = x.fullTextUrlList?.fullTextUrl?.find((u) => u.documentStyle === 'pdf' && /open|free/i.test(u.availability ?? ''));
      papers.push({
        title: stripTags(x.title),
        authors: (x.authorList?.author ?? []).map((a) => a.fullName).filter(Boolean),
        abstract: stripTags(x.abstractText),
        published: x.firstPublicationDate,
        venue: preprint ? x.bookOrReportDetails?.publisher ?? 'Preprint' : x.journalInfo?.journal?.title ?? null,
        kind: preprint ? 'preprint' : 'journal',
        doi: x.doi,
        url: x.doi ? `https://doi.org/${x.doi}` : `https://europepmc.org/article/${x.source}/${x.id}`,
        pdfUrl: pdf?.url ?? null,
      });
    }
    if (!data.nextCursorMark || data.nextCursorMark === cursor || !data.resultList?.result?.length) break;
    cursor = data.nextCursorMark;
  }
  return papers;
}
