// Molecular Dynamics detector. Papers are scored by the MD-related terms they mention;
// a match in the title counts double. Papers scoring at least MIN_SCORE are shown first.

const MIN_SCORE = 2;

// Each entry: [label shown to the user, regex, weight].
const STRONG = 2;
const WEAK = 1;
const word = (s, flags = 'iu') => new RegExp(`(?<![\\p{L}\\p{N}])(?:${s})(?![\\p{L}\\p{N}])`, flags);

const TERMS = [
  ['molecular dynamics', word('(?:ab[ -]initio |first[ -]principles |classical |non-?equilibrium |reactive |coarse[ -]grained |path[ -]integral |steered )?molecular[ -]dynamics'), STRONG],
  ['MD simulation', word('(?:MD|AIMD|NEMD|CGMD|PIMD|RPMD|FPMD|DFT-MD)(?: simulations?)?', 'u'), STRONG],
  ['LAMMPS', word('LAMMPS'), STRONG],
  ['GROMACS', word('GROMACS'), STRONG],
  ['NAMD', word('NAMD', 'u'), STRONG],
  ['OpenMM', word('OpenMM'), STRONG],
  ['DeePMD', word('DeePMD(?:-kit)?|DeepMD'), STRONG],
  ['Martini', word('Martini(?: 3| force field| model)', 'u'), STRONG],
  ['Car-Parrinello', word('Car[ -]Parrinello'), STRONG],
  ['interatomic potential', word('(?:machine[ -]learn(?:ed|ing) |neural[ -]network |empirical |classical )?interatomic potentials?'), STRONG],
  ['machine-learned potential', word('machine[ -]learn(?:ed|ing) (?:force fields?|potentials?)'), STRONG],
  ['machine-learned potential', word('MLIPs?|MLFFs?', 'u'), STRONG],
  ['force field', word('force[ -]fields?'), WEAK],
  ['atomistic simulation', word('atomistic (?:simulations?|modell?ing)|all[ -]atom simulations?'), WEAK],
  ['coarse-grained', word('coarse[ -]grain(?:ed|ing)'), WEAK],
  ['Lennard-Jones', word('Lennard[ -]Jones'), WEAK],
  ['Langevin dynamics', word('Langevin dynamics'), WEAK],
  ['Green-Kubo', word('Green[ -]Kubo'), WEAK],
  ['thermostat', word('Nos[ée][ -]Hoover|Berendsen|thermostats?'), WEAK],
  ['empirical potential', word('embedded[ -]atom(?: method)?|Tersoff|Stillinger[ -]Weber'), WEAK],
  ['empirical potential', word('EAM|MEAM|ReaxFF|SNAP|ACE potentials?', 'u'), WEAK],
  ['biomolecular force field', word('CHARMM|AMBER|OPLS(?:-AA)?|TIP[345]P|SPC/E', 'u'), WEAK],
  ['enhanced sampling', word('metadynamics|umbrella sampling|replica[ -]exchange'), WEAK],
  ['radial distribution function', word('radial distribution functions?|mean[ -]squared? displacements?'), WEAK],
];

/** Returns { score, terms } where terms are the labels of the MD concepts found. */
export function scoreMd(paper) {
  let score = 0;
  const terms = [];
  for (const [label, re, weight] of TERMS) {
    const inTitle = re.test(paper.title);
    if (inTitle || re.test(paper.abstract)) {
      score += inTitle ? weight * 2 : weight;
      if (!terms.includes(label)) terms.push(label);
    }
  }
  return { score, terms, isMd: score >= MIN_SCORE };
}

/** The exact words that matched, so the client can highlight them. */
export function mdMatches(paper) {
  const found = new Set();
  for (const [, re] of TERMS) {
    const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    for (const text of [paper.title, paper.abstract]) {
      for (const m of text.matchAll(global)) found.add(m[0]);
    }
  }
  return [...found];
}

// Papers from the extra sources (journals, bioRxiv…) must pass a stricter test: MD has to be
// central (STRICT_SCORE), and biomedical "docking + short MD" studies are left out, since
// there MD is only a final validation step.
const STRICT_SCORE = 4;
const DOCKING = /(?<![\p{L}\p{N}])(?:docking|network pharmacology|systems pharmacology|network toxicology|ADMET|virtual screening|pharmacophore|inhibitors?|drug[- ]likeness|binding affinit(?:y|ies)|in[ -]silico)(?![\p{L}\p{N}])/iu;

export const isDockingStyle = (paper) => DOCKING.test(`${paper.title} ${paper.abstract}`);

export function isStrictMd(paper) {
  return scoreMd(paper).score >= STRICT_SCORE && !isDockingStyle(paper);
}
