// Rewrites the PRECACHE list and VERSION in public/sw.js from the files that actually exist.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const SKIP = new Set(['sw.js']);

export function listFiles(dir = PUBLIC, base = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = base ? `${base}/${e.name}` : e.name;
    return e.isDirectory() ? listFiles(path.join(dir, e.name), rel) : SKIP.has(rel) ? [] : [rel];
  }).sort();
}

export function build() {
  const files = listFiles();
  const hash = crypto.createHash('sha1');
  for (const f of files) hash.update(f).update(fs.readFileSync(path.join(PUBLIC, f)));
  const version = hash.digest('hex').slice(0, 10);
  const list = ['./', ...files.map((f) => `./${f}`)];
  const swPath = path.join(PUBLIC, 'sw.js');
  let sw = fs.readFileSync(swPath, 'utf8');
  sw = sw.replace(/const VERSION = '[^']*';/, `const VERSION = '${version}';`)
    .replace(/const PRECACHE = \[[\s\S]*?\];/, `const PRECACHE = ${JSON.stringify(list, null, 2)};`);
  fs.writeFileSync(swPath, sw);
  return { version, count: list.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = build();
  console.log(`sw.js updated: ${r.count} files, version ${r.version}`);
}
