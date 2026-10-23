// Every file served from public/ must be precached by the service worker, or offline play breaks.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
const root = new URL('../public/', import.meta.url).pathname;
const sw = readFileSync(join(root, 'sw.js'), 'utf8');
const listed = new Set([...sw.slice(sw.indexOf('const FILES'), sw.indexOf('];')).matchAll(/'([^']+)'/g)].map(m => m[1]));
const walk = d => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [relative(root, p)]; });
const skip = new Set(['sw.js', '.nojekyll', 'vendor/README.txt']);
const missing = walk(root).filter(f => !skip.has(f) && !f.endsWith('.DS_Store') && !listed.has(f));
const extra = [...listed].filter(f => f !== './' && !walk(root).includes(f));
if(missing.length || extra.length){ console.error('sw.js FILES out of date. Missing:', missing, 'Not found:', extra); process.exit(1); }
console.log(`sw.js precaches all ${listed.size - 1} files`);
