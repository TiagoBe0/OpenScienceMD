// Fetches new papers and sends the email digest right away. Handy for testing or cron.
import './env.js';
import * as store from './store.js';
import * as topics from './topics.js';
import * as digest from './digest.js';

await Promise.all([store.load(), topics.load(), digest.load()]);
await store.refresh();
await digest.send();
