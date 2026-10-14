# OpenScienceMD · arXiv Physics Alerts

A small web app that lists the latest arXiv physics papers with their abstracts,
showing **Molecular Dynamics** papers first, plus personal topics and a daily email digest.
The interface is styled after ScienceDirect. Logo sources are in `data/logo/` (the browser tab icon is the orange “MD” in
`public/img/favicon.svg`); the web-ready
versions (transparent, cropped) are in `public/img/`.

## Usage

```bash
npm install
npm start          # http://localhost:3000
```

On start-up the server downloads the papers from the last 7 days if there is no data or it
is stale, then checks for new papers every 3 hours. “Check for new papers” forces a check.

## Molecular Dynamics first

Every paper is scored by the MD-related terms in its title and abstract (molecular dynamics,
AIMD, LAMMPS, GROMACS, interatomic / machine-learned potentials, force fields, Martini,
thermostats, Green–Kubo, …; title matches count double). Papers above a threshold are tagged
**Molecular Dynamics**:

- The app opens on the **Molecular Dynamics** tab, which only shows those papers.
- The **All physics** tab shows everything, with MD papers first, then papers matching your
  topics, then the rest.
- “newest first” (default) lists the latest day on top and, within each day, the most
  interesting papers first. “most interesting” ignores the day. No API exports readership, so
  “interesting” is a heuristic: MD score, topic matches, figure, journal venue, number of
  sources that index it, and citations when OpenAlex / Semantic Scholar report them
  (new papers rarely have any yet).
- The list is compact: each paper shows its figure, title and authors. Click a title to see
  the figure caption, abstract, MD keywords and links, or use “Expand all”.
- Filters (“Refine by”: topics, subject area, submission date) are dropdowns above the list.

The term list and weights live in `src/focus.js`.

## Figures (graphical abstracts)

arXiv has no graphical abstracts, so the app shows a figure taken from the paper's HTML
version (`arxiv.org/html/<id>`) next to every paper: an image named like a TOC /
graphical abstract if there is one, otherwise the first figure (its caption is shown when the
paper is expanded). Papers without an HTML version (roughly 1 in 5) show no figure.

Papers from the other sources (below) get the publisher's **graphical abstract** when it can be
reached, otherwise the paper's first figure (`src/publisher-figures.js`). Most publishers block
automated access to their pages, but some serve images from public CDNs under names that can be
built from the DOI, so the app builds the URL and checks that the image exists:

| Publisher | How | Graphical abstract / fallback |
|---|---|---|
| Elsevier (10.1016) | PII from the DOI resolver, `ars.els-cdn.com` | `-ga1` / `-gr1` |
| Springer Nature, BMC (10.1007, 10.1038, 10.1186, 10.1140) | `media.springernature.com` | `_Figa` / `_Fig1` |
| MDPI (10.3390) | volume and article number from Crossref, `pub.mdpi-res.com` | `-ag` / `-g001` |
| bioRxiv (10.1101, 10.64898) | first figure of the full-text page | — / `F1` |

ACS, RSC, Wiley, ChemRxiv, IOP, AIP and Taylor & Francis block automated requests, so their papers
have no figure (about 60% of these papers). Papers whose figure was not found are checked again
after a day.

**Papers with a figure come first** in every list (within Molecular Dynamics, topics and the rest).
arXiv papers without a figure are hidden by default (a note at the end of the list shows how many,
with a “Show them” link); papers from the other sources are always listed, after those with a figure. After each refresh the server checks every paper for a figure in
the background (arXiv and publishers in separate queues, one request every 1.5 s), Molecular Dynamics papers first, so the lists fill in as figures are confirmed.
Only the start of each HTML page is downloaded, up to the first figure with an image. Results are cached in `data/figures.json`, and the
images themselves are loaded from arxiv.org or the publisher. The email digest includes the figure when it is
already cached.

## Other sources (Molecular Dynamics only)

Besides arXiv, the server looks for new Molecular Dynamics papers in six free APIs after each
refresh (`src/sources/`): **bioRxiv**, **Crossref** (journal articles, plus ChemRxiv and other
preprints, since ChemRxiv's own API blocks automated access), **Europe PMC**, **Semantic
Scholar**, **DOAJ** and **OpenAlex**. They pass a stricter test than arXiv papers
(`isStrictMd` in `src/focus.js`): MD must be central (score ≥ 4), and biomedical “docking + short
MD” studies are left out. Papers found by several sources are merged (by DOI or title), and
papers already on arXiv are skipped. Zenodo/Figshare deposits are ignored. They are stored in
`data/external.json` for 7 days, shown in the Molecular Dynamics tab (with a figure when the
publisher allows it, see above), and can
be filtered with **Refine by → Source**. Roughly 200–250 papers a week.

## PDF archive (Molecular Dynamics)

With `ARCHIVE_PDFS=true`, every Molecular Dynamics paper from arXiv, and every paper from the
other sources with an open-access PDF, is archived permanently in
`archive/` (or `ARCHIVE_DIR`): the PDF under `archive/pdf/YYYY/MM/<id>.pdf`, and the paper's
data plus the PDF's full text in `archive/papers.sqlite`, with an SQLite FTS5 index for
full-text search. Unlike the 7-day paper list, nothing in the archive is ever deleted. PDFs
are downloaded from `export.arxiv.org` one at a time (5 s apart) after each refresh; failures
are retried up to 3 times, except publishers that block automated downloads (ACS, Wiley,
ScienceDirect, ChemRxiv…), which are not asked again. The archive is private: it is not served by the web app.

```bash
npm run archive -- stats                      # counts, size, date range
npm run archive -- search lennard jones       # full-text search (title, abstract, PDF body)
npm run archive -- run                        # archive pending papers now
npm run archive -- verify                     # check every PDF is on disk
```

In the web app, the admin also gets a private **Archive** tab (hidden from visitors; every
archive endpoint, PDF downloads included, requires the admin session). There, the search box
searches the full text of the archived PDFs, results show the matching passage, and “Open
archived PDF” opens the stored copy.

Tables: `papers` (metadata, MD score/terms, figure, `pdf_path`, `pdf_bytes`, `pdf_sha256`,
`pages`, `status`) and `papers_fts` (`title`, `abstract`, `body`). Any SQLite client works,
e.g. `sqlite3 archive/papers.sqlite`. MD PDFs average ~8–10 MB, roughly 12 GB a year.

## Topics

“My topics & alerts” lets you create topics with:

- **Keywords**, searched in the title and abstract. They match the start of a word, so
  `superconduct` finds `superconductivity`.
- **arXiv categories** (optional), e.g. `cond-mat.supr-con` or `gr-qc`. With categories,
  only papers in them are matched; with categories alone, all their papers match.

Matching papers are tagged, the words are highlighted, and you can filter by topic.

## Daily email digest

1. Copy `.env.example` to `.env` and fill in the SMTP settings and `MAIL_TO`.
   With Gmail you need an [app password](https://myaccount.google.com/apppasswords).
2. Restart the server.

Every day from `DIGEST_HOUR` on, the server checks for new papers and emails the ones that
are Molecular Dynamics or match your topics and have not been sent before (MD first; at most
40 per email, the rest are linked to the app). Nothing is sent if there is nothing new. The
topics dialog has an email preview and a “Send now” button. `npm run digest` does the same
from the terminal, if you prefer cron to keeping the server running.

## How it works

- **Source:** the arXiv search API (`export.arxiv.org/api/query`), sorted by submission
  date. arXiv has no push notifications, so the server polls it, keeping to the limit of one
  request every 3 seconds.
- **Physics filter:** every arXiv physics archive (`astro-ph`, `cond-mat`, `gr-qc`, `hep-*`,
  `math-ph`, `nlin`, `nucl-*`, `physics.*`, `quant-ph`), including papers from other fields
  cross-listed to one of them. See `src/categories.js`.
- **Storage:** `data/papers.json`, `data/topics.json`, `data/digest.json` (papers already
  emailed) and `data/figures.json`. They are created automatically.
- **Formulas:** LaTeX in abstracts is rendered with MathJax.

## Configuration

Variables are read from `.env` (see `.env.example`, which also lists the email settings).

| Variable        | Default     | Purpose                                         |
|-----------------|-------------|-------------------------------------------------|
| `PORT`          | `3000`      | Server port                                     |
| `HOST`          | `127.0.0.1` | `0.0.0.0` to expose it on your network (no login) |
| `KEEP_DAYS`     | `7`         | Days of papers to keep                          |
| `REFRESH_HOURS` | `3`         | How often to check for new papers               |

`npm run fetch` downloads new papers and exits (handy for cron).

## Deployment (malbecmotion.com/sbs/openscience)

Runs on the IBM server (`ssh ibm`, user `simaf`) in `/home/simaf/sbergamin/openscience`, under
pm2 as `openscience` on `127.0.0.1:3120`. It is published by the existing Cloudflare tunnel
(`~/.cloudflared/config.yml`, pm2 process `cloudflared-psicolink`) with the ingress rule
`path: ^/sbs/openscience(/|$)`, placed before the catch-all `malbecmotion.com` rule.

Production settings are in the server's `.env` (`BASE_PATH=/sbs/openscience`,
`ADMIN_PASSWORD`, `SESSION_SECRET`, SMTP). With `ADMIN_PASSWORD` set, visitors can read
everything; topics, “Check for new papers” and sending email need the admin login.

To deploy changes (Cloudflare and browsers cache images, CSS and JS for 4 hours, so when one of
them changes, bump the `?v=` number on its URLs in `public/index.html`):

```bash
rsync -az --exclude node_modules --exclude data --exclude archive --exclude .env ./ ibm:/home/simaf/sbergamin/openscience/
ssh ibm 'cd /home/simaf/sbergamin/openscience && npm ci --omit=dev && pm2 restart openscience'
```
