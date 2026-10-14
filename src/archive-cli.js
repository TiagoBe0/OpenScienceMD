// Command line access to the PDF archive.
//   npm run archive -- stats
//   npm run archive -- search "lennard jones thermal conductivity"
//   npm run archive -- run       (archive pending MD papers now)
//   npm run archive -- verify    (check that every PDF is on disk)
import './env.js';
import * as archive from './archive.js';

const [command = 'stats', ...rest] = process.argv.slice(2);
const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

switch (command) {
  case 'stats': {
    const s = archive.stats();
    console.log(`Archive: ${s.folder}`);
    console.log(`  ${s.archived} PDFs (${mb(s.bytes)}), ${s.pending} pending, ${s.failed} failed`);
    if (s.first) console.log(`  submitted between ${s.first.slice(0, 10)} and ${s.last.slice(0, 10)}`);
    break;
  }
  case 'search': {
    const { total, results } = archive.search(rest.join(' '), 20);
    console.log(`${total} match${total === 1 ? '' : 'es'}`);
    for (const r of results) {
      const snippet = r.snippet.replaceAll(archive.MARK_START, '[').replaceAll(archive.MARK_END, ']');
      console.log(`\n${r.id}  ${r.published?.slice(0, 10)}  ${r.title}`);
      console.log(`  ${snippet.replace(/\s+/g, ' ')}`);
      console.log(`  ${r.pdfFile}`);
    }
    break;
  }
  case 'run': {
    if (!archive.enabled) {
      console.log('Set ARCHIVE_PDFS=true in .env to enable the archive.');
      break;
    }
    const store = await import('./store.js');
    const figures = await import('./figures.js');
    const { scoreMd } = await import('./focus.js');
    await Promise.all([store.load(), figures.load()]);
    const md = store
      .allPapers()
      .map((p) => ({ ...p, md: scoreMd(p), figure: figures.cachedFigure(p.id) }))
      .filter((p) => p.md.isMd);
    await archive.archivePapers(md);
    console.log(archive.stats());
    break;
  }
  case 'verify': {
    const { checked, problems } = await archive.verify();
    console.log(`Checked ${checked} PDFs: ${problems.length ? problems.join('\n  ') : 'all present'}`);
    break;
  }
  default:
    console.log('Usage: npm run archive -- stats | search <words> | run | verify');
}
