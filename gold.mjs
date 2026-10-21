#!/usr/bin/env node
/**
 * gold.mjs - simple validation list, gold baselines and the CI comparison.
 * Input: validations.json written by extract-validations.mjs.
 *
 *   simplify   --in validations.json --out simple
 *              one simple list per branch (xlsx + csv)
 *   build-gold --in validations.json --branches a,b,c --name FIS12@2.3.0 [--min-share 0.75] [--gold-dir gold]
 *              core = in at least min-share of the branches (default 1 = all); registers it in gold/index.yaml
 *   build-all  --in validations.json --families gold/families.yaml [--gold-dir gold]
 *              builds every family baseline listed in families.yaml
 *   compare    --in validations.json --gold <file.csv|auto> [--branch X] [--waivers waivers.csv] [--gold-dir gold] --out compare
 *              --gold auto picks the baseline registered for the branch's domain + version
 *              exit 1 when any MISSING or BLOCKER is found (the CI gate)
 *   partition  --in validations.json --branches a,b,c --name N --out dir
 *              1_common (in all) / 2_intersection (in >1, not all) / 3_specific (one use case only), each .json .csv .xlsx
 *   crosscall  --in validations.json --out crosscall
 *              coverage of the common cross-call catalog per branch
 */
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import YAML from 'yaml';
import { loadCatalog, crossCallIds, coverage } from './lib/crosscall.mjs';
import { developerMessages } from './lib/messages.mjs';

const COLS = ['Key', 'Layer', 'API', 'Field', 'Check', 'Values', 'Runs', 'Depends on', 'Cross-call ID', 'Validation', 'Source', 'Code'];
const RUN_RANK = { 'Always': 0, 'If present': 1, 'Conditional': 2 };
const VALUE_LIST = /Allowed values|Expected value/;

// ---------- args ----------
const [cmd, ...rest] = process.argv.slice(2);
const args = {};
for (let i = 0; i < rest.length; i++) {
  const k = rest[i].replace(/^--/, '');
  if (rest[i + 1] === undefined || rest[i + 1].startsWith('--')) args[k] = true; else args[k] = rest[++i];
}
const need = (k) => { if (!args[k] || args[k] === true) { console.error(`missing --${k}`); process.exit(2); } return args[k]; };
const goldDir = args['gold-dir'] || 'gold';
const catalog = loadCatalog();

// ---------- simple rows ----------
function runsL1(r) {
  if (r.runClass === 'Always runs') return { runs: 'Always', cond: '' };
  if (r.runClass.startsWith('Optional')) return { runs: 'If present', cond: '' };
  return { runs: 'Conditional', cond: r.when.replace(/^Skipped when /, 'skipped when ') };
}
const runsL2 = (r) => (r.onlyWhen ? { runs: 'Conditional', cond: r.onlyWhen } : { runs: 'Always', cond: '' });
const normValues = (v, check = '') => {
  const s = String(v || '').trim();
  if (!s) return '';
  if (VALUE_LIST.test(check)) return s.split(',').map((x) => x.trim()).filter(Boolean).sort().join(', ');
  return s.split('\n')[0].trim();
};
// Where a validation lives in the spec branch + the code that implements it (shown to developers).
function sourceOf(layer, r) {
  if (layer === 'L1') {
    const file = 'config/validations/index.yaml';
    return { Source: `${file}:${r.line}`, _file: file, _line: r.line,
      Code: `_NAME_: ${r.ruleName}${r.jsonPath ? `  attr: ${r.jsonPath}` : ''}  _RETURN_: ${String(r.expression).trim()}${r.conditionExpr ? `  _CONTINUE_: ${r.conditionExpr}` : ''}` };
  }
  const fn = r.function === 'Prerequisite (session)' ? 'requirements' : 'validate';
  const file = `config/flows/${r.flow}`;
  const code = r.codeStyle === 'standard' ? r.condition
    : r.condition ? `if (${r.condition}) return { valid: false, description: ${JSON.stringify(r.errorMessage || '')} }` : r.validation;
  return { Source: `${file} step ${r.step} (${r.actionId}) mock.${fn}`, _file: file, _line: null,
    Code: (r.onlyWhen ? `[${r.onlyWhen}] ` : '') + code };
}
export const normField = (f) => String(f || '').toLowerCase().replace(/\[\d*\]/g, '').replace(/^session data:\s*/, 'session:').trim();

function simplify(rows) {
  const out = new Map();
  const add = (layer, r, check, values, runInfo) => {
    const key = [layer, r.api, r.field, check].join(' | ');
    const row = {
      Key: key, Layer: layer, API: r.api, Field: r.field, Check: check, Values: values,
      Runs: runInfo.runs + (runInfo.cond ? ` (${runInfo.cond})` : ''), _runs: runInfo.runs,
      'Depends on': runInfo.runs === 'Conditional' ? (r.condFields || '') : '',
      'Cross-call ID': layer === 'L2' ? crossCallIds({ ...r, layer }, catalog).join(', ') : '',
      Validation: r.validation, Branch: r.branch, Domain: r.domain, Version: r.version,
      ...sourceOf(layer, r),
    };
    const prev = out.get(key);
    if (!prev || RUN_RANK[row._runs] < RUN_RANK[prev._runs]) out.set(key, row);   // keep the strongest copy
  };
  for (const r of rows.l1) add('L1', r, r.ruleType, normValues(r.values, r.ruleType), runsL1(r));
  for (const r of rows.l2) add('L2', r, r.checkType, normValues(r.values || r.comparedWith, r.checkType), runsL2(r));
  return [...out.values()].sort((a, b) => a.Key.localeCompare(b.Key));
}
function byBranch(json) {
  const m = new Map();
  for (const layer of ['l1', 'l2'])
    for (const r of json[layer]) {
      if (!m.has(r.branch)) m.set(r.branch, { l1: [], l2: [], domain: r.domain, version: r.version });
      m.get(r.branch)[layer].push(r);
    }
  return m;
}

// ---------- files ----------
const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function writeCsv(file, cols, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n');
}
function readCsv(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some((c) => c !== ''));
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}
async function readTable(file) {
  if (file.endsWith('.json')) {   // common / intersection JSON: { L1: [...], L2: [...] }
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (Array.isArray(j) ? j : [...(j.L1 || []), ...(j.L2 || [])]).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v ?? '')])));
  }
  if (!file.endsWith('.xlsx')) return readCsv(file);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(file);
  const ws = wb.worksheets[0]; const head = ws.getRow(1).values.slice(1).map(String);
  const rows = [];
  ws.eachRow((r, n) => { if (n > 1) rows.push(Object.fromEntries(head.map((h, i) => [h, String(r.getCell(i + 1).text ?? '').trim()]))); });
  return rows;
}
const FILL = { OK: 'FFE2F0D9', Yes: 'FFE2F0D9', MISSING: 'FFF8CBAD', BLOCKER: 'FFF8CBAD', No: 'FFFCE4D6', CONDITIONAL: 'FFFFE699',
  'DIFFERENT VALUES': 'FFFFE699', WAIVED: 'FFD9D9D9', EXTRA: 'FFDDEBF7', FAIL: 'FFF8CBAD', WARN: 'FFFFE699', INFO: 'FFDDEBF7' };
async function writeXlsx(file, sheets) {
  const wb = new ExcelJS.Workbook();
  for (const { name, cols, rows, widths = {}, color = [] } of sheets) {
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = cols.map((c) => ({ header: c, key: c, width: widths[c] || Math.min(60, Math.max(10, c.length + 2)) }));
    rows.forEach((r) => ws.addRow(r));
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
    if (rows.length) ws.autoFilter = { from: 'A1', to: { row: 1, column: cols.length } };
    ws.eachRow((row, n) => {
      row.eachCell((c) => { c.alignment = { vertical: 'top', wrapText: true }; });
      if (n === 1) return;
      for (const col of ['Status', 'Result', 'Covered', ...color]) {
        if (!cols.includes(col)) continue;
        const cell = row.getCell(col); const f = FILL[cell.value];
        if (f) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: f } };
      }
    });
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await wb.xlsx.writeFile(file);
}
const W = { 'Gold example': 60, 'Branch source': 45, 'Branch code': 60, Key: 45, Field: 40, Values: 30, Runs: 35, 'Depends on': 30, Validation: 60, Status: 18, 'What to do': 55,
  'Gold runs': 30, 'Branch runs': 30, 'Gold values': 25, 'Branch values': 25, Check: 22, Example: 60, 'Checked in APIs': 30 };
const safe = (s) => String(s).replace(/[^A-Za-z0-9.@_-]+/g, '_');

// ---------- gold index (versioned baselines) ----------
const indexFile = () => path.join(goldDir, 'index.yaml');
function readIndex() { return fs.existsSync(indexFile()) ? (YAML.parse(fs.readFileSync(indexFile(), 'utf8')) || {}) : {}; }
function register(entry) {
  const idx = readIndex(); idx.baselines = (idx.baselines || []).filter((b) => b.name !== entry.name);
  idx.baselines.push(entry); idx.baselines.sort((a, b) => a.name.localeCompare(b.name));
  fs.mkdirSync(goldDir, { recursive: true });
  fs.writeFileSync(indexFile(), '# Versioned gold baselines. compare --gold auto picks the entry whose domains + versions match the branch.\n' + YAML.stringify(idx));
}
function pickGold(domain, version) {
  const hits = (readIndex().baselines || []).filter((b) => (b.domains || []).includes(domain) && (b.versions || []).map(String).includes(String(version)));
  return hits.sort((a, b) => (a.scope === 'hub') - (b.scope === 'hub'))[0] || null;   // family baseline before hub baseline
}

function buildGold(branches, pick, minShare) {
  const lists = pick.map((b) => {
    if (!branches.has(b)) throw new Error(`branch not in input: ${b}`);
    return new Map(simplify(branches.get(b)).map((r) => [r.Key, r]));
  });
  const need = Math.max(1, Math.ceil(minShare * lists.length - 1e-9));
  const keys = [...new Set(lists.flatMap((l) => [...l.keys()]))].sort();
  const gold = [];
  for (const key of keys) {
    const all = lists.map((l) => l.get(key)).filter(Boolean);
    if (all.length < need) continue;
    // how the family runs it: the majority setting (ties → the stronger one), so one branch's hidden skip
    // does not become part of the gold standard
    const votes = new Map();
    for (const r of all) { const k = `${r._runs}|${r['Depends on']}`; votes.set(k, [...(votes.get(k) || []), r]); }
    const runsRow = [...votes.values()].sort((a, b) => b.length - a.length || RUN_RANK[a[0]._runs] - RUN_RANK[b[0]._runs])[0][0];
    let values;
    if (VALUE_LIST.test(all[0].Check)) {           // values accepted by the same share of branches
      const needV = Math.max(1, Math.ceil(minShare * all.length - 1e-9));
      const cnt = new Map();
      for (const r of all) for (const v of new Set(r.Values ? r.Values.split(', ') : [])) cnt.set(v, (cnt.get(v) || 0) + 1);
      values = [...cnt].filter(([, n]) => n >= needV).map(([v]) => v).sort().join(', ');
    } else {
      const cnt = new Map(); for (const r of all) cnt.set(r.Values, (cnt.get(r.Values) || 0) + 1);
      const [top, n] = [...cnt].sort((a, b) => b[1] - a[1])[0];
      values = n >= Math.ceil(minShare * all.length - 1e-9) ? top : '';
    }
    const ex = runsRow;   // the example shown to developers follows the gold behaviour
    gold.push({ ...all[0], Values: values, Runs: runsRow.Runs, 'Depends on': runsRow['Depends on'], 'In branches': `${all.length}/${lists.length}`,
      Source: `${ex.Branch}: ${ex.Source}`, Code: ex.Code });
  }
  return gold;
}
// Business-readable Excel copy of a gold baseline (same rows as the CSV).
const API_ORDER = ['search', 'on_search', 'select', 'on_select', 'init', 'on_init', 'confirm', 'on_confirm', 'status', 'on_status',
  'update', 'on_update', 'cancel', 'on_cancel', 'track', 'on_track', 'support', 'on_support', 'rating', 'on_rating', 'dynamic_form',
  'issue', 'on_issue', 'issue_status', 'on_issue_status'];
const apiRank = (a) => { const i = API_ORDER.indexOf(a); return i < 0 ? 99 : i; };
async function writeGoldXlsx(file, name, gold, meta) {
  const rows = [...gold].sort((a, b) => apiRank(a.API) - apiRank(b.API) || a.Layer.localeCompare(b.Layer) || a.Field.localeCompare(b.Field) || a.Check.localeCompare(b.Check))
    .map((g) => ({ ...g, Runs: g.Runs, Example: [g.Source, g.Code].filter(Boolean).join('\n') }));
  const byLayer = (l) => gold.filter((g) => g.Layer === l).length;
  const runsOf = (r) => String(r.Runs || '').split(' (')[0];
  const apis = [...new Set(gold.map((g) => g.API))].sort((a, b) => apiRank(a) - apiRank(b));
  const summary = [
    { Item: 'Gold baseline', Value: name },
    { Item: 'What it is', Value: `Validations present in at least ${Math.round((meta.min_share ?? 1) * 100)}% of the branches below (min-share ${meta.min_share ?? 1})` },
    { Item: 'Built from', Value: (meta.built_from || []).join(', ') },
    { Item: 'Domains / versions', Value: `${(meta.domains || []).join(', ')}  |  ${(meta.versions || []).join(', ')}` },
    { Item: 'Created', Value: new Date().toISOString().slice(0, 10) },
    { Item: 'Total validations', Value: gold.length },
    { Item: 'L1 field rules', Value: byLayer('L1') },
    { Item: 'L2 flow-code checks', Value: byLayer('L2') },
    { Item: 'Runs: Always / If present / Conditional', Value: ['Always', 'If present', 'Conditional'].map((k) => gold.filter((g) => runsOf(g) === k).length).join(' / ') },
  ];
  const perApi = apis.map((a) => ({ API: a, 'L1 field rules': gold.filter((g) => g.API === a && g.Layer === 'L1').length,
    'L2 flow-code checks': gold.filter((g) => g.API === a && g.Layer === 'L2').length, Total: gold.filter((g) => g.API === a).length }));
  await writeXlsx(file, [
    { name: 'Summary', cols: ['Item', 'Value'], rows: summary, widths: { Item: 34, Value: 90 } },
    { name: 'By API', cols: ['API', 'L1 field rules', 'L2 flow-code checks', 'Total'], rows: perApi, widths: { API: 20 } },
    { name: 'Gold validations', cols: ['Layer', 'API', 'Field', 'Check', 'Validation', 'Values', 'Runs', 'Depends on', 'In branches', 'Key', 'Example'], rows,
      widths: { ...W, Field: 42, Validation: 55, Runs: 40, Example: 70, Key: 50 } },
  ]);
}
async function writeGold(name, gold, meta) {
  const file = `${safe(name)}.csv`;
  writeCsv(path.join(goldDir, file), [...COLS, 'In branches'], gold);
  await writeGoldXlsx(path.join(goldDir, `${safe(name)}.xlsx`), name, gold, meta);
  register({ name, file, ...meta, rules: gold.length, created: new Date().toISOString().slice(0, 10) });
  console.log(`gold ${name}: ${gold.length} validations (in ≥${Math.round((meta.min_share ?? 1) * 100)}% of ${meta.built_from.length} branches) -> ${path.join(goldDir, file)}`);
}

// ---------- compare ----------
// waivers.csv Key may use * as a wildcard, e.g.  L2 | issue* | *   (all L2 IGM checks)
function waiverFor(waivers, key) {
  if (waivers.has(key)) return waivers.get(key);
  for (const [k, w] of waivers) {
    if (!k.includes('*')) continue;
    const re = new RegExp('^' + k.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    if (re.test(key)) return w;
  }
  return null;
}
function compareBranch(cur, gold, waivers) {
  const goldFields = new Map();                     // API → set of normalised fields in the baseline
  for (const g of gold) { if (!goldFields.has(g.API)) goldFields.set(g.API, new Set()); goldFields.get(g.API).add(normField(g.Field)); }
  const rows = [];
  for (const g of gold) {
    const c = cur.get(g.Key);
    const goldRun = (g.Runs || '').split(' (')[0];
    let status, todo = '';
    const waived = waiverFor(waivers, g.Key);
    if (!c) {
      status = 'MISSING'; todo = 'Add this validation, or add its Key to waivers.csv with a reason';
    } else {
      // Skip-state rule: a skip condition the gold row also has is part of the common base (fine).
      // An extra condition is a WARN when its field is validated in the baseline, a BLOCKER when it is not.
      const split = (s) => String(s || '').split(';').map((x) => x.trim()).filter(Boolean);
      const deps = c._runs === 'Conditional' ? split(c['Depends on']) : [];
      const goldDeps = new Set(split(g['Depends on']).map(normField));
      const extra = deps.filter((d) => !goldDeps.has(normField(d)));
      const fromPrev = (d) => /^session data|from (a )?previous call|^user input/.test(d);   // data saved by earlier calls / form input
      const outside = extra.filter((d) => !fromPrev(d) && !(goldFields.get(g.API) || new Set()).has(normField(d)));
      const weaker = RUN_RANK[c._runs] > (RUN_RANK[goldRun] ?? 0);
      if (outside.length) {
        status = 'BLOCKER'; todo = `Hidden skip: the skip condition on ${outside.join(', ')} is not in the gold baseline, and the baseline does not validate that field for ${g.API} - so this core check silently stops running`;
      } else if (weaker || extra.length) {
        status = 'CONDITIONAL'; todo = `Gold: ${g.Runs || 'Always'}. Branch skips it in more cases${extra.length ? ` (extra condition on ${extra.join(', ')})` : ''}`;
      } else if (g.Values && (VALUE_LIST.test(g.Check) ? !g.Values.split(', ').every((v) => c.Values.split(', ').includes(v)) : g.Values !== c.Values)) {
        status = 'DIFFERENT VALUES'; todo = 'Branch does not accept all gold values';
      } else status = 'OK';
    }
    if (waived && ['MISSING', 'BLOCKER', 'CONDITIONAL', 'DIFFERENT VALUES'].includes(status)) { todo = `Waived (${status}): ${waived.Reason || ''}${waived['Approved by'] ? ` - approved by ${waived['Approved by']}` : ''}`; status = 'WAIVED'; }
    rows.push({ Status: status, Layer: g.Layer, API: g.API, Field: g.Field, Check: g.Check,
      'Gold values': g.Values, 'Branch values': c?.Values ?? '', 'Gold runs': g.Runs, 'Branch runs': c?.Runs ?? '',
      'What to do': todo, Key: g.Key, 'Gold example': [g.Source, g.Code].filter(Boolean).join('\n'),
      'Branch source': c?.Source ?? '', 'Branch code': c?.Code ?? '', _g: g, _c: c });
    cur.delete(g.Key);
  }
  for (const c of cur.values())
    rows.push({ Status: 'EXTRA', Layer: c.Layer, API: c.API, Field: c.Field, Check: c.Check, 'Gold values': '', 'Branch values': c.Values,
      'Gold runs': '', 'Branch runs': c.Runs, 'What to do': 'Domain-specific - allowed', Key: c.Key,
      'Gold example': '', 'Branch source': c.Source, 'Branch code': c.Code, _c: c });
  const order = { BLOCKER: 0, MISSING: 1, CONDITIONAL: 2, 'DIFFERENT VALUES': 3, WAIVED: 4, OK: 5, EXTRA: 6 };
  rows.sort((a, b) => order[a.Status] - order[b.Status] || a.Key.localeCompare(b.Key));
  return rows;
}
const SUMMARY = [
  ['MISSING', 'Gold validation not found in the branch', 'FAIL'],
  ['BLOCKER', 'Found, but hidden behind a skip condition on a field that is not in the baseline', 'FAIL'],
  ['CONDITIONAL', 'Found, but skipped in some cases where gold runs it', 'WARN'],
  ['DIFFERENT VALUES', 'Found, but allowed values differ from gold', 'WARN'],
  ['WAIVED', 'Would fail or warn, but is listed in waivers.csv', 'OK'],
  ['OK', 'Matches gold', 'OK'],
  ['EXTRA', 'Only in this branch (domain-specific)', 'INFO'],
];

// ---------- commands ----------
const json = JSON.parse(fs.readFileSync(need('in'), 'utf8'));
const branches = byBranch(json);
const pickBranches = (b) => (b && b !== true ? String(b).split(',').map((s) => s.trim()) : [...branches.keys()]);

if (cmd === 'simplify') {
  const outDir = need('out');
  for (const [branch, rows] of branches) {
    const list = simplify(rows);
    const base = path.join(outDir, `${safe(branch)}_validations`);
    writeCsv(base + '.csv', COLS, list);
    await writeXlsx(base + '.xlsx', [{ name: 'Validations', cols: COLS, rows: list, widths: W }]);
    console.log(`${branch}: ${list.length} validations -> ${base}.xlsx / .csv`);
  }
}

else if (cmd === 'build-gold') {
  const pick = pickBranches(need('branches'));
  const minShare = Number(args['min-share'] ?? 1);
  const gold = buildGold(branches, pick, minShare);
  await writeGold(need('name'), gold, {
    scope: args.scope || 'family',
    domains: [...new Set(pick.map((b) => branches.get(b).domain))].sort(),
    versions: [...new Set(pick.map((b) => String(branches.get(b).version)))].sort(),
    built_from: pick, min_share: minShare, approved_by: '',
  });
}

else if (cmd === 'build-all') {
  const fam = YAML.parse(fs.readFileSync(need('families'), 'utf8'));
  for (const f of fam.families) {
    const pick = f.branches.filter((b) => branches.has(b));
    const skipped = f.branches.filter((b) => !branches.has(b));
    if (skipped.length) console.log(`  ${f.name}: not in input, skipped: ${skipped.join(', ')}`);
    if (pick.length < 2) { console.log(`  ${f.name}: needs at least 2 branches - skipped`); continue; }
    const gold = buildGold(branches, pick, f.min_share ?? 1);
    await writeGold(f.name, gold, {
      scope: f.scope || 'family',
      domains: f.domains || [...new Set(pick.map((b) => branches.get(b).domain))].sort(),
      versions: (f.versions || [...new Set(pick.map((b) => String(branches.get(b).version)))]).map(String).sort(),
      built_from: pick, min_share: f.min_share ?? 1, approved_by: f.approved_by || '',
    });
  }
}

else if (cmd === 'compare') {
  const outDir = need('out');
  const goldArg = need('gold');
  const waivers = new Map(args.waivers && args.waivers !== true && fs.existsSync(args.waivers) ? (await readTable(args.waivers)).map((w) => [w.Key, w]) : []);
  let failed = false;
  const overview = [];
  for (const branch of pickBranches(args.branch)) {
    if (!branches.has(branch)) { console.error(`branch not in input: ${branch}`); process.exit(2); }
    const b = branches.get(branch);
    let goldFile = goldArg, goldName = path.basename(goldArg);
    if (goldArg === 'auto') {
      const e = pickGold(b.domain, b.version);
      if (!e) { console.log(`${branch}: no baseline registered for ${b.domain} ${b.version} - skipped`); overview.push({ Branch: branch, Domain: b.domain, Version: b.version, Baseline: '(none)', Result: 'INFO' }); continue; }
      goldFile = path.join(goldDir, e.file); goldName = e.name;
    }
    const gold = await readTable(goldFile);
    const rows = compareBranch(new Map(simplify(b).map((r) => [r.Key, r])), gold, waivers);
    const count = (s) => rows.filter((r) => r.Status === s).length;
    const summary = SUMMARY.map(([s, m, r]) => ({ Status: s, Meaning: m, Result: r, Count: count(s) }));
    const cc = coverage(b.l2, catalog);
    const result = count('MISSING') + count('BLOCKER') ? 'FAIL' : count('CONDITIONAL') + count('DIFFERENT VALUES') ? 'WARN' : 'OK';
    const file = path.join(outDir, `${safe(branch)}_vs_${safe(goldName)}.xlsx`);
    await writeXlsx(file, [
      { name: 'Summary', cols: ['Status', 'Meaning', 'Result', 'Count'], rows: [...summary,
        { Status: 'Baseline', Meaning: goldName, Result: result, Count: gold.length },
        { Status: 'Cross-call', Meaning: 'Common cross-call checks implemented in L2 (see Cross-call tab)', Result: 'INFO', Count: `${cc.filter((c) => c.Covered === 'Yes').length}/${cc.length}` }], widths: { Meaning: 60 } },
      { name: 'Comparison', cols: ['Status', 'Layer', 'API', 'Field', 'Check', 'Gold values', 'Branch values', 'Gold runs', 'Branch runs', 'What to do', 'Gold example', 'Branch source', 'Branch code', 'Key'], rows, widths: W },
      { name: 'Cross-call', cols: ['ID', 'Group', 'Check', 'Covered', 'Checked in APIs', 'Occurrences', 'Example'], rows: cc, widths: W },
    ]);
    console.log(`${branch} vs ${goldName}: ${result}  ` + summary.map((s) => `${s.Status}=${s.Count}`).join('  ') + `  cross-call=${cc.filter((c) => c.Covered === 'Yes').length}/${cc.length}  -> ${file}`);
    const msgs = developerMessages(rows, { branch, goldName, result, summary, maxWarnings: Number(args['max-warnings'] ?? 20) });
    console.log(msgs.text);
    fs.writeFileSync(path.join(outDir, `${safe(branch)}_fix-list.md`), msgs.markdown);
    if (process.env.GITHUB_ACTIONS === 'true') {
      for (const a of msgs.annotations) console.log(a);
      if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, msgs.markdown + '\n');
    }
    overview.push({ Branch: branch, Domain: b.domain, Version: b.version, Baseline: goldName, Result: result,
      ...Object.fromEntries(summary.map((s) => [s.Status, s.Count])), 'Cross-call covered': `${cc.filter((c) => c.Covered === 'Yes').length}/${cc.length}`, Report: path.basename(file) });
    if (result === 'FAIL') failed = true;
  }
  if (overview.length > 1)
    await writeXlsx(path.join(outDir, 'Compare_overview.xlsx'), [{ name: 'Overview', rows: overview, color: ['Result'],
      cols: ['Branch', 'Domain', 'Version', 'Baseline', 'Result', 'MISSING', 'BLOCKER', 'CONDITIONAL', 'DIFFERENT VALUES', 'WAIVED', 'OK', 'EXTRA', 'Cross-call covered', 'Report'], widths: { Branch: 30, Baseline: 22, Report: 50 } }]);
  process.exit(failed ? 1 : 0);
}

else if (cmd === 'partition') {
  // One domain, several use cases (branches) → 4 outputs:
  //   1_common/        validations present in ALL use cases
  //   2_intersection/  present in more than one but not all (e.g. 3 of 5), with Present in / Missing in / Remarks
  //   3_specific/      one file per use case with the validations ONLY that use case has
  //   summary          counts per bucket and per use case
  // Each in JSON (keys sorted, rows in a fixed order, for clean diffs), CSV and XLSX.
  const pick = pickBranches(need('branches'));
  const name = need('name'); const outDir = need('out');
  const label = (b) => String(b).replace(/^draft-/, '');
  const lists = new Map(pick.map((b) => { if (!branches.has(b)) { console.error(`branch not in input: ${b}`); process.exit(2); } return [b, new Map(simplify(branches.get(b)).map((r) => [r.Key, r]))]; }));
  const keys = [...new Set([...lists.values()].flatMap((l) => [...l.keys()]))];
  const order = (a, b) => apiRank(a.API) - apiRank(b.API) || (a.API < b.API ? -1 : a.API > b.API ? 1 : 0) || (a.Layer < b.Layer ? -1 : a.Layer > b.Layer ? 1 : 0) || (a.Key < b.Key ? -1 : a.Key > b.Key ? 1 : 0);
  const sortKeys = (v) => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;
  const common = [], inter = [], specific = new Map(pick.map((b) => [b, []]));
  for (const key of keys) {
    const has = pick.filter((b) => lists.get(b).has(key)); const all = has.map((b) => ({ b, r: lists.get(b).get(key) }));
    const base = all[0].r;
    // Runs: the majority setting (ties → the stronger one); Values: for value lists, the values every use case accepts
    const votes = new Map(); for (const { r } of all) { const k = `${r._runs}|${r['Depends on']}`; votes.set(k, [...(votes.get(k) || []), r]); }
    const runsRow = [...votes.values()].sort((a, b) => b.length - a.length || RUN_RANK[a[0]._runs] - RUN_RANK[b[0]._runs])[0][0];
    const remarks = [];
    let values = base.Values;
    if (new Set(all.map(({ r }) => r.Values)).size > 1) {
      if (VALUE_LIST.test(base.Check)) {
        const sets = all.map(({ r }) => new Set(r.Values ? r.Values.split(', ') : []));
        values = [...sets[0]].filter((v) => sets.every((st) => st.has(v))).sort().join(', ');
        remarks.push(`Values differ - common values: ${values || '(none)'}; ` + all.map(({ b, r }) => `${label(b)}: ${r.Values || '-'}`).join('; '));
      } else { values = runsRow.Values; remarks.push('Values differ - ' + all.map(({ b, r }) => `${label(b)}: ${r.Values || '-'}`).join('; ')); }
    }
    if (votes.size > 1) remarks.push('Runs differ - ' + all.map(({ b, r }) => `${label(b)}: ${r.Runs}`).join('; '));
    const row = { Key: key, Layer: base.Layer, API: base.API, Field: base.Field, Check: base.Check, Values: values, Runs: runsRow.Runs,
      'Depends on': runsRow['Depends on'], Validation: base.Validation, 'Cross-call ID': base['Cross-call ID'] || '',
      'In branches': `${has.length}/${pick.length}`, Source: `${runsRow.Branch}: ${runsRow.Source}`, Code: runsRow.Code };
    if (has.length === pick.length) common.push({ ...row, Remarks: remarks.join(' | ') });
    else if (has.length > 1) {
      const missing = pick.filter((b) => !has.includes(b));
      inter.push({ ...row, 'Present in': has.map(label).join(', '), 'Missing in': missing.map(label).join(', '),
        Remarks: [`Present in ${has.length} of ${pick.length} use cases; missing in ${missing.map(label).join(', ')}`, ...remarks].join(' | '),
        ...Object.fromEntries(pick.map((b) => [label(b), lists.get(b).has(key) ? (lists.get(b).get(key).Values || 'Yes') : '-'])) });
    } else specific.get(has[0]).push({ ...row, 'Use case': label(has[0]), Values: base.Values, Runs: base.Runs, 'Depends on': base['Depends on'], Source: base.Source, Code: base.Code });
  }
  const BASE = ['Key', 'Layer', 'API', 'Field', 'Check', 'Values', 'Runs', 'Depends on', 'Validation', 'Cross-call ID'];
  const COLS_COMMON = [...BASE, 'In branches', 'Remarks'];
  const COLS_INTER = [...BASE, 'In branches', 'Present in', 'Missing in', ...pick.map(label), 'Remarks'];
  const COLS_SPEC = ['Use case', ...BASE];
  const WW = { ...W, Remarks: 70, 'Present in': 30, 'Missing in': 30, Code: 60, Source: 45, ...Object.fromEntries(pick.map((b) => [label(b), 18])) };
  // Every file has the L1 and L2 validations apart: XLSX → one tab per layer, CSV → one file per layer, JSON → { L1: [...], L2: [...] }
  const LAYERS = ['L1', 'L2'];
  const tabName = (t) => t.replace(/[\[\]:*?/\\]/g, '_').slice(0, 31);
  const pickCols = (cols, r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? '']));
  const split = (rows) => Object.fromEntries(LAYERS.map((l) => [l, rows.filter((r) => r.Layer === l).sort(order)]));
  const write = async (dir, base, cols, rows, title) => {
    const file = path.join(outDir, dir, base); fs.mkdirSync(path.dirname(file), { recursive: true });
    const by = split(rows);
    fs.writeFileSync(file + '.json', JSON.stringify(sortKeys(Object.fromEntries(LAYERS.map((l) => [l, by[l].map((r) => pickCols(cols, r))]))), null, 1) + '\n');
    for (const l of LAYERS) writeCsv(`${file}_${l}.csv`, cols, by[l]);
    await writeXlsx(file + '.xlsx', LAYERS.map((l) => ({ name: tabName(`${title} ${l}`), cols, rows: by[l], widths: WW })));
    return file;
  };
  const files = [];
  files.push(await write('1_common', `${safe(name)}_common`, COLS_COMMON, common, 'Common'));
  files.push(await write('2_intersection', `${safe(name)}_intersection`, COLS_INTER, inter, 'Intersection'));
  // use-case specific: ONE file - XLSX with a tab per use case and layer, CSV per layer (with a Use case column), JSON { use case: { L1, L2 } }
  {
    const file = path.join(outDir, '3_specific', `${safe(name)}_specific`); fs.mkdirSync(path.dirname(file), { recursive: true });
    const per = pick.map((b) => ({ uc: label(b), by: split(specific.get(b)) }));
    fs.writeFileSync(file + '.json', JSON.stringify(sortKeys(Object.fromEntries(per.map(({ uc, by }) => [uc, Object.fromEntries(LAYERS.map((l) => [l, by[l].map((r) => pickCols(COLS_SPEC, r))]))]))), null, 1) + '\n');
    for (const l of LAYERS) writeCsv(`${file}_${l}.csv`, COLS_SPEC, per.flatMap(({ by }) => by[l]));
    const used = new Set(); const uniq = (t) => { let n = tabName(t), i = 2; while (used.has(n)) n = tabName(`${t.slice(0, 27)} ${i++}`); used.add(n); return n; };
    await writeXlsx(file + '.xlsx', per.flatMap(({ uc, by }) => LAYERS.map((l) => ({ name: uniq(`${uc} ${l}`), cols: COLS_SPEC, rows: by[l], widths: WW }))));
    files.push(file);
  }
  // summary
  const nL = (rows, l) => rows.filter((r) => r.Layer === l).length;
  const summary = pick.map((b) => { const mine = inter.filter((r) => lists.get(b).has(r.Key)); const all = [...lists.get(b).values()];
    return { 'Use case': label(b), Domain: branches.get(b).domain, Version: String(branches.get(b).version), 'Total validations': all.length,
      Common: common.length, 'In intersection': mine.length, Specific: specific.get(b).length,
      ...Object.fromEntries(LAYERS.flatMap((l) => [[`Total ${l}`, nL(all, l)], [`Common ${l}`, nL(common, l)], [`In intersection ${l}`, nL(mine, l)], [`Specific ${l}`, nL(specific.get(b), l)]])) }; });
  const SCOLS = ['Use case', 'Domain', 'Version', 'Total validations', 'Common', 'In intersection', 'Specific',
    ...LAYERS.flatMap((l) => [`Total ${l}`, `Common ${l}`, `In intersection ${l}`, `Specific ${l}`])];
  const meta = { name, use_cases: pick.map(label), common: common.length, intersection: inter.length,
    specific: Object.fromEntries(pick.map((b) => [label(b), specific.get(b).length])), per_use_case: summary };
  fs.writeFileSync(path.join(outDir, `${safe(name)}_summary.json`), JSON.stringify(sortKeys(meta), null, 1) + '\n');
  writeCsv(path.join(outDir, `${safe(name)}_summary.csv`), SCOLS, summary);
  const legend = [
    { File: '1_common', Contains: `Validations present in all ${pick.length} use cases (Remarks: where values or run conditions differ)` },
    { File: '2_intersection', Contains: 'Validations present in more than one but not all use cases - Present in / Missing in, one column per use case' },
    { File: '3_specific', Contains: 'One file: a tab per use case and layer (e.g. "TRV11-2.1.0 L1") with the validations only that use case has' },
    { File: 'Layers', Contains: 'Every file keeps L1 and L2 apart: XLSX tabs "... L1" / "... L2", CSV files *_L1.csv / *_L2.csv, JSON { "L1": [...], "L2": [...] }' },
  ];
  await writeXlsx(path.join(outDir, `${safe(name)}_summary.xlsx`), [{ name: 'Summary', cols: SCOLS, rows: summary, widths: { 'Use case': 28 } },
    { name: 'Files', cols: ['File', 'Contains'], rows: legend, widths: { File: 18, Contains: 100 } }]);
  console.log(`${name}: ${pick.length} use cases → common ${common.length} | intersection ${inter.length} | specific ` + pick.map((b) => `${label(b)} ${specific.get(b).length}`).join(', '));
  console.log(`  ${outDir}/${safe(name)}_summary.xlsx\n  ${outDir}/1_common/  ${outDir}/2_intersection/  ${outDir}/3_specific/   (.xlsx with L1/L2 tabs, .json, _L1.csv/_L2.csv)`);
}

else if (cmd === 'crosscall') {
  const outDir = need('out');
  const pick = pickBranches(args.branches);
  const matrix = catalog.checks.map((c) => ({ ID: c.id, Group: c.group, Check: c.desc }));
  for (const b of pick) {
    const cov = new Map(coverage(branches.get(b).l2, catalog).map((r) => [r.ID, r]));
    for (const m of matrix) m[b] = cov.get(m.ID).Covered === 'Yes' ? 'Yes' : 'No';
  }
  for (const m of matrix) m['Branches covering'] = pick.filter((b) => m[b] === 'Yes').length;
  const file = path.join(outDir, 'Cross-call_coverage.xlsx');
  await writeXlsx(file, [{ name: 'Coverage', cols: ['ID', 'Group', 'Check', ...pick, 'Branches covering'], rows: matrix, color: pick, widths: { Check: 55 } }]);
  console.log(`cross-call coverage for ${pick.length} branches -> ${file}`);
  for (const b of pick) console.log(`  ${b.padEnd(28)} ${matrix.filter((m) => m[b] === 'Yes').length}/${matrix.length}`);
}

else {
  console.error('usage: node gold.mjs simplify|build-gold|build-all|compare|crosscall --in validations.json ...  (see header)');
  process.exit(2);
}
