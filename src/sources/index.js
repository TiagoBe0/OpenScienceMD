// All extra literature sources, in the order they are queried.
import * as biorxiv from './biorxiv.js';
import * as crossref from './crossref.js';
import * as europepmc from './europepmc.js';
import * as semanticscholar from './semanticscholar.js';
import * as doaj from './doaj.js';
import * as openalex from './openalex.js';

export const SOURCES = [biorxiv, crossref, europepmc, semanticscholar, doaj, openalex];
