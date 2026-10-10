// Lists every English string that goes through t('…') so translators know what to translate.
//   node scripts/extract-i18n.mjs               -> prints all keys
//   node scripts/extract-i18n.mjs --missing hi  -> prints keys that public/js/lang/hi.js does not have yet
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const JS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/js');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory()
  ? (e.name === 'vendor' || e.name === 'lang' ? [] : walk(path.join(d, e.name)))
  : e.name.endsWith('.js') ? [path.join(d, e.name)] : []));

// owner-side screens (builder, settings, import) - translated after the everyday screens
const OWNER_SIDE = new Set(['build.js', 'workflows.js', 'dashbuild.js', 'conditions.js', 'settings.js', 'importer.js', 'passport.js']);

export function extractKeys({ everydayOnly = false } = {}) {
  const keys = new Set();
  const re = /\bt\(\s*'((?:[^'\\]|\\.)*)'/g;
  for (const f of walk(JS)) {
    if (everydayOnly && OWNER_SIDE.has(path.basename(f))) continue;
    const src = fs.readFileSync(f, 'utf8');
    let m;
    while ((m = re.exec(src))) keys.add(m[1].replace(/\\'/g, "'").replace(/\\n/g, '\n'));
  }
  // labels that are looked up dynamically (so the regex above cannot see them)
  [
    'Text', 'Long text', 'Number', 'Money', 'Date', 'Choice list', 'Yes / No', 'Phone', 'Email', 'Link to another table', 'Line items',
    'is', 'is not', 'is more than', 'is at least', 'is less than', 'is at most', 'contains', 'is empty', 'is not empty', 'is in the past',
    'is today', 'is within the next … days', 'is more than … days ago',
    'Shop: billing + stock', 'Service jobs', 'Start empty',
    'Invoices with UPI QR, stock that updates itself, customers, low-stock and payment reminders.',
    'Repair shop, salon or workshop: track jobs, notify customers when ready, owner approvals.',
    'Build your own tables, forms and workflows from scratch.',
  ].forEach((k) => keys.add(k));
  return [...keys].sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let list = extractKeys({ everydayOnly: process.argv.includes('--everyday') });
  const i = process.argv.indexOf('--missing');
  if (i > 0) {
    const have = (await import(`../public/js/lang/${process.argv[i + 1]}.js`)).default;
    list = list.filter((k) => !(k in have));
  }
  console.log(list.map((k) => JSON.stringify(k)).join('\n'));
  console.error(`${list.length} strings`);
}
