// Usage: node scripts/mark-tasks.mjs T001 T002 T010-T015 ...  (marks tasks done in tasks.md)
import { readFileSync, writeFileSync } from 'node:fs';
const file = process.env.TASKS ?? 'specs/001-sync-core/tasks.md';
let text = readFileSync(file, 'utf8');
const ids = new Set();
for (const arg of process.argv.slice(2)) {
  const m = /^T(\d+)([a-z]?)-T(\d+)([a-z]?)$/.exec(arg);
  if (m) for (let n = +m[1]; n <= +m[3]; n++) ids.add('T' + String(n).padStart(3, '0'));
  else ids.add(arg);
}
let count = 0;
text = text.replace(/^- \[ \] (T\d{3}[a-z]?)\b/gm, (full, id) => (ids.has(id) ? (count++, `- [X] ${id}`) : full));
writeFileSync(file, text);
console.log('marked', count);
