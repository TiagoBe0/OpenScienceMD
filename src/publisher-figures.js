// Graphical abstracts (or, failing that, the first figure) for papers outside arXiv.
// Most publishers block automated access to their pages, but some serve their images from
// public CDNs under predictable names, so we build the URL from the DOI and check it exists:
//   Elsevier          ars.els-cdn.com, by PII:          <pii>-ga1 (graphical abstract), <pii>-gr1
//   Springer Nature   media.springernature.com:         ..._Figa (graphical abstract), ..._Fig1
//   MDPI              pub.mdpi-res.com:                 <name>-ag-550 (graphical abstract), <name>-g001-550
//   bioRxiv           the full-text page, first figure
// ACS, RSC, Wiley, ChemRxiv, IOP, AIP and Taylor & Francis block us, so their papers get none.
import { USER_AGENT } from './sources/common.js';

const TIMEOUT_MS = 20000;
const MAX_HTML_BYTES = 2 * 1024 * 1024;

const get = (url, headers = {}) =>
  fetch(url, { headers: { 'User-Agent': USER_AGENT, ...headers }, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });

/** True if the URL serves an image. Only the first byte is downloaded. */
async function isImage(url) {
  const res = await get(url, { Range: 'bytes=0-0' });
  await res.body?.cancel();
  // Rate limits are retried later. Any other error means there is no such image: Springer's
  // CDN, for one, answers 502 rather than 404 for a missing image.
  if (res.status === 429 || res.status === 503) throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
  if (!res.ok) return false;
  return /^image\//.test(res.headers.get('content-type') ?? '');
}

/** The first candidate that exists: [{ url, graphicalAbstract }] -> figure or null. */
async function firstImage(candidates) {
  for (const c of candidates) {
    if (await isImage(c.url)) return { images: [c.url], caption: '', graphicalAbstract: c.graphicalAbstract };
  }
  return null;
}

async function elsevier(doi) {
  // The DOI resolver (not the publisher's site) tells us the PII.
  const res = await get(`https://doi.org/api/handles/${encodeURIComponent(doi)}?type=URL`);
  if (!res.ok) return null;
  const target = (await res.json()).values?.[0]?.data?.value ?? '';
  const pii = target.match(/\/pii\/(S?[\dX]+)/i)?.[1];
  if (!pii) return null;
  const base = `https://ars.els-cdn.com/content/image/1-s2.0-${pii.toUpperCase()}`;
  return firstImage([
    { url: `${base}-ga1.jpg`, graphicalAbstract: true },
    { url: `${base}-gr1.jpg`, graphicalAbstract: false },
  ]);
}

async function springerNature(doi) {
  // e.g. 10.1038/s41598-026-74992-5 -> 41598_2026_74992
  const [, journal, year, number] = doi.match(/^10\.\d+\/s(\d+)-(\d{3})-(\d+)-[\dx]$/i) ?? [];
  if (!journal) return null;
  const base = `https://media.springernature.com/lw685/springer-static/image/art%3A${encodeURIComponent(doi)}/MediaObjects/${journal}_${2000 + Number(year)}_${Number(number)}`;
  return firstImage([
    { url: `${base}_Figa_HTML.png`, graphicalAbstract: true },
    { url: `${base}_Fig1_HTML.png`, graphicalAbstract: false },
  ]);
}

async function mdpi(doi) {
  // Images live under the journal's site name and the paper's volume and article number,
  // e.g. 10.3390/polym18202468 -> polymers/polymers-18-02468. Crossref gives us both:
  // the article page (mdpi.com/<issn>/<volume>/<issue>/<article>) and the journal title.
  const res = await get(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
  if (!res.ok) return null;
  const work = (await res.json()).message;
  const [, volume, article] = (work.resource?.primary?.URL ?? '').match(/mdpi\.com\/[\d-X]+\/(\d+)\/\d+\/(\d+)/i) ?? [];
  if (!volume) return null;
  // The site name is usually the title in lower case ("Polymers"), otherwise the DOI's code ("ijms").
  const names = new Set([
    String(work['container-title']?.[0] ?? '').toLowerCase().replace(/[^a-z]/g, ''),
    doi.match(/^10\.3390\/([a-z]+)/i)[1].toLowerCase(),
  ]);
  const candidates = [];
  for (const journal of [...names].filter(Boolean)) {
    const name = `${journal}-${volume.padStart(2, '0')}-${article.padStart(5, '0')}`;
    const base = `https://pub.mdpi-res.com/${journal}/${name}/article_deploy/html/images/${name}`;
    // The 550 px versions are a tenth of the size of the full PNGs.
    candidates.push({ url: `${base}-ag-550.jpg`, graphicalAbstract: true }, { url: `${base}-g001-550.jpg`, graphicalAbstract: false });
  }
  return firstImage(candidates);
}

async function biorxiv(doi, url) {
  const page = /biorxiv\.org\/content\//.test(url ?? '') ? url : `https://www.biorxiv.org/content/${doi}`;
  const res = await get(`${page.replace(/\.full$/, '')}.full`, { Accept: 'text/html' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} from bioRxiv`);
  // Read only until the first figure appears.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let html = '';
  let image = null;
  try {
    while (!image && html.length < MAX_HTML_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      image = html.match(/https:\/\/www\.biorxiv\.org\/content\/biorxiv\/early\/[^"'\s]+?\/F1\.large\.jpg/)?.[0];
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return image ? { images: [image], caption: '', graphicalAbstract: false } : null;
}

const PUBLISHERS = [
  { prefixes: ['10.1016'], find: elsevier },
  { prefixes: ['10.1007', '10.1038', '10.1186', '10.1140'], find: springerNature },
  { prefixes: ['10.3390'], find: mdpi },
  { prefixes: ['10.1101', '10.64898'], find: biorxiv },
];

/** Whether we know how to find a figure for this DOI at all. */
export const supports = (doi) => PUBLISHERS.some((p) => p.prefixes.includes(String(doi ?? '').split('/')[0]));

/** { images, caption, graphicalAbstract } or null. Throws on network errors (retried later). */
export async function findFigure({ doi, absUrl }) {
  const publisher = PUBLISHERS.find((p) => p.prefixes.includes(String(doi ?? '').split('/')[0]));
  return publisher ? publisher.find(doi, absUrl) : null;
}
