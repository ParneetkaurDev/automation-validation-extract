#!/usr/bin/env node
/**
 * check-generators.mjs - checks the mock generators, meetsRequirements() and saveData of every flow step
 * (analysis only: decodes and parses the base64 code, never runs it and never writes to the spec repo).
 *
 *   node check-generators.mjs --repo <git dir> --ref <branch> [--ref …] [--out out/generators] [--flow <text>]
 *   node check-generators.mjs --config <spec>/config [--label <name>] [--out …]
 *   --runtime-keys a,b   extra sessionData keys the runtime provides itself (not through saveData)
 *
 * Per branch: <out>/<branch>/generator-checks.xlsx + .json (validations read with the same L2 extractor as validate())
 *   Requirements validations  every validation in requirements.js (meetsRequirements)
 *   Generator validations     every validation in generate() (if … throw) + Duplicate when requirements.js or validate() already has it
 *   Static vs Dynamic         every payload field generate() sends: Dynamic (sessionData / user input / context / generated)
 *                             or Static (hardcoded / defaultPayload), with the sessionData value to use where it could be dynamic
 *   Summary                   totals, duplicates, static vs dynamic counts and percentages, per flow
 *   --full                    also generator-checks_full.xlsx (dynamic ids, requirement gaps, code quality, suggestions)
 * Usually run through `npm run check-generators -- <branch|GROUP> …` (fetches from GitHub first).
 */
import fs from 'node:fs'; import path from 'node:path'; import { execFileSync } from 'node:child_process';
import ExcelJS from 'exceljs';
import { analyseFlows, flowIndexRefs, RUNTIME_KEYS } from './lib/generator-checks.mjs';

const argv = process.argv.slice(2); const a = { ref: [] };
for (let i = 0; i < argv.length; i++) { const k = argv[i]; if (k === '--ref') a.ref.push(argv[++i]); else if (k === '--full') a.full = true; else if (k.startsWith('--')) a[k.slice(2)] = argv[++i]; }
const out = a.out || 'out/generators';
for (const k of String(a['runtime-keys'] || '').split(',').map((x) => x.trim()).filter(Boolean)) RUNTIME_KEYS.add(k);
const git = (...args) => execFileSync('git', ['-C', a.repo, ...args], { maxBuffer: 1 << 28 }).toString();
function walkDir(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkDir(path.join(dir, e.name)) : [path.join(dir, e.name)])); }
const sources = a.config
  ? [{ label: a.label || path.basename(path.resolve(a.config, '..')), commit: '', read: () => {
      const root = path.resolve(a.config, '..');
      const files = walkDir(path.join(a.config, 'flows')).filter((f) => /\.ya?ml$/.test(f)).map((f) => path.relative(root, f).split(path.sep).join('/'));
      return { files, show: (f) => fs.readFileSync(path.join(root, f), 'utf8') };
    } }]
  : a.ref.map((ref) => ({ label: ref.replace(/^(origin|upstream)\//, ''), commit: git('log', '-1', '--format=%h %cs', ref).trim(), read: () => ({
      files: git('ls-tree', '-r', '--name-only', ref, 'config/flows').split('\n').filter((f) => /\.ya?ml$/.test(f)),
      show: (f) => git('show', `${ref}:${f}`) }) }));
if (!sources.length) { console.error('usage: node check-generators.mjs --repo <git dir> --ref <branch> [--ref …] | --config <dir>'); process.exit(2); }

const NAVY = 'FF1F3A5F', GRID = { style: 'thin', color: { argb: 'FFD9DEE5' } };
const SEV = { High: 'FFB42318', Medium: 'FFB54708', Low: 'FF175CD3', Info: 'FF667085', OK: 'FF1E6B34' };
// Readable sheets: padded cells, row heights that fit the wrapped text, one block per flow
// (a blank gap + a flow title row), and a light band that changes with every step (Action ID).
const BAND = 'FFF3F6FA', GROUP = 'FFDCE6F2', PAD = { name: 'Arial', size: 10 };
const flowName = (f) => String(f || '').replace(/^config\/flows\//, '').replace(/\.ya?ml$/, '');
async function writeXlsx(file, sheets) {
  const wb = new ExcelJS.Workbook(); wb.created = new Date(0);
  for (const { name, cols, rows, sev, dup, kind, group, custom } of sheets) {
    if (custom) { custom(wb.addWorksheet(name, { views: [{ showGridLines: false }] })); continue; }
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    const shown = group ? cols.filter(([, key]) => key !== group) : cols;   // the flow is in the block title, not in every row
    ws.columns = shown.map(([header, key, width]) => ({ header, key, width: width + 2 }));
    const head = ws.getRow(1);
    head.eachCell((c) => { c.font = { ...PAD, bold: true, color: { argb: 'FFFFFFFF' }, size: 11 }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; c.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true, indent: 1 }; });
    head.height = 34;
    const fit = (row) => {   // height = the tallest wrapped cell (≈ 1.1 chars per width unit, 15pt per line + padding)
      let lines = 1;
      shown.forEach(([, key, width], k) => { const v = String(row.getCell(k + 1).value ?? ''); const n = v.split('\n').reduce((t, l) => t + Math.max(1, Math.ceil(l.length / Math.max(8, (width + 2) * 1.1 - 2))), 0); lines = Math.max(lines, n); });
      row.height = Math.max(22, lines * 15 + 8);
    };
    let lastGroup = null, lastStep = null, band = false;
    for (const r of rows) {
      if (group && r[group] !== lastGroup) {
        if (lastGroup !== null) ws.addRow([]).height = 12;   // gap between flows
        const t = ws.addRow([flowName(r[group])]); t.height = 26;
        for (let k = 1; k <= shown.length; k++) { const c = t.getCell(k); c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GROUP } }; c.font = { ...PAD, bold: true, size: 11, color: { argb: NAVY } }; c.alignment = { vertical: 'middle', indent: 1 }; }
        lastGroup = r[group]; lastStep = null; band = false;
      }
      const stepKey = `${r.step ?? ''}|${r.action_id ?? ''}`;
      if (stepKey !== lastStep) { band = !band; lastStep = stepKey; }
      const row = ws.addRow(r);
      row.eachCell({ includeEmpty: true }, (c) => {
        c.font = { ...PAD, name: /snippet|code/i.test(String(ws.getColumn(c.col).key)) ? 'Consolas' : 'Arial' };
        c.alignment = { vertical: 'middle', wrapText: true, indent: 1 };
        c.border = { bottom: GRID, left: GRID, right: GRID };
        if (group && band) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND } };
      });
      for (const k of [dup, kind].filter(Boolean)) { const c = row.getCell(k); const v = String(c.value || ''); const col = /could be dynamic/.test(v) ? 'FFB42318' : /^Duplicate|^Static|^Mixed/.test(v) ? 'FFB54708' : /^Dynamic|^Not duplicate/.test(v) ? 'FF1E6B34' : null; if (col) c.font = { ...PAD, bold: true, color: { argb: col } }; }
      if (sev) { const c = row.getCell(sev); const col = SEV[String(c.value || '')]; if (col) c.font = { ...PAD, bold: true, color: { argb: col } }; }
      fit(row);
    }
    if (rows.length) ws.autoFilter = { from: 'A1', to: { row: 1, column: shown.length } };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true }); await wb.xlsx.writeFile(file);
}
// Summary tab: a title, then small tables (one per topic) with Count / % / Meaning, and a per-flow table
function writeSummary(ws, { title, subtitle, sections, flowTable }) {
  const W = [46, 12, 12, 70, 14, 14, 14]; W.forEach((w, k) => (ws.getColumn(k + 1).width = w));
  const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
  const line = { style: 'thin', color: { argb: 'FFD9DEE5' } };
  let r = 1;
  const t = ws.getRow(r++); t.getCell(1).value = title; t.getCell(1).font = { ...PAD, bold: true, size: 16, color: { argb: NAVY } }; t.height = 30;
  const st = ws.getRow(r++); st.getCell(1).value = subtitle; st.getCell(1).font = { ...PAD, italic: true, color: { argb: 'FF667085' } }; st.height = 20;
  r++;
  const header = (cells, n) => { const row = ws.getRow(r++); row.height = 26; cells.forEach((v, k) => { const c = row.getCell(k + 1); c.value = v; c.font = { ...PAD, bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = fill(NAVY); c.alignment = { vertical: 'middle', horizontal: k === 0 || k === 3 ? 'left' : 'center', indent: 1, wrapText: true }; }); for (let k = cells.length; k < n; k++) row.getCell(k + 1).fill = fill(NAVY); };
  for (const sec of sections) {
    const h = ws.getRow(r++); h.getCell(1).value = sec.title; h.getCell(1).font = { ...PAD, bold: true, size: 12, color: { argb: NAVY } }; h.height = 24;
    header([sec.first || 'Metric', 'Count', '%', 'What it means'], 4);
    sec.rows.forEach((x, k) => {
      const row = ws.getRow(r++);
      [x.label, x.count, x.pct ?? '', x.note || ''].forEach((v, j) => {
        const c = row.getCell(j + 1); c.value = v;
        c.font = { ...PAD, bold: !!x.bold, color: { argb: x.color || 'FF1F2933' } };
        c.alignment = { vertical: 'middle', horizontal: j === 1 || j === 2 ? 'center' : 'left', indent: x.sub && j === 0 ? 3 : 1, wrapText: true };
        c.border = { bottom: line }; if (k % 2) c.fill = fill(BAND);
      });
      row.height = Math.max(22, Math.ceil(String(x.note || '').length / 75) * 15 + 8);
    });
    r++;
  }
  const h = ws.getRow(r++); h.getCell(1).value = flowTable.title; h.getCell(1).font = { ...PAD, bold: true, size: 12, color: { argb: NAVY } }; h.height = 24;
  header(flowTable.cols, flowTable.cols.length);
  flowTable.rows.forEach((x, k) => {
    const row = ws.getRow(r++); row.height = 22;
    x.forEach((v, j) => { const c = row.getCell(j + 1); c.value = v; c.font = { ...PAD, bold: k === flowTable.rows.length - 1 }; c.alignment = { vertical: 'middle', horizontal: j === 0 ? 'left' : 'center', indent: 1 }; c.border = { bottom: line }; if (k % 2) c.fill = fill(BAND); });
  });
}
const LOC = [['Flow', 'flow', 40], ['Active', 'active', 7], ['Step', 'step', 6], ['API', 'api', 12], ['Action ID', 'action_id', 18]];
const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);

for (const s of sources) {
  const { files, show } = s.read();
  let index = null; const idx = files.find((f) => /config\/flows\/index\.ya?ml$/.test(f));
  if (idx) index = flowIndexRefs(show(idx));
  const flows = files.filter((f) => f !== idx && (!a.flow || f.toLowerCase().includes(a.flow.toLowerCase()))).map((file) => ({ file, text: show(file) }));
  const r = analyseFlows(flows, { flowIndex: index });
  const count = (rows, pred) => rows.filter(pred).length;
  const bad = (x) => x.severity === 'High' || x.severity === 'Medium';
  const perFlow = [...new Set(r.steps.map((x) => x.flow))].map((flow) => {
    const f = (rows) => rows.filter((x) => x.flow === flow);
    return { flow, active: f(r.steps)[0]?.active, steps: f(r.steps).length, generators: count(f(r.steps), (x) => x.generator !== 'none'),
      hardcoded: count(f(r.dynamic), (x) => /^Hardcoded/.test(x.status) && bad(x)), fallbacks: count(f(r.dynamic), (x) => /fallback/.test(x.status)),
      reqGaps: count(f(r.requirements), bad), high: count(f(r.quality), (x) => x.severity === 'High'), medium: count(f(r.quality), (x) => x.severity === 'Medium'), low: count(f(r.quality), (x) => x.severity === 'Low' || x.severity === 'Info') };
  });
  const tot = (k) => perFlow.reduce((n, x) => n + (x[k] || 0), 0);
  const summary = [
    ...perFlow,
    { flow: 'TOTAL', active: '', steps: tot('steps'), generators: tot('generators'), hardcoded: tot('hardcoded'), fallbacks: tot('fallbacks'), reqGaps: tot('reqGaps'), high: tot('high'), medium: tot('medium'), low: tot('low') },
  ];
  const dir = path.join(out, s.label.replace(/[^\w.-]+/g, '_'));
  // default report: requirements validations · generator validations (+ duplicates) · static vs dynamic values · summary
  const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : '-');
  // the first search / on_search of a flow is always static (nothing earlier to read from) → its static values are left out
  const firstStep = new Map(); for (const x of r.steps) if (/^(search|on_search)$/i.test(x.api)) { const k = `${x.flow}|${x.api.toLowerCase()}`; if (!firstStep.has(k) || x.step < firstStep.get(k)) firstStep.set(k, x.step); }
  const isFirstSearch = (x) => firstStep.get(`${x.flow}|${String(x.api).toLowerCase()}`) === x.step;
  // IGM steps (issue, on_issue, issue_status, on_issue_status …) are left out - they get their own report later
  const notIgm = (x) => !/^(on_)?issue/i.test(String(x.api || ''));
  const RV = r.reqValidations.filter(notIgm), GV = r.genValidations.filter(notIgm), VA = r.values.filter((x) => notIgm(x) && !(x.kind === 'Static' && isFirstSearch(x)));
  // one column for duplicates: Duplicate / Duplicate (deeper check in requirements) / Duplicate (in Validator) / Not duplicate / Check manually
  for (const x of GV) x.dupReq = x.duplicate === 'Duplicate (covered)' ? 'Duplicate (deeper check in requirements)' : x.duplicate === 'Duplicate' && /Validator/.test(x.duplicateOf) ? 'Duplicate (in Validator)' : /^(Not duplicate|Check manually)$/.test(x.duplicate) ? '-' : x.duplicate;
  for (const x of GV) if (x.dupReq === '-') x.remark = '';
  const DROP = ['active', 'step', 'api', 'id', 'onlyWhen', 'errorCode', 'condition', 'yamlLine', 'function', 'duplicateCheck', 'duplicateOf', 'swallowed', 'duplicate'];   // not shown for requirements / generator validations
  const slim = (x) => Object.fromEntries(Object.entries(x).filter(([k]) => !DROP.includes(k)));
  const dupReq = GV.filter((x) => /^Duplicate/.test(x.duplicate) && /requirements/.test(x.duplicateOf)).length;
  const dupVal = GV.filter((x) => /^Duplicate/.test(x.duplicate) && /Validator/.test(x.duplicateOf)).length;
  const dyn = VA.filter((x) => x.kind === 'Dynamic').length, sta = VA.filter((x) => x.kind === 'Static').length, man = VA.filter((x) => x.kind === 'Check manually').length;
  const opp = VA.filter((x) => x.opportunity).length;
  const flowsList = [...new Set(r.steps.map((x) => x.flow))];
  // A: one row per field, the same field in every API / flow combined
  const API_ORDER = ['search', 'on_search', 'select', 'on_select', 'init', 'on_init', 'confirm', 'on_confirm', 'status', 'on_status', 'update', 'on_update', 'cancel', 'on_cancel', 'track', 'on_track', 'issue', 'on_issue', 'issue_status', 'on_issue_status'];
  const apiSort = (a, b) => ((API_ORDER.indexOf(a) + 1 || 99) - (API_ORDER.indexOf(b) + 1 || 99)) || a.localeCompare(b);
  const list = (set, n = 6) => { const a = [...set].filter(Boolean); return a.length > n ? `${a.slice(0, n).join(', ')} … (+${a.length - n})` : a.join(', '); };
  const byField = new Map();
  for (const x of VA) {
    const f = x.field.replace(/^message\./, '');
    if (!byField.has(f)) byField.set(f, { field: f, dyn: new Set(), sta: new Set(), man: new Set(), flows: new Set(), src: new Map(), vals: new Set(), opps: [] });
    const g = byField.get(f); g.flows.add(x.flow);
    (x.kind === 'Dynamic' ? g.dyn : x.kind === 'Static' ? g.sta : g.man).add(x.api);
    (g.acts ||= { Dynamic: new Set(), Static: new Set(), other: new Set() })[x.kind === 'Dynamic' || x.kind === 'Static' ? x.kind : 'other'].add(x.action_id);
    if (x.kind === 'Dynamic') { const k = x.srcType === 'sessionData' ? 'sessionData' : x.srcType; if (!g.src.has(k)) g.src.set(k, new Set()); if (x.srcFrom) g.src.get(k).add(x.srcFrom); }
    if (x.kind === 'Static' && x.staticValue) g.vals.add(x.staticValue.length > 40 ? x.staticValue.slice(0, 39) + '…"' : x.staticValue);
    if (x.opportunity) g.opps.push(x);
  }
  const FA = [...byField.values()].map((g) => {
    const status = g.dyn.size && g.sta.size ? 'Mixed' : g.dyn.size ? 'Dynamic' : g.sta.size ? 'Static' : 'Not traced';
    const source = [...g.src].map(([k, set]) => (k === 'sessionData' ? `sessionData (saved by ${list([...set].sort(apiSort), 4)})` : k === 'user input' ? `user input (${list(set, 3)})` : k)).join('; ');
    const acts = (set) => [...set].sort((a, b) => apiSort(a.replace(/_[^_]*\d.*$/, ''), b.replace(/_[^_]*\d.*$/, '')) || a.localeCompare(b)).join(', ') || '-';
    return { field: g.field, status, staticIn: acts(g.acts.Static), dynamicIn: acts(g.acts.Dynamic),
      flows: [...g.flows].map((f) => flowName(f).split('/').pop()).sort().join('\n') };
  }).sort((a, b) => ['Static', 'Dynamic', 'Mixed', 'Not traced'].indexOf(a.status) - ['Static', 'Dynamic', 'Mixed', 'Not traced'].indexOf(b.status) || a.field.localeCompare(b.field));
  // C: only the static values that could come from an earlier call
  const FC = VA.filter((x) => x.opportunity).map((x) => ({ flow: x.flow, action_id: x.action_id, api: x.api, field: x.field.replace(/^message\./, ''), today: `${x.staticValue || '(empty)'}${x.srcType === 'defaultPayload' ? ' (from defaultPayload)' : ' (hardcoded)'}`, earlier: x.earlier, useInstead: x.opportunity.replace(/^Use /, '') }));
  const cnt = (st) => FA.filter((x) => x.status === st).length;
  const dash = [
    { metric: 'Total Requirements Validations', value: RV.length, note: 'validations extracted from requirements.js (meetsRequirements) with the L2 extractor' },
    { metric: 'Total Generator Validations', value: GV.length, note: 'validations (if … throw) extracted from generate() and the functions it calls, same L2 extractor' },
    { metric: 'Duplicate Validations', value: dupReq + dupVal, note: `${pct(dupReq + dupVal, GV.length)} of generator validations` },
    { metric: '   already in requirements.js', value: dupReq, note: 'same check (or a deeper one) in meetsRequirements()' },
    { metric: '   already in the Validator', value: dupVal, note: 'same check in validate()' },
    { metric: 'Generator values (payload fields)', value: VA.length, note: 'every field generate() sends under message' },
    { metric: '   Dynamic', value: dyn, note: `${pct(dyn, VA.length)} - from sessionData / previous call, user input, context or generated at run time` },
    { metric: '   Static', value: sta, note: `${pct(sta, VA.length)} - hardcoded or taken from defaultPayload (the first search / on_search of each flow is not counted: always static)` },
    { metric: '      of which could be dynamic', value: opp, note: `${pct(opp, sta)} of static values - the same id already comes in an earlier call` },
    { metric: '   Check manually', value: man, note: `${pct(man, VA.length)} - source could not be traced` },
    { metric: 'Unique fields (all APIs combined)', value: FA.length, note: 'one row per field in the "Static vs Dynamic" tab' },
    { metric: '   Dynamic everywhere', value: cnt('Dynamic'), note: pct(cnt('Dynamic'), FA.length) },
    { metric: '   Static everywhere', value: cnt('Static'), note: pct(cnt('Static'), FA.length) },
    { metric: '   Mixed (dynamic in some APIs, static in others)', value: cnt('Mixed'), note: `${pct(cnt('Mixed'), FA.length)} - the same field is taken from sessionData in some APIs but hardcoded / from defaultPayload in others` },
    { metric: 'Static values that could be dynamic', value: FC.length, note: 'listed in the "Could be dynamic" tab' },
    { metric: '', value: '', note: '' },
    ...flowsList.map((fl) => { const v = VA.filter((x) => x.flow === fl); const d = v.filter((x) => x.kind === 'Dynamic').length; const st = v.filter((x) => x.kind === 'Static').length;
      return { metric: fl.replace(/^config\/flows\//, ''), value: '', note: `req ${RV.filter((x) => x.flow === fl).length} · gen ${GV.filter((x) => x.flow === fl).length} (dup ${GV.filter((x) => x.flow === fl && /^Duplicate/.test(x.duplicate)).length}) · dynamic ${d} (${pct(d, v.length)}) · static ${st} (${pct(st, v.length)}) · could be dynamic ${v.filter((x) => x.opportunity).length}` }; }),
  ];
  const P = (n, d) => (d ? `${Math.round((1000 * n) / d) / 10}%` : '-');
  const RED = 'FFB42318', AMB = 'FFB54708', GRN = 'FF1E6B34';
  const summaryLayout = {
    title: `Generator & requirements analysis - ${s.label}`,
    subtitle: `commit ${s.commit} · IGM steps (issue / on_issue …) and the static values of the first search / on_search of each flow are left out`,
    sections: [
      { title: '1. Validations', rows: [
        { label: 'Requirements validations', count: RV.length, note: 'checks in requirements.js (meetsRequirements) - "Requirements validations" tab', bold: true },
        { label: 'Generator validations', count: GV.length, note: 'checks in generate() and the functions it calls (if … throw / return defaultPayload) - "Generator validations" tab', bold: true },
        { label: 'Duplicate', count: dupReq + dupVal, pct: P(dupReq + dupVal, GV.length), note: 'generator checks that are already done before the generator runs', color: dupReq + dupVal ? AMB : GRN },
        { label: 'already in requirements.js', count: dupReq, pct: P(dupReq, GV.length), note: 'can be removed from the generator', sub: true },
        { label: 'already in the Validator', count: dupVal, pct: P(dupVal, GV.length), note: 'same check in validate()', sub: true },
      ] },
      { title: '2. Generator values - every field sent, per step', rows: [
        { label: 'Payload fields sent by the generator', count: VA.length, pct: '100%', note: 'one per field per step', bold: true },
        { label: 'Dynamic', count: dyn, pct: P(dyn, VA.length), note: 'from sessionData / a previous call, user input, context, or generated (uuid / timestamp)', sub: true, color: GRN },
        { label: 'Static', count: sta, pct: P(sta, VA.length), note: 'hardcoded or taken from defaultPayload', sub: true, color: AMB },
        { label: 'Not traced', count: man, pct: P(man, VA.length), note: 'the source could not be worked out', sub: true },
        { label: 'Static values that could be dynamic', count: FC.length, pct: P(FC.length, sta), note: 'the same id already comes in an earlier call - "Could be dynamic" tab (% of static values)', bold: true, color: FC.length ? RED : GRN },
      ] },
      { title: '3. Fields - all APIs and flows combined', first: 'Field status', rows: [
        { label: 'Unique fields', count: FA.length, pct: '100%', note: '"Static vs Dynamic" tab', bold: true },
        { label: 'Static', count: cnt('Static'), pct: P(cnt('Static'), FA.length), note: 'static in every step that sends it', sub: true, color: AMB },
        { label: 'Dynamic', count: cnt('Dynamic'), pct: P(cnt('Dynamic'), FA.length), note: 'dynamic in every step that sends it', sub: true, color: GRN },
        { label: 'Mixed', count: cnt('Mixed'), pct: P(cnt('Mixed'), FA.length), note: 'dynamic in some steps, static in others - see the Static in / Dynamic in columns', sub: true },
        { label: 'Not traced', count: cnt('Not traced'), pct: P(cnt('Not traced'), FA.length), note: 'the source could not be worked out', sub: true },
      ] },
    ],
    flowTable: { title: '4. Per flow', cols: ['Flow', 'Requirements validations', 'Generator validations', 'Duplicates', 'Dynamic %', 'Static %', 'Could be dynamic'],
      rows: [...flowsList.map((fl) => { const v = VA.filter((x) => x.flow === fl); const g = GV.filter((x) => x.flow === fl);
        return [flowName(fl).split('/').pop(), RV.filter((x) => x.flow === fl).length, g.length, g.filter((x) => /^Duplicate/.test(x.duplicate)).length,
          P(v.filter((x) => x.kind === 'Dynamic').length, v.length), P(v.filter((x) => x.kind === 'Static').length, v.length), FC.filter((x) => x.flow === fl).length]; })
        .filter((x) => x[1] + x[2] + x[6] > 0 || x[4] !== '-'),
        ['Total', RV.length, GV.length, dupReq + dupVal, P(dyn, VA.length), P(sta, VA.length), FC.length]] },
  };
  await writeXlsx(path.join(dir, 'generator-checks.xlsx'), [
    { name: 'Requirements validations', group: 'flow', cols: [['Flow', 'flow', 40], ['Action ID', 'action_id', 18], ['Field', 'field', 40], ['From previous call', 'fromCall', 16], ['Check type', 'checkType', 16], ['Validation', 'validation', 60], ['Error message', 'errorMessage', 40]], rows: RV },
    { name: 'Generator validations', group: 'flow', dup: 'dupReq', cols: [['Flow', 'flow', 40], ['Action ID', 'action_id', 18], ['Field', 'field', 40], ['From previous call', 'fromCall', 16], ['Check type', 'checkType', 16], ['Validation', 'validation', 60], ['Error message', 'errorMessage', 40], ['Duplicate of requirement', 'dupReq', 24], ['Remark', 'remark', 50]], rows: GV },
    { name: 'Could be dynamic', group: 'flow', cols: [['Flow', 'flow', 40], ['Action ID', 'action_id', 18], ['Field', 'field', 40], ['Today (static)', 'today', 30], ['Same field in earlier call', 'earlier', 30], ['Use instead', 'useInstead', 70]], rows: FC },
    { name: 'Static vs Dynamic', kind: 'status', cols: [['Field', 'field', 46], ['Static / Dynamic', 'status', 16], ['Static in (Action ID)', 'staticIn', 40], ['Dynamic in (Action ID)', 'dynamicIn', 40], ['Flows', 'flows', 60]], rows: FA },
    { name: 'Summary', custom: (ws) => writeSummary(ws, summaryLayout) },
  ]);
  fs.writeFileSync(path.join(dir, 'generator-checks.json'), JSON.stringify(sortKeys({ branch: s.label, commit: s.commit, summary: dash.filter((x) => x.metric), requirements_validations: RV.map(slim), generator_validations: GV.map(slim), static_vs_dynamic: FA, could_be_dynamic: FC }), null, 1) + '\n');
  console.log(`ok  ${s.label.padEnd(28)} requirements validations ${RV.length} · generator validations ${GV.length} (duplicates ${dupReq + dupVal}) · values dynamic ${dyn} / static ${sta} (could be dynamic ${opp}) → ${dir}/generator-checks.xlsx`);
  if (!a.full) continue;
  await writeXlsx(path.join(dir, 'generator-checks_full.xlsx'), [
    { name: 'Summary', cols: [['Flow', 'flow', 60], ['Active (in flows index)', 'active', 10], ['Steps', 'steps', 8], ['Generators', 'generators', 11], ['Hardcoded ids (should be dynamic)', 'hardcoded', 14], ['Hardcoded fallbacks', 'fallbacks', 12], ['Requirement gaps', 'reqGaps', 12], ['Quality High', 'high', 10], ['Quality Medium', 'medium', 10], ['Quality Low/Info', 'low', 10]], rows: summary },
    { name: 'Dynamic fields', sev: 'severity', cols: [...LOC, ['Owner', 'owner', 7], ['Field', 'field', 40], ['Status', 'status', 30], ['Severity', 'severity', 9], ['Source', 'source', 60], ['Same id in earlier step', 'earlier', 30], ['Match', 'match', 22], ['Checked in validate', 'inValidate', 14], ['Where', 'line', 18], ['Code', 'code', 50], ['How to fix', 'fix', 70], ['YAML line (generate)', 'yamlLine', 10]], rows: r.dynamic },
    { name: 'Requirements', sev: 'severity', cols: [...LOC, ['Session key', 'key', 24], ['Used in generate()', 'used', 50], ['Where', 'usedWhere', 18], ['Saved by', 'savedBy', 50], ['Checked in meetsRequirements()', 'inRequirements', 40], ['Status', 'status', 30], ['Severity', 'severity', 9], ['How to fix', 'fix', 60], ['Suggested requirement', 'snippet', 60], ['YAML line (requirements)', 'yamlLine', 10]], rows: r.requirements },
    { name: 'Code quality', sev: 'severity', cols: [...LOC, ['Function', 'function', 16], ['Where', 'line', 18], ['Rule', 'rule', 20], ['Severity', 'severity', 9], ['Finding', 'finding', 60], ['Code', 'code', 60], ['How to fix', 'fix', 60], ['YAML line', 'yamlLine', 10]], rows: r.quality },
    { name: 'Static vs Dynamic (per step)', group: 'flow', kind: 'kind', cols: [...LOC, ['Field', 'field', 46], ['Static / Dynamic', 'kind', 14], ['Why', 'why', 70], ['Opportunity (use instead)', 'opportunity', 60], ['Same field in earlier call', 'earlier', 30], ['Code', 'code', 40], ['Where', 'where', 18]], rows: r.values },
    { name: 'Suggested checks', cols: [...LOC, ['Add to', 'target', 14], ['Why', 'reason', 50], ['Snippet', 'snippet', 90], ['YAML line', 'yamlLine', 10]], rows: r.suggestions },
  ]);
  fs.writeFileSync(path.join(dir, 'generator-checks_full.json'), JSON.stringify(sortKeys({ branch: s.label, commit: s.commit, summary, ...r }), null, 1) + '\n');
  const T = summary.at(-1);
  console.log(`ok  ${s.label.padEnd(28)} flows ${perFlow.length}, steps ${T.steps} · hardcoded ids ${T.hardcoded} · fallbacks ${T.fallbacks} · requirement gaps ${T.reqGaps} · quality H/M ${T.high}/${T.medium} → ${dir}/generator-checks_full.xlsx (full report)`);
}

