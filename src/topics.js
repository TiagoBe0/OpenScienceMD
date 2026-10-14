import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const DATA_DIR = path.resolve(import.meta.dirname, '..', 'data');
const TOPICS_FILE = path.join(DATA_DIR, 'topics.json');
const CATEGORY_RE = /^[a-z]+(-[a-z]+)?(\.[A-Za-z-]+)?$/;

let topics = [];
let compiled = [];

// Errors shown to the user as-is (HTTP 400).
const userError = (message) => Object.assign(new Error(message), { status: 400 });

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A keyword matches at the start of a word, so "superconduct"
// finds "superconductivity" and "superconducting".
function compile(topic) {
  const keywordRes = topic.keywords.map((k) => ({ term: k, re: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(k)}`, 'iu') }));
  return {
    topic,
    match(paper) {
      if (topic.categories.length) {
        const inCategory = paper.categories.some((c) =>
          topic.categories.some((t) => c === t || c.startsWith(`${t}.`))
        );
        if (!inCategory) return null;
      }
      if (!keywordRes.length) return [];
      const text = `${paper.title} ${paper.abstract}`;
      const terms = keywordRes.filter((k) => k.re.test(text)).map((k) => k.term);
      return terms.length ? terms : null;
    },
  };
}

function normalizeList(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',');
  return [...new Set(list.map((s) => String(s).replace(/\s+/g, ' ').trim()).filter(Boolean))];
}

/** Validates and normalizes the form input. */
function validate(input) {
  const name = String(input?.name ?? '').trim();
  const keywords = normalizeList(input?.keywords);
  const categories = normalizeList(input?.categories);
  if (!name) throw userError('The topic needs a name.');
  if (name.length > 80) throw userError('The name is too long.');
  if (!keywords.length && !categories.length) throw userError('Add at least one keyword or category.');
  if (keywords.length > 50 || categories.length > 30) throw userError('Too many keywords or categories.');
  if (keywords.some((k) => k.length > 100)) throw userError('A keyword is too long.');
  const bad = categories.find((c) => !CATEGORY_RE.test(c));
  if (bad) throw userError(`"${bad}" does not look like an arXiv category (e.g. cond-mat.supr-con).`);
  return { name, keywords, categories };
}

async function save() {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${TOPICS_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(topics, null, 2));
  await rename(tmp, TOPICS_FILE);
}

function setTopics(list) {
  topics = list;
  compiled = topics.map(compile);
}

export async function load() {
  try {
    setTopics(JSON.parse(await readFile(TOPICS_FILE, 'utf8')));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('Could not read data/topics.json:', err.message);
  }
}

export function list() {
  return topics;
}

export async function create(input) {
  const topic = { id: randomUUID(), ...validate(input) };
  setTopics([...topics, topic]);
  await save();
  return topic;
}

export async function update(id, input) {
  if (!topics.some((t) => t.id === id)) return null;
  const topic = { id, ...validate(input) };
  setTopics(topics.map((t) => (t.id === id ? topic : t)));
  await save();
  return topic;
}

export async function remove(id) {
  if (!topics.some((t) => t.id === id)) return false;
  setTopics(topics.filter((t) => t.id !== id));
  await save();
  return true;
}

/** Returns the topics a paper matches: [{ id, name, terms }]. */
export function matchPaper(paper) {
  const result = [];
  for (const c of compiled) {
    const terms = c.match(paper);
    if (terms) result.push({ id: c.topic.id, name: c.topic.name, terms });
  }
  return result;
}
