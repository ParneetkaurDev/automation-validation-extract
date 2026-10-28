// Maps extracted L2 rows onto the common cross-call catalog (standard/cross-call-catalog.json).
import fs from 'node:fs';

export function loadCatalog(file = new URL('../standard/cross-call-catalog.json', import.meta.url)) {
  const cat = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const c of cat.checks)
    c.match = c.match.map((m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, k === 'check' ? v : toRe(v)])));
  return cat;
}
function toRe(s) {                       // supports a leading (?i) flag
  const ci = s.startsWith('(?i)');
  return new RegExp(ci ? s.slice(4) : s, ci ? 'i' : '');
}
const norm = (s) => String(s || '').replace(/\[\d+\]/g, '[]').replace(/\[\]\[\]/g, '[]');

// → array of catalog ids this L2 row implements
export function crossCallIds(row, cat) {
  if (!row || row.layer === 'L1') return [];
  const f = norm(row.field), o = norm(row.comparedWith), api = row.api || '', cond = `${row.condition || ''} ${row.validation || ''}`;
  const ids = [];
  for (const c of cat.checks) {
    const hit = c.match.some((m) =>
      (!m.check || m.check.includes(row.checkType)) &&
      (!m.field || m.field.test(f)) && (!m.other || m.other.test(o)) && (!m.notOther || !m.notOther.test(o)) &&
      (!m.api || m.api.test(api)) && (!m.notApi || !m.notApi.test(api)) &&
      (!m.cond || m.cond.test(cond)) && (!m.notCond || !m.notCond.test(cond)));
    if (hit) ids.push(c.id);
  }
  return ids;
}

// Coverage of the catalog for one branch's L2 rows.
// the plain-language text of the cross-call checks a row implements (instead of codes like PR2 / OR1)
export function crossCallText(row, cat) {
  const desc = new Map(cat.checks.map((c) => [c.id, c.desc]));
  return crossCallIds(row, cat).map((id) => desc.get(id) || id).join('\n');
}
// old reports stored codes ("PR2, OR1") - turn them into text
export function crossCallCodesToText(codes, cat) {
  const desc = new Map(cat.checks.map((c) => [c.id, c.desc]));
  return String(codes || '').split(/,\s*/).filter(Boolean).map((id) => desc.get(id.trim()) || id.trim()).join('\n');
}
export function coverage(l2rows, cat) {
  const by = new Map(cat.checks.map((c) => [c.id, { ...c, apis: new Set(), count: 0, example: '' }]));
  for (const r of l2rows)
    for (const id of crossCallIds(r, cat)) {
      const e = by.get(id); e.count++; e.apis.add(r.api);
      if (!e.example) e.example = `${r.api}: ${r.validation}`;
    }
  return [...by.values()].map((e) => ({ ID: e.id, Group: e.group, Check: e.desc, Covered: e.count ? 'Yes' : 'No',
    'Checked in APIs': [...e.apis].sort().join(', '), Occurrences: e.count, Example: e.example }));
}
