// Fetches new papers and exits. Handy for cron.
import './env.js';
import * as store from './store.js';

await store.load();
await store.refresh();
