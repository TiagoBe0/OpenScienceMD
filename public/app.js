const $ = (id) => document.getElementById(id);

// fig: '' lists only papers with a figure; 'all' includes those without one.
const filters = { scope: 'md', sort: 'relevance', topic: '', area: '', day: '', source: '', q: '', fig: '' };
let page = 1;
let pages = 1;
let areaLabels = {};
let topicList = [];
let editingId = null;
let expandAll = false;
let session = { authRequired: false, admin: true, archive: false };
// The archive keeps its own search text, separate from the papers list.
const archiveState = { q: '', page: 1, pages: 1 };

const initialTopic = new URLSearchParams(location.search).get('topic');
if (initialTopic) {
  filters.topic = initialTopic;
  filters.scope = 'all';
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const shortDateFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const dateTimeFmt = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
const asUtcNoon = (iso) => new Date(`${iso.slice(0, 10)}T12:00:00Z`);

const ICONS = {
  chevron: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 6l5 5 5-5" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  pdf: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 1h7l3 3v11H3z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5 9h6M5 12h6M5 6h3" stroke="currentColor" stroke-width="1.5"/></svg>',
  external: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 2h5v5M14 2L7 9M12 10v4H2V4h4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

const plural = (n, word) => `${n.toLocaleString('en-GB')} ${word}${n === 1 ? '' : 's'}`;

// --- Refine-by dropdowns (single choice; clicking the active one clears it) ---

const facetLabels = { topic: {}, area: {}, day: {}, source: {} };

// Each dropdown's button shows its current choice, e.g. "Subject area: Condensed Matter".
function updateFilterSummaries() {
  for (const details of document.querySelectorAll('.filter')) {
    const key = details.dataset.key;
    const summary = details.querySelector('summary');
    const label = filters[key] && (facetLabels[key][filters[key]] ?? '…');
    summary.textContent = label ? `${summary.dataset.title}: ${label}` : summary.dataset.title;
    details.classList.toggle('active', Boolean(filters[key]));
  }
  $('clear-filters').hidden = !(filters.topic || filters.area || filters.day || filters.source);
}

function renderFacet(el, items, key, emptyText) {
  facetLabels[key] = Object.fromEntries(items.map((i) => [i.value, i.label]));
  if (!items.length) {
    el.innerHTML = `<li class="facet-empty">${emptyText}</li>`;
    el.onclick = null;
    return;
  }
  el.innerHTML = items
    .map(
      (i) => `<li><button type="button" data-value="${escapeHtml(i.value)}" aria-pressed="${filters[key] === i.value}">
        <span class="facet-label">${escapeHtml(i.label)}</span><span class="facet-count">${i.count}</span></button></li>`
    )
    .join('');
  el.onclick = (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    filters[key] = filters[key] === btn.dataset.value ? '' : btn.dataset.value;
    for (const b of el.querySelectorAll('button')) b.setAttribute('aria-pressed', b.dataset.value === filters[key]);
    el.closest('details').open = false;
    updateFilterSummaries();
    loadPapers();
  };
}

// Only one dropdown open at a time; clicking elsewhere or pressing Escape closes them.
for (const details of document.querySelectorAll('.filter')) {
  details.addEventListener('toggle', () => {
    if (!details.open) return;
    for (const other of document.querySelectorAll('.filter[open]')) if (other !== details) other.open = false;
  });
}
const closeFilters = () => {
  for (const d of document.querySelectorAll('.filter[open]')) d.open = false;
};
document.addEventListener('click', (e) => {
  if (!e.target.closest('.filter')) closeFilters();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeFilters();
});

$('clear-filters').addEventListener('click', async () => {
  filters.topic = filters.area = filters.day = filters.source = '';
  await loadStats();
  await loadPapers();
});

function renderEmailStatus(email) {
  const lines = email.configured
    ? [
        `A digest is emailed daily to <strong>${escapeHtml(email.to)}</strong> from ${email.hour}:00, with new Molecular Dynamics papers first and then papers from your topics.`,
        email.lastSentDay ? `Last sent: ${escapeHtml(email.lastSentDay)}.` : 'No digest sent yet.',
      ]
    : ['Email is not configured. Copy <code>.env.example</code> to <code>.env</code>, fill in the SMTP settings and restart the server.'];
  $('email-status').innerHTML = lines.map((l) => `<p>${l}</p>`).join('');
  $('send-now').disabled = !email.configured;
}

async function loadStats() {
  const stats = await api(`api/stats?scope=${filters.scope}&fig=${filters.fig}`);
  areaLabels = Object.fromEntries(stats.areas.map((a) => [a.id, a.label]));
  topicList = stats.topics;

  // Drop the topic filter if that topic no longer exists.
  if (filters.topic && filters.topic !== '__any' && !topicList.some((t) => t.id === filters.topic)) filters.topic = '';

  $('count-md').textContent = `(${stats.scopes.md})`;
  $('count-all').textContent = `(${stats.scopes.all.toLocaleString('en-GB')})`;

  renderFacet(
    $('topics'),
    stats.topics.length
      ? [
          { value: '__any', label: 'Any of my topics', count: stats.topicsTotal },
          ...stats.topics.map((t) => ({ value: t.id, label: t.name, count: t.count })),
        ]
      : [],
    'topic',
    'No topics yet. Use “My topics &amp; alerts” to add one.'
  );
  renderFacet(
    $('areas'),
    stats.areas.filter((a) => a.count).map((a) => ({ value: a.id, label: a.label, count: a.count })),
    'area',
    'No papers.'
  );
  renderFacet(
    $('days'),
    stats.days.map((d) => ({ value: d.day, label: shortDateFmt.format(asUtcNoon(d.day)), count: d.count })),
    'day',
    'No papers.'
  );
  renderFacet(
    $('sources'),
    stats.sources.map((x) => ({ value: x.id, label: x.label, count: x.count })),
    'source',
    'No papers.'
  );
  updateFilterSummaries();
  renderTopicManager();
  renderEmailStatus(stats.email);

  lastStats = stats;
  renderFreshness();
  $('refresh').disabled = stats.refreshing;
  return stats;
}

// --- Freshness indicator ---

let lastStats = null;
const relativeFmt = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

function ago(date) {
  const minutes = Math.round((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return relativeFmt.format(-minutes, 'minute');
  const hours = Math.round(minutes / 60);
  return hours < 48 ? relativeFmt.format(-hours, 'hour') : relativeFmt.format(-Math.round(hours / 24), 'day');
}

function renderFreshness() {
  const stats = lastStats;
  if (!stats) return;
  const times = [stats.lastRefresh, stats.lastRefreshOther].filter(Boolean).map((t) => new Date(t));
  const last = times.length ? new Date(Math.max(...times)) : null;
  // Overdue when a scheduled check seems to have been missed.
  const overdue = last && Date.now() - last.getTime() > 2 * stats.refreshHours * 60 * 60 * 1000;
  const state = stats.refreshing ? 'checking' : !last ? 'loading' : overdue ? 'stale' : 'fresh';
  const text = {
    checking: '<strong>Checking for new papers…</strong>',
    loading: 'No data yet.',
    stale: `Last checked <strong>${last && ago(last)}</strong>`,
    fresh: `<strong>Up to date</strong> · checked ${last && ago(last)}`,
  }[state];
  $('status').dataset.state = state;
  $('status-text').innerHTML = text;
  $('status').title = [
    `${plural(stats.stored, 'arXiv physics paper')} + ${plural(stats.otherSources, 'Molecular Dynamics paper')} from journals and preprints.`,
    last ? `Last checked ${dateTimeFmt.format(last)}; sources are checked every ${stats.refreshHours} hours.` : '',
  ].join('\n');
}

// Keep "checked N minutes ago" current, and pick up the server's own scheduled checks.
setInterval(renderFreshness, 60 * 1000);
setInterval(() => {
  if (!document.hidden && !lastStats?.refreshing) loadStats().catch(() => {});
}, 5 * 60 * 1000);

// --- Results ---

function authorsLine(authors) {
  const max = 6;
  return authors.length > max ? `${authors.slice(0, max).join(', ')} et al.` : authors.join(', ');
}

// Highlights matched words, leaving $…$ formulas untouched so MathJax still parses them.
function highlight(text, terms) {
  if (!terms.length) return escapeHtml(text);
  const sorted = [...terms].sort((a, b) => b.length - a.length).map(escapeRegex);
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(${sorted.join('|')})`, 'giu');
  return text
    .split(/(\$[^$]+\$)/)
    .map((part, i) =>
      i % 2
        ? escapeHtml(part)
        : part
            .split(re)
            .map((s, j) => (j % 2 ? `<mark>${escapeHtml(s)}</mark>` : escapeHtml(s)))
            .join('')
    )
    .join('');
}

function paperHtml(p) {
  const terms = [...new Set([...p.md.words, ...p.topics.flatMap((t) => t.terms)])];
  const isArxiv = p.source === 'arXiv';
  const badges = [
    `<span>${p.kind === 'journal' ? 'Journal article' : 'Preprint'}</span>`,
    isArxiv || p.pdfUrl ? '<span class="open-access">Open access</span>' : '',
    p.source === 'Journals' ? '' : `<span class="badge-source">${escapeHtml(p.source)}</span>`,
    p.md.isMd ? '<span class="badge-md">Molecular Dynamics</span>' : '',
    ...p.topics.map((t) => `<span class="badge-topic">${escapeHtml(t.name)}</span>`),
  ].join('');
  // Collapsed: figure, title and authors. The title expands the details.
  const detailsId = `details-${p.id.replace(/[^\w-]/g, '-')}`;
  const withFigure = Boolean(p.figure?.images.length);
  return `<li class="result${withFigure ? '' : ' no-figure'}">
    ${figureHtml(p.figure)}
    <div class="result-main">
    <h3 class="result-title">
      <button type="button" class="toggle" aria-expanded="${expandAll}" aria-controls="${detailsId}">${ICONS.chevron}<span>${highlight(p.title, terms)}</span></button>
    </h3>
    <p class="result-authors">${escapeHtml(authorsLine(p.authors))}${
      isArxiv ? '' : ` <span class="venue">· ${escapeHtml(p.venue ?? p.source)}</span>`
    }</p>
    <div class="result-details" id="${detailsId}"${expandAll ? '' : ' hidden'}>
      <p class="result-type">${badges}</p>
      <p class="result-source">${
        isArxiv
          ? `arXiv: ${escapeHtml(p.primaryCategory)}, ${escapeHtml(dateFmt.format(asUtcNoon(p.published)))}, arXiv:${escapeHtml(p.id)}`
          : `${escapeHtml(p.venue ?? p.source)}, ${escapeHtml(dateFmt.format(asUtcNoon(p.published)))}${p.doi ? `, DOI ${escapeHtml(p.doi)}` : ''}<br>Found via ${escapeHtml(p.foundIn.join(', '))}`
      }</p>
      <p class="figure-caption" data-caption-for="${escapeHtml(p.id)}">${captionHtml(p.figure)}</p>
      ${p.abstract ? `<p class="abstract">${highlight(p.abstract, terms)}</p>` : '<p class="abstract missing">The source does not provide an abstract for this paper.</p>'}
      ${p.md.isMd ? `<p class="keywords"><strong>MD keywords:</strong> ${escapeHtml(p.md.terms.join(', '))}</p>` : ''}
      ${p.comment ? `<p class="comment">${escapeHtml(p.comment)}</p>` : ''}
      <div class="result-actions">
        ${p.pdfUrl ? `<a href="${escapeHtml(p.pdfUrl)}" target="_blank" rel="noopener">${ICONS.pdf}View PDF</a>` : ''}
        <a href="${escapeHtml(p.absUrl)}" target="_blank" rel="noopener">${ICONS.external}${
          isArxiv ? 'arXiv page' : p.kind === 'journal' ? 'Journal page' : 'Preprint page'
        }</a>
      </div>
    </div>
    </div>
  </li>`;
}

// --- Figures ("graphical abstracts") ---

const figureLabel = (figure) => (figure.graphicalAbstract ? 'Graphical abstract' : 'Figure from the paper');

// The figure shown next to the title. Panels of a multi-part figure are tiled.
function figureHtml(figure) {
  if (!figure?.images.length) return '';
  const label = figureLabel(figure);
  return `<figure class="result-figure${figure.images.length > 1 ? ' panels' : ''}">
    ${figure.images
      .map((src) => `<a href="${escapeHtml(largeSrc(src))}" target="_blank" rel="noopener" title="Open full size"><img src="${escapeHtml(src)}" alt="${label}" loading="lazy"></a>`)
      .join('')}
    ${figure.graphicalAbstract ? '<figcaption class="figure-tag">Graphical abstract</figcaption>' : ''}
  </figure>`;
}

// The caption goes with the details, so the collapsed row stays short.
function captionHtml(figure) {
  if (!figure?.images.length || !figure.caption) return '';
  return `<strong>${figureLabel(figure)}.</strong> ${escapeHtml(figure.caption)}`;
}

// Figure boxes keep a placeholder size until their image loads; a broken image is removed.
document.addEventListener(
  'load',
  (e) => {
    if (e.target.matches?.('.result-figure img')) e.target.closest('.result-figure').classList.add('ready');
  },
  true
);
document.addEventListener(
  'error',
  (e) => {
    if (!e.target.matches?.('.result-figure img')) return;
    const figure = e.target.closest('.result-figure');
    e.target.closest('a').remove();
    if (!figure.querySelector('img')) {
      figure.closest('.result').classList.add('no-figure');
      figure.remove();
    }
  },
  true
);

// Hovering a thumbnail shows the figure enlarged beside it (on devices with a mouse;
// on touch screens a tap opens the full-size image instead).
const zoom = Object.assign(document.createElement('figure'), { className: 'figure-zoom', hidden: true });
zoom.append(document.createElement('img'));
document.body.append(zoom);
const canHover = matchMedia('(hover: hover)');

// Thumbnails are small versions; the zoom asks the publisher for the large one.
const largeSrc = (src) =>
  src
    .replace(/^(https:\/\/ars\.els-cdn\.com\/.+)\.jpg$/, '$1_lrg.jpg')
    .replace('media.springernature.com/lw685/', 'media.springernature.com/full/')
    .replace(/^(https:\/\/pub\.mdpi-res\.com\/.+)-550\.jpg$/, '$1.png');

function placeZoom(thumb) {
  const r = thumb.getBoundingClientRect();
  const gap = 12;
  const { width, height } = zoom.getBoundingClientRect();
  // To the right of the thumbnail if it fits, otherwise to its left; kept inside the window.
  let left = r.right + gap;
  if (left + width > innerWidth - gap) left = Math.max(gap, r.left - gap - width);
  const top = Math.min(Math.max(gap, r.top + r.height / 2 - height / 2), innerHeight - height - gap);
  zoom.style.left = `${left}px`;
  zoom.style.top = `${Math.max(gap, top)}px`;
}

document.addEventListener('mouseover', (e) => {
  const thumb = e.target.closest?.('.result-figure img');
  if (!thumb || !canHover.matches) return;
  const img = zoom.firstChild;
  const large = largeSrc(thumb.src);
  img.alt = thumb.alt;
  img.onload = () => placeZoom(thumb);
  // Show the thumbnail scaled up at once, then the sharp version when it arrives.
  img.onerror = () => (img.src = thumb.src);
  img.src = thumb.src;
  if (large !== thumb.src) {
    const sharp = new Image();
    sharp.onload = () => {
      if (!zoom.hidden && img.src === thumb.src) img.src = large;
    };
    sharp.src = large;
  }
  zoom.hidden = false;
  placeZoom(thumb);
});
document.addEventListener('mouseout', (e) => {
  if (e.target.closest?.('.result-figure img')) zoom.hidden = true;
});
addEventListener('scroll', () => (zoom.hidden = true), { passive: true });

function typeset(el) {
  window.MathJax?.typesetPromise?.([el]).catch(() => {});
}

function emptyMessage() {
  return filters.scope === 'md'
    ? '<li class="empty">No Molecular Dynamics papers match these filters. Try the <button type="button" class="link-button" data-goto="all">All physics</button> tab.</li>'
    : '<li class="empty">No papers match these filters.</li>';
}

// Papers without a figure are hidden by default; this line says so and lets you show them.
function renderFigureNote(data) {
  const note = $('figure-note');
  const pending = data.unchecked
    ? ` Figures for ${plural(data.unchecked, 'paper')} are still being checked; they appear when ready.`
    : '';
  if (filters.fig === 'all') {
    note.innerHTML = 'Showing papers without a figure too. <button type="button" class="link-button" data-fig="">Hide them</button>';
  } else if (data.withoutFigure) {
    const known = data.withoutFigure - data.unchecked;
    note.innerHTML = `${known ? `${plural(known, 'paper')} without a figure ${known === 1 ? 'is' : 'are'} hidden.` : ''}${pending} <button type="button" class="link-button" data-fig="all">Show them</button>`;
  } else {
    note.innerHTML = '';
  }
  note.hidden = !note.innerHTML;
}

$('figure-note').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-fig]');
  if (!btn) return;
  filters.fig = btn.dataset.fig;
  await loadStats();
  await loadPapers();
});

// Responses can arrive out of order (e.g. while typing a search); only the latest counts.
let papersRequest = 0;

async function loadPapers({ append = false } = {}) {
  const request = ++papersRequest;
  const nextPage = append ? page + 1 : 1;
  const params = new URLSearchParams({ page: nextPage });
  for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);

  const data = await api(`api/papers?${params}`);
  if (request !== papersRequest) return;
  page = nextPage;
  pages = data.pages;

  const list = $('papers');
  const html = data.papers.map(paperHtml).join('');
  if (append) {
    const start = list.children.length;
    list.insertAdjacentHTML('beforeend', html);
    for (const li of [...list.children].slice(start)) typeset(li);
  } else {
    list.innerHTML = html || emptyMessage();
    typeset(list);
  }
  renderFigureNote(data);

  $('summary').textContent = plural(data.total, 'result');
  $('more').hidden = page >= pages;
}

async function setScope(scope) {
  const toArchive = scope === 'archive';
  const fromArchive = filters.scope === 'archive';
  filters.scope = scope;
  for (const tab of document.querySelectorAll('.tab')) tab.setAttribute('aria-selected', tab.dataset.scope === scope);
  $('papers-view').hidden = toArchive;
  $('archive-view').hidden = !toArchive;
  $('search').placeholder = toArchive ? 'Search inside archived PDFs' : 'Search papers';
  if (toArchive !== fromArchive) $('search').value = toArchive ? archiveState.q : filters.q;
  if (toArchive) return loadArchive();
  await loadStats();
  await loadPapers();
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.setAttribute('aria-selected', tab.dataset.scope === filters.scope);
  tab.addEventListener('click', () => setScope(tab.dataset.scope));
}

for (const btn of document.querySelectorAll('.sort-option')) {
  btn.addEventListener('click', () => {
    filters.sort = btn.dataset.sort;
    for (const b of document.querySelectorAll('.sort-option')) b.setAttribute('aria-pressed', b === btn);
    loadPapers();
  });
}

$('papers').addEventListener('click', (e) => {
  if (e.target.closest('[data-goto]')) return setScope('all');
  const btn = e.target.closest('.toggle');
  if (!btn) return;
  setExpanded(btn, btn.getAttribute('aria-expanded') !== 'true');
});

function setExpanded(btn, open) {
  btn.setAttribute('aria-expanded', open);
  $(btn.getAttribute('aria-controls')).hidden = !open;
}

$('expand-all').addEventListener('click', () => {
  expandAll = !expandAll;
  $('expand-all').setAttribute('aria-pressed', expandAll);
  $('expand-all').textContent = expandAll ? 'Collapse all' : 'Expand all';
  for (const btn of document.querySelectorAll('#papers .toggle')) setExpanded(btn, expandAll);
});

$('more').addEventListener('click', () => loadPapers({ append: true }));

let searchTimer;
const runSearch = () => {
  clearTimeout(searchTimer);
  if (filters.scope === 'archive') {
    archiveState.q = $('search').value.trim();
    return loadArchive();
  }
  filters.q = $('search').value.trim();
  loadPapers();
};
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 250);
});
$('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  runSearch();
});

// --- Topics dialog ---

function renderTopicManager() {
  $('topic-list').innerHTML = topicList.length
    ? topicList
        .map(
          (t) => `<li data-id="${escapeHtml(t.id)}">
        <div>
          <strong>${escapeHtml(t.name)}</strong>
          ${t.keywords.length ? `<div class="topic-meta">Keywords: ${escapeHtml(t.keywords.join(', '))}</div>` : ''}
          ${t.categories.length ? `<div class="topic-meta">Categories: ${escapeHtml(t.categories.join(', '))}</div>` : ''}
        </div>
        <div class="row-actions">
          <button type="button" data-action="edit">Edit</button>
          <button type="button" data-action="delete">Delete</button>
        </div>
      </li>`
        )
        .join('')
    : '<li class="hint">You have no topics yet.</li>';
}

function resetTopicForm() {
  editingId = null;
  $('topic-form').reset();
  $('topic-form-title').textContent = 'New topic';
  $('topic-save').textContent = 'Create topic';
  $('topic-cancel').hidden = true;
  $('topic-error').textContent = '';
}

async function refreshAll() {
  await loadStats();
  await loadPapers();
}

$('manage-topics').addEventListener('click', () => {
  resetTopicForm();
  $('send-result').textContent = '';
  $('topics-dialog').showModal();
});
$('dialog-close').addEventListener('click', () => $('topics-dialog').close());

$('topic-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const id = btn.closest('li').dataset.id;
  const topic = topicList.find((t) => t.id === id);
  if (btn.dataset.action === 'edit') {
    editingId = id;
    $('topic-name').value = topic.name;
    $('topic-keywords').value = topic.keywords.join(', ');
    $('topic-categories').value = topic.categories.join(', ');
    $('topic-form-title').textContent = `Edit “${topic.name}”`;
    $('topic-save').textContent = 'Save changes';
    $('topic-cancel').hidden = false;
    $('topic-name').focus();
  } else if (confirm(`Delete the topic “${topic.name}”?`)) {
    await api(`api/topics/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (editingId === id) resetTopicForm();
    await refreshAll();
  }
});

$('topic-cancel').addEventListener('click', resetTopicForm);

$('topic-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = JSON.stringify({
    name: $('topic-name').value,
    keywords: $('topic-keywords').value,
    categories: $('topic-categories').value,
  });
  try {
    if (editingId) await api(`api/topics/${encodeURIComponent(editingId)}`, { method: 'PUT', body });
    else await api('api/topics', { method: 'POST', body });
    resetTopicForm();
    await refreshAll();
  } catch (err) {
    $('topic-error').textContent = err.message;
  }
});

$('send-now').addEventListener('click', async () => {
  const btn = $('send-now');
  btn.disabled = true;
  $('send-result').textContent = 'Sending…';
  try {
    const { sent } = await api('api/digest/send', { method: 'POST' });
    $('send-result').textContent = sent ? `Sent with ${plural(sent, 'paper')}.` : 'There are no new papers to send.';
    await loadStats();
  } catch (err) {
    $('send-result').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// --- Admin session ---

// Visitors can read everything; managing topics, refreshing and sending email need the admin.
function renderSession() {
  const canEdit = session.admin;
  $('manage-topics').hidden = !canEdit;
  $('refresh').hidden = !canEdit;
  $('logout').hidden = !(session.authRequired && session.admin);
  $('admin-login').hidden = !(session.authRequired && !session.admin);
  $('tab-archive').hidden = !session.archive;
  if (!session.archive && filters.scope === 'archive') setScope('md');
}

// --- Private archive (admin only) ---

const shortMonthFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

// Snippets come with \u0002…\u0003 around the matched words.
const snippetHtml = (s) => escapeHtml(s).replace(/\u0002/g, '<mark>').replace(/\u0003/g, '</mark>');

function archiveRowHtml(p) {
  const pdfUrl = `api/archive/pdf/${encodeURIComponent(p.id)}`;
  const isArxiv = p.source === 'arXiv';
  const meta = [
    isArxiv ? `arXiv:${escapeHtml(p.id)}` : escapeHtml(p.venue ?? p.source),
    isArxiv ? escapeHtml(p.primaryCategory ?? '') : p.doi ? `DOI ${escapeHtml(p.doi)}` : '',
    escapeHtml(dateFmt.format(asUtcNoon(p.published))),
    p.pages ? `${p.pages} pages` : '',
    p.bytes ? `${(p.bytes / 1e6).toFixed(1)} MB` : '',
  ].filter(Boolean);
  return `<li class="result archive-row${p.figureUrl ? '' : ' no-figure'}">
    ${p.figureUrl ? `<figure class="result-figure"><a href="${escapeHtml(p.figureUrl)}" target="_blank" rel="noopener"><img src="${escapeHtml(p.figureUrl)}" alt="Figure from the paper" loading="lazy"></a></figure>` : ''}
    <div class="result-main">
      <h3 class="result-title"><a href="${pdfUrl}" target="_blank" rel="noopener">${escapeHtml(p.title)}</a></h3>
      <p class="result-authors">${escapeHtml(authorsLine(p.authors))}</p>
      <p class="archive-meta">${meta.join(' · ')}</p>
      ${p.snippet ? `<p class="snippet">${snippetHtml(p.snippet)}</p>` : ''}
      ${p.mdTerms.length ? `<p class="keywords"><strong>MD keywords:</strong> ${escapeHtml(p.mdTerms.join(', '))}</p>` : ''}
      <div class="result-actions">
        <a href="${pdfUrl}" target="_blank" rel="noopener">${ICONS.pdf}Open archived PDF</a>
        <a href="${escapeHtml(p.absUrl)}" target="_blank" rel="noopener">${ICONS.external}${isArxiv ? 'arXiv page' : 'Article page'}</a>
      </div>
    </div>
  </li>`;
}

async function loadArchive({ append = false } = {}) {
  archiveState.page = append ? archiveState.page + 1 : 1;
  const params = new URLSearchParams({ page: archiveState.page });
  if (archiveState.q) params.set('q', archiveState.q);
  const [data, stats] = await Promise.all([api(`api/archive/papers?${params}`), append ? null : api('api/archive/stats')]);
  archiveState.pages = data.pages;

  const list = $('archive-list');
  const html = data.results.map(archiveRowHtml).join('');
  if (append) {
    const start = list.children.length;
    list.insertAdjacentHTML('beforeend', html);
    for (const li of [...list.children].slice(start)) typeset(li);
  } else {
    list.innerHTML =
      html ||
      `<li class="empty">${archiveState.q ? 'No archived PDF contains all of those words.' : 'The archive is empty so far.'}</li>`;
    typeset(list);
  }

  $('archive-summary').textContent = archiveState.q
    ? `${plural(data.total, 'archived PDF')} matching “${archiveState.q}”`
    : `${plural(data.total, 'archived PDF')}`;
  if (stats) {
    $('count-archive').textContent = `(${stats.archived})`;
    const [first, last] = [stats.first, stats.last].map((d) => d && shortMonthFmt.format(asUtcNoon(d)));
    const range = first ? ` · submitted ${first === last ? first : `${first} – ${last}`}` : '';
    const size = stats.bytes >= 1e9 ? `${(stats.bytes / 1e9).toFixed(1)} GB` : `${Math.round(stats.bytes / 1e6)} MB`;
    const issues = [stats.pending ? `${stats.pending} downloading` : '', stats.failed ? `${stats.failed} not downloadable (publisher blocks it)` : '']
      .filter(Boolean)
      .join(', ');
    $('archive-meta').textContent = `${size}${range}${issues ? ` · ${issues}` : ''}`;
  }
  $('archive-more').hidden = archiveState.page >= archiveState.pages;
}

$('archive-more').addEventListener('click', () => loadArchive({ append: true }));

async function loadSession() {
  session = await api('api/session');
  renderSession();
}

$('admin-login').addEventListener('click', () => {
  $('login-form').reset();
  $('login-error').textContent = '';
  $('login-dialog').showModal();
});
$('login-close').addEventListener('click', () => $('login-dialog').close());

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('api/login', { method: 'POST', body: JSON.stringify({ password: $('login-password').value }) });
    $('login-dialog').close();
    await loadSession();
    await loadStats();
  } catch (err) {
    $('login-error').textContent = err.message;
  }
});

$('logout').addEventListener('click', async () => {
  await api('api/logout', { method: 'POST' });
  await loadSession();
});

// --- Refresh ---

// While the server is downloading, poll its status and reload when it finishes.
// On start-up, show the papers we already have right away.
async function waitForRefresh({ initial = false } = {}) {
  let stats = await loadStats();
  if (initial) await loadPapers();
  if (!stats.refreshing && initial) return;
  while (stats.refreshing) {
    await new Promise((r) => setTimeout(r, 4000));
    stats = await loadStats();
  }
  await loadPapers();
}

$('refresh').addEventListener('click', async () => {
  $('refresh').disabled = true;
  await api('api/refresh', { method: 'POST' });
  waitForRefresh();
});

loadSession()
  .then(() => waitForRefresh({ initial: true }))
  .catch((err) => {
    $('status').textContent = `Could not reach the server (${err.message}).`;
  });
