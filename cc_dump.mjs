import fs from 'node:fs';
import { loadCatalog, crossCallIds } from './lib/crosscall.mjs';
const cat = loadCatalog(new URL('./standard/cross-call-catalog.json', import.meta.url));
const d = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const out = {};
for (const r of d.l2) { const b = r.branch; out[b] ??= {}; for (const id of crossCallIds({ ...r, layer: 'L2' }, cat)) { (out[b][id] ??= new Set()).add(r.api); } }
const steps = {}; for (const r of d.l2) { (steps[r.branch] ??= new Set()).add(r.api); }
fs.writeFileSync(process.argv[3], JSON.stringify({ catalog: cat.checks.map(c => ({ id: c.id, group: c.group, desc: c.desc })), cover: Object.fromEntries(Object.entries(out).map(([b, m]) => [b, Object.fromEntries(Object.entries(m).map(([k, v]) => [k, [...v]]))])), l2apis: Object.fromEntries(Object.entries(steps).map(([b, s]) => [b, [...s]])) }, null, 1));
