// arXiv physics archives. `query` is the fragment used in the search API;
// `prefixes` decides which area each of a paper's categories belongs to.
export const AREAS = [
  { id: 'astro-ph', label: 'Astrophysics', query: 'cat:astro-ph*', prefixes: ['astro-ph'] },
  { id: 'cond-mat', label: 'Condensed Matter', query: 'cat:cond-mat*', prefixes: ['cond-mat'] },
  { id: 'gr-qc', label: 'General Relativity and Quantum Cosmology', query: 'cat:gr-qc', prefixes: ['gr-qc'] },
  { id: 'hep', label: 'High Energy Physics', query: 'cat:hep-ex OR cat:hep-lat OR cat:hep-ph OR cat:hep-th', prefixes: ['hep-'] },
  { id: 'math-ph', label: 'Mathematical Physics', query: 'cat:math-ph', prefixes: ['math-ph'] },
  { id: 'nlin', label: 'Nonlinear Sciences', query: 'cat:nlin*', prefixes: ['nlin'] },
  { id: 'nucl', label: 'Nuclear Physics', query: 'cat:nucl-ex OR cat:nucl-th', prefixes: ['nucl-'] },
  { id: 'physics', label: 'Physics (general and applied)', query: 'cat:physics*', prefixes: ['physics'] },
  { id: 'quant-ph', label: 'Quantum Physics', query: 'cat:quant-ph', prefixes: ['quant-ph'] },
];

export const PHYSICS_QUERY = AREAS.map((a) => a.query).join(' OR ');

export function areasOf(categories) {
  return AREAS.filter((a) =>
    categories.some((c) => a.prefixes.some((p) => c === p || c.startsWith(p.endsWith('-') ? p : `${p}.`)))
  ).map((a) => a.id);
}
