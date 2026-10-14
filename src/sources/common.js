// Shared helpers for the extra literature sources. Every source returns papers as:
// { title, authors: [], abstract, published: 'YYYY-MM-DD', venue, kind: 'journal' | 'preprint',
//   doi, arxivId, url, pdfUrl }   (pdfUrl only when an open-access PDF is known)

export const USER_AGENT = 'arxiv-alert/1.0 (personal research reading app)';
export const MD_QUERY = 'molecular dynamics';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const stripTags = (s) =>
  String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
export const normDoi = (doi) =>
  String(doi ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
    .replace(/^doi:/, '') || null;
export const isoDay = (d) => (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10);

/** GET JSON, retrying on rate limits and server errors with a growing pause. */
export async function getJson(url, { retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
    if (res.ok) return res.json();
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= retries) {
      throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
    }
    await res.body?.cancel();
    await sleep(5000 * (attempt + 1));
  }
}

// DOI prefixes of preprint servers, to name the server when an API only gives the DOI.
const PREPRINT_PREFIXES = {
  '10.1101': 'bioRxiv',
  '10.64898': 'bioRxiv', // openRxiv, bioRxiv's newer DOI prefix
  '10.26434': 'ChemRxiv',
  '10.21203': 'Research Square',
  '10.20944': 'Preprints.org',
  '10.2139': 'SSRN',
  '10.48550': 'arXiv',
};

export function preprintServer(doi) {
  return PREPRINT_PREFIXES[String(doi ?? '').split('/')[0]] ?? null;
}

// Self-publishing repositories: deposits there are not peer reviewed nor moderated preprints.
const REPOSITORY_PREFIXES = ['10.5281', '10.6084']; // Zenodo, Figshare
export const isRepositoryDeposit = (doi) => REPOSITORY_PREFIXES.includes(String(doi ?? '').split('/')[0]);
