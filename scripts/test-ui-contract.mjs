import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';

const [app, html] = await Promise.all([
  readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
]);

// Parse the complete browser bundle so a missing bracket cannot ship behind
// the lightweight DOM-id contract checks below.
new Script(app, { filename: 'public/app.js' });
const referencedIds = new Set(
  [...app.matchAll(/byId\(['"]([^'"]+)['"]\)/g)].map((match) => match[1]),
);
const htmlIdList = [...html.matchAll(/\bid=['"]([^'"]+)['"]/g)].map((match) => match[1]);
const htmlIds = new Set(htmlIdList);
const missingIds = [...referencedIds].filter((id) => !htmlIds.has(id));
const duplicateIds = [...htmlIds].filter(
  (id) => htmlIdList.indexOf(id) !== htmlIdList.lastIndexOf(id),
);

if (missingIds.length || duplicateIds.length) {
  throw new Error([
    missingIds.length ? `Missing HTML ids: ${missingIds.join(', ')}` : '',
    duplicateIds.length ? `Duplicate HTML ids: ${duplicateIds.join(', ')}` : '',
  ].filter(Boolean).join('\n'));
}

// Regression guards
if (app.includes('state.authenticated')) {
  throw new Error('public/app.js must not use the nonexistent state.authenticated property');
}

if (/\bintegerInput\s*\(/.test(app)) {
  throw new Error('Removed integerInput helper must not be referenced');
}

if (!/function\s+previousDate\s*\(/.test(app)) {
  throw new Error('previousDate helper must be defined');
}

console.log(`UI contract OK (${referencedIds.size} referenced ids, ${htmlIds.size} HTML ids, regression guards passed)`);
