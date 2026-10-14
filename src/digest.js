import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import nodemailer from 'nodemailer';
import * as store from './store.js';
import * as topics from './topics.js';
import { scoreMd } from './focus.js';
import { cachedFigure } from './figures.js';
import * as external from './external.js';

const DATA_DIR = path.resolve(import.meta.dirname, '..', 'data');
const DIGEST_FILE = path.join(DATA_DIR, 'digest.json');
const LOGO_FILE = path.resolve(import.meta.dirname, '..', 'public', 'img', 'logo-email.png');
// The email embeds the logo as an attachment, since the app's URL is usually not reachable
// from the mail client; the browser preview loads it from the app instead.
const LOGO_CID = 'logo@opensciencemd';
// Gmail clips emails larger than ~100 KB.
const MAX_PAPERS_IN_EMAIL = 40;
const ABSTRACT_CHARS = 450;
const CHECK_EVERY_MS = 10 * 60 * 1000;

export const config = {
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT ?? 465),
  user: process.env.SMTP_USER,
  pass: process.env.SMTP_PASS,
  from: process.env.MAIL_FROM || process.env.SMTP_USER,
  to: process.env.MAIL_TO,
  hour: Number(process.env.DIGEST_HOUR ?? 8),
  publicUrl: process.env.PUBLIC_URL || `http://localhost:${process.env.PORT ?? 3000}`,
};

export const isConfigured = () => Boolean(config.host && config.user && config.pass && config.to);

// `notified`: ids of papers already emailed, so they are never sent twice.
const state = { lastSentDay: null, notified: new Set() };
let sending = null;

export async function load() {
  try {
    const data = JSON.parse(await readFile(DIGEST_FILE, 'utf8'));
    state.lastSentDay = data.lastSentDay ?? null;
    state.notified = new Set(data.notified ?? []);
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('Could not read data/digest.json:', err.message);
  }
}

async function save() {
  // Only papers still stored (arXiv or the other sources) need to be remembered.
  const kept = new Set([...store.allPapers(), ...external.allPapers()].map((p) => p.id));
  const notified = [...state.notified].filter((id) => kept.has(id));
  state.notified = new Set(notified);
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${DIGEST_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify({ lastSentDay: state.lastSentDay, notified }));
  await rename(tmp, DIGEST_FILE);
}

export function status() {
  return { configured: isConfigured(), to: config.to ?? null, hour: config.hour, lastSentDay: state.lastSentDay };
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const truncate = (s, n) => (s.length > n ? `${s.slice(0, n).replace(/\s+\S*$/, '')}…` : s);

const localDay = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const MD_SECTION = 'Molecular Dynamics';

// First image of the paper's figure, if it was already found (images are hosted by arXiv or the publisher).
function figureHtml(id) {
  const src = cachedFigure(id)?.images[0];
  return src
    ? `<img src="${escapeHtml(src)}" alt="Figure from the paper" style="display:block;max-width:100%;max-height:260px;margin:4px 0 10px;border:1px solid #dcdcdc">`
    : '';
}

/**
 * Papers not yet emailed that are Molecular Dynamics or match a topic,
 * grouped into sections: Molecular Dynamics first, then one per topic.
 */
function pendingSections() {
  const md = { name: MD_SECTION, items: [] };
  const byTopic = new Map(topics.list().map((t) => [t.id, { name: t.name, items: [] }]));
  // arXiv papers, plus the Molecular Dynamics papers found in the other sources.
  for (const paper of [...store.allPapers(), ...external.allPapers()]) {
    if (state.notified.has(paper.id)) continue;
    const mdScore = scoreMd(paper);
    const matches = topics.matchPaper(paper);
    const item = { paper, terms: [...mdScore.terms, ...matches.flatMap((m) => m.terms)], score: mdScore.score };
    if (mdScore.isMd) md.items.push(item);
    else if (matches.length) byTopic.get(matches[0].id)?.items.push(item);
  }
  md.items.sort((a, b) => b.score - a.score || b.paper.published.localeCompare(a.paper.published));
  return [md, ...byTopic.values()].filter((s) => s.items.length);
}

export function build({ embedLogo = false, basePath = '' } = {}) {
  const sections = pendingSections();
  const total = sections.reduce((n, s) => n + s.items.length, 0);

  // Keep the email small: fill sections in order (MD first) up to the limit.
  let budget = MAX_PAPERS_IN_EMAIL;
  const shown = sections
    .map((s) => {
      const items = s.items.slice(0, Math.max(0, budget));
      budget -= items.length;
      return { ...s, items, total: s.items.length };
    })
    .filter((s) => s.items.length);
  const extra = total - shown.reduce((n, s) => n + s.items.length, 0);

  const mdCount = sections.find((s) => s.name === MD_SECTION)?.items.length ?? 0;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const summary = !total
    ? 'No new papers since the last email'
    : mdCount
      ? `${plural(mdCount, 'new Molecular Dynamics paper')}${total > mdCount ? ` + ${total - mdCount} from your topics` : ''}`
      : `${plural(total, 'new paper')} from your topics`;
  const subject = `OpenScienceMD: ${summary}`;

  const serif = "Georgia,'Times New Roman',Times,serif";
  const sans = 'Arial,Helvetica,sans-serif';
  const html = `<!doctype html><html lang="en"><body style="margin:0;background:#f5f5f5;font-family:${sans};color:#1f1f1f">
<div style="max-width:680px;margin:0 auto;background:#ffffff;border-top:4px solid #eb6500">
  <div style="padding:16px 24px;border-bottom:1px solid #dcdcdc">
    <img src="${embedLogo ? `cid:${LOGO_CID}` : `${basePath}/img/logo-email.png`}" alt="OpenScienceMD" width="266" height="80" style="display:block;border:0">
    <div style="margin-top:8px;color:#4c4c4c;font-size:14px"><strong style="color:#1f1f1f">arXiv Physics Alerts</strong> · ${escapeHtml(summary)}</div>
  </div>
  <div style="padding:8px 24px 24px">
  ${shown
    .map(
      (s) => `<h2 style="font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#eb6500;margin:24px 0 4px;padding-bottom:6px;border-bottom:2px solid #eb6500">${escapeHtml(s.name)} · ${s.total}</h2>
  ${s.items
    .map(
      ({ paper: p, terms }) => `<div style="padding:14px 0;border-bottom:1px solid #dcdcdc">
    <div style="font-size:12px;color:#4c4c4c">${
      p.source ? `${p.kind === 'journal' ? 'Journal article' : 'Preprint'} · ${escapeHtml(p.venue ?? p.source)}${p.doi ? ` · DOI ${escapeHtml(p.doi)}` : ''}` : `Preprint · ${escapeHtml(p.primaryCategory)} · arXiv:${escapeHtml(p.id)}`
    }${
      terms.length ? ` · <span style="color:#eb6500">${escapeHtml([...new Set(terms)].join(', '))}</span>` : ''
    }</div>
    <a href="${escapeHtml(p.absUrl)}" style="display:block;margin:6px 0 4px;font-family:${serif};font-size:18px;line-height:1.3;color:#0272b1;text-decoration:none">${escapeHtml(p.title)}</a>
    <div style="font-size:13px;color:#4c4c4c;margin-bottom:8px">${escapeHtml(p.authors.slice(0, 6).join(', '))}${p.authors.length > 6 ? ' et al.' : ''}</div>
    ${figureHtml(p.id)}
    <div style="font-family:${serif};font-size:15px;line-height:1.5">${escapeHtml(truncate(p.abstract, ABSTRACT_CHARS))}</div>
    <div style="margin-top:8px;font-size:13px"><a href="${escapeHtml(p.absUrl)}" style="color:#0272b1">Abstract page</a>${p.pdfUrl ? ` &nbsp;·&nbsp; <a href="${escapeHtml(p.pdfUrl)}" style="color:#0272b1">View PDF</a>` : ''}</div>
  </div>`
    )
    .join('')}`
    )
    .join('')}
  ${extra > 0 ? `<p style="font-size:14px;margin-top:16px">And ${extra} more. <a href="${escapeHtml(config.publicUrl)}" style="color:#0272b1">See them all in the app</a></p>` : ''}
  <p style="color:#707070;font-size:12px;margin-top:24px">Sent by OpenScienceMD. Manage your topics at <a href="${escapeHtml(config.publicUrl)}" style="color:#707070">${escapeHtml(config.publicUrl)}</a>.</p>
  </div>
</div></body></html>`;

  const text = [
    subject,
    '',
    ...shown.flatMap((s) => [`== ${s.name} ==`, ...s.items.map(({ paper: p }) => `- ${p.title}\n  ${p.absUrl}`), '']),
    extra > 0 ? `And ${extra} more: ${config.publicUrl}` : '',
  ].join('\n');

  return { subject, html, text, count: total, ids: sections.flatMap((s) => s.items.map((i) => i.paper.id)) };
}

/** Sends the digest with all pending papers. Returns how many papers it covered. */
export function send({ log = console.log } = {}) {
  sending ??= (async () => {
    try {
      if (!isConfigured()) {
        throw Object.assign(new Error('Email is not configured (set SMTP_* and MAIL_TO in .env).'), { status: 400 });
      }
      const digest = build({ embedLogo: true });
      if (digest.count === 0) {
        state.lastSentDay = localDay();
        log('Email digest: no new matching papers, nothing sent.');
        await save();
        return 0;
      }
      const transport = nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.port === 465,
        auth: { user: config.user, pass: config.pass },
      });
      await transport.sendMail({
        from: config.from,
        to: config.to,
        subject: digest.subject,
        html: digest.html,
        text: digest.text,
        attachments: [{ filename: 'logo.png', path: LOGO_FILE, cid: LOGO_CID }],
      });
      for (const id of digest.ids) state.notified.add(id);
      state.lastSentDay = localDay();
      await save();
      log(`Email digest sent to ${config.to} with ${digest.count} papers.`);
      return digest.count;
    } finally {
      sending = null;
    }
  })();
  return sending;
}

/** Once a day, from DIGEST_HOUR (local time) on, fetches new papers and sends the digest. */
export function schedule() {
  if (!isConfigured()) {
    console.log('Email not configured: daily digest disabled (see .env.example).');
    return;
  }
  console.log(`Daily email digest to ${config.to} from ${config.hour}:00.`);
  const tick = async () => {
    const now = new Date();
    if (now.getHours() < config.hour || state.lastSentDay === localDay(now)) return;
    try {
      await store.refresh();
      await send();
    } catch (err) {
      console.error('Failed to send the digest:', err.message);
    }
  };
  tick();
  setInterval(tick, CHECK_EVERY_MS);
}
