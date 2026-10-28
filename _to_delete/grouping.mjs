#!/usr/bin/env node
/**
 * grouping.mjs - L1 grouping analysis per branch (analysis only: never writes to the spec repo).
 *
 *   node grouping.mjs --repo <git dir> --ref <branch> [--ref <branch> …] [--out out/grouping] [--name overview]
 *   node grouping.mjs --config <spec>/config --label <name> [--out …]
 *
 *   --safe-only  only the Safe grouping opportunities, each with "How to fix" and a YAML example
 *                (<out>/<branch>/grouping_safe.xlsx + .json; no differences / risks / inventory tabs)
 * Per branch: <out>/<branch>/grouping.xlsx + grouping.json. With 2+ branches also <out>/<name>.xlsx + .json
 * (cross-branch overview: which finding occurs in which branch, matched by content, not by line).
 * Usually run through `npm run grouping -- <branch|GROUP> …` (fetches from GitHub first).
 */
import fs from 'node:fs'; import path from 'node:path'; import { execFileSync } from 'node:child_process';
import ExcelJS from 'exceljs';
import { analyseL1 } from './lib/l1-grouping.mjs';

const argv = process.argv.slice(2); const a = { ref: [] };
for (let i = 0; i < argv.length; i++) { const k = argv[i]; if (k === '--ref') a.ref.push(argv[++i]); else if (k === '--safe-only') a.safeOnly = true; else if (k.startsWith('--')) a[k.slice(2)] = argv[++i]; }
const out = a.out || 'out/grouping';
const sources = a.config ? [{ label: a.label || path.basename(path.resolve(a.config, '..')), text: fs.readFileSync(path.join(a.config, 'validations', 'index.yaml'), 'utf8'), commit: '' }]
  : a.ref.map(ref => ({ label: ref.replace(/^(origin|upstream)\//, ''), text: execFileSync('git', ['-C', a.repo, 'show', `${ref}:config/validations/index.yaml`], { maxBuffer: 1 << 28 }).toString(),
    commit: execFileSync('git', ['-C', a.repo, 'log', '-1', '--format=%h %cs', ref]).toString().trim() }));
if (!sources.length) { console.error('usage: node grouping.mjs --repo <git dir> --ref <branch> [--ref …] | --config <dir>'); process.exit(2); }

const sortKeys = (v) => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])])) : v;
const NAVY = 'FF1F3A5F', GRID = { style: 'thin', color: { argb: 'FFD9DEE5' } };
async function writeXlsx(file, sheets) {
  const wb = new ExcelJS.Workbook(); wb.created = new Date(0);
  for (const { name, cols, rows, color } of sheets) {
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = cols.map(([header, key, width]) => ({ header, key, width }));
    rows.forEach(r => ws.addRow(r));
    ws.getRow(1).eachCell(c => { c.font = { name: 'Arial', bold: true, color: { argb: 'FFFFFFFF' }, size: 10 }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; c.alignment = { vertical: 'middle', wrapText: true }; });
    ws.getRow(1).height = 30;
    ws.eachRow((row, i) => { if (i === 1) return; row.eachCell({ includeEmpty: true }, c => { c.font = { name: 'Arial', size: 10 }; c.alignment = { vertical: 'top', wrapText: true }; c.border = { top: GRID, bottom: GRID, left: GRID, right: GRID }; });
      if (color) { const c = row.getCell(color); const v = String(c.value || ''); if (/^Safe/.test(v)) c.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FF1E6B34' } }; else if (/Needs decision/.test(v)) c.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFB54708' } }; } });
    if (rows.length) ws.autoFilter = { from: 'A1', to: { row: 1, column: cols.length } };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true }); await wb.xlsx.writeFile(file);
}
const F = 'config/validations/index.yaml';
const results = [];
for (const s of sources) {
  const { findings: f, stats } = analyseL1(s.text);
  const id = (pre, i) => `${pre}${String(i + 1).padStart(2, '0')}`;
  const opps = f.opportunities.sort((x, y) => x.detector.localeCompare(y.detector, undefined, { numeric: true }) || x.lines.localeCompare(y.lines, undefined, { numeric: true })).map((o, i) => ({ id: id('G', i), ...o }));
  const diffs = f.differences.sort((x, y) => x.detector.localeCompare(y.detector, undefined, { numeric: true })).map((o, i) => ({ id: id('D', i), ...o }));
  const risks = f.risks.map((o, i) => ({ id: id('R', i), ...o }));
  const dir = path.join(out, s.label.replace(/[^\w.-]+/g, '_'));
  if (a.safeOnly) {   // only the Safe grouping opportunities, with how to fix them
    const safe = opps.filter(o => o.verdict === 'Safe').map((o, i) => ({ ...o, id: `G${String(i + 1).padStart(2, '0')}` }));
    await writeXlsx(path.join(dir, 'grouping_safe.xlsx'), [{ name: 'Grouping opportunities', cols: [['ID', 'id', 6], ['Type', 'detector', 24], ['Area', 'area', 14], ['Condition', 'condition', 40], ['Rules', 'rules', 36],
      ['APIs', 'apis', 24], ['Lines', 'lines', 24], ['Today', 'today', 32], ['Why it is safe', 'reason', 32], ['How to fix', 'howToFix', 70], ['Example (YAML after the change)', 'example', 70]], rows: safe }]);
    fs.writeFileSync(path.join(dir, 'grouping_safe.json'), JSON.stringify(sortKeys({ branch: s.label, commit: s.commit, file: F, opportunities: safe }), null, 1) + '\n');
    results.push({ s, opps: safe, diffs: [], risks: [] });
    console.log(`ok  ${s.label.padEnd(30)} safe grouping opportunities ${safe.length} (of ${opps.length}) → ${dir}/grouping_safe.xlsx`);
    continue;
  }
  const count = (rows) => { const m = {}; rows.forEach(r => m[r.detector] = (m[r.detector] || 0) + 1); return Object.entries(m).map(([k, v]) => `${k}: ${v}`).join('; '); };
  const summary = [
    { item: 'Branch', value: `${s.label}${s.commit ? ` @ ${s.commit}` : ''}` },
    { item: 'File', value: `${F} - ${s.text.split('\n').length} lines, ${stats.rules} rules, ${stats.conditions} skip conditions (_CONTINUE_)` },
    { item: 'Scope', value: 'L1 only. Analysis only - nothing in the spec repo is changed. Line numbers refer to the file at this commit.' },
    { item: 'Grouping opportunities', value: `${opps.length} (${opps.filter(o => o.verdict === 'Safe').length} Safe, ${opps.filter(o => o.verdict !== 'Safe').length} Needs decision) - ${count(opps)}` },
    { item: 'Business logic differences', value: `${diffs.length} - ${count(diffs)}` },
    { item: 'Risks to check before grouping', value: `${risks.length} - ${count(risks)}` },
    { item: 'Verdicts', value: 'Safe = behaviour is unchanged (same condition, same payload, same filters, same inherited conditions). Needs decision = grouping would change behaviour for some payloads, or the rules differ; the reason column says why.' },
  ];
  await writeXlsx(path.join(dir, 'grouping.xlsx'), [
    { name: 'Summary', cols: [['Item', 'item', 30], ['Detail', 'value', 140]], rows: summary },
    { name: 'Grouping opportunities', color: 'verdict', cols: [['ID', 'id', 6], ['Detector', 'detector', 26], ['Area', 'area', 16], ['Condition', 'condition', 40], ['Rules', 'rules', 40], ['APIs', 'apis', 26], ['Lines', 'lines', 26], ['Parent', 'parent', 26], ['Today', 'today', 36], ['Suggestion', 'suggestion', 40], ['Verdict', 'verdict', 14], ['Reason', 'reason', 40]], rows: opps },
    { name: 'Business logic differences', cols: [['ID', 'id', 6], ['Detector', 'detector', 26], ['Area', 'area', 16], ['What', 'what', 50], ['Lines', 'lines', 30], ['Detail', 'detail', 90]], rows: diffs },
    { name: 'Risks', cols: [['ID', 'id', 6], ['Detector', 'detector', 28], ['What', 'what', 60], ['Lines', 'lines', 30], ['Detail', 'detail', 80]], rows: risks },
    { name: 'Condition inventory', cols: [['Line', 'line', 8], ['Rule / group', 'name', 34], ['Kind', 'kind', 16], ['APIs', 'apis', 34], ['Condition (_CONTINUE_)', 'condition', 46], ['Resolved', 'canonical', 60], ['Self-presence guard', 'selfGuard', 12]], rows: f.inventory.sort((x, y) => x.line - y.line) },
  ]);
  fs.writeFileSync(path.join(dir, 'grouping.json'), JSON.stringify(sortKeys({ branch: s.label, commit: s.commit, stats, opportunities: opps, differences: diffs, risks, inventory: f.inventory }), null, 1) + '\n');
  results.push({ s, opps, diffs, risks });
  console.log(`ok  ${s.label.padEnd(30)} opportunities ${String(opps.length).padEnd(3)} (Safe ${opps.filter(o => o.verdict === 'Safe').length}) · differences ${diffs.length} · risks ${risks.length} → ${dir}/grouping.xlsx`);
}
// cross-branch overview: same finding = same detector + same content key (lines are not compared)
if (results.length > 1) {
  const m = new Map();
  for (const { s, opps, diffs, risks } of results) for (const [kind, rows] of [['Opportunity', opps], ['Difference', diffs], ['Risk', risks]]) for (const r of rows) {
    const k = `${kind}|${r.key}`; const e = m.get(k) || m.set(k, { kind, detector: r.detector, what: r.condition || r.what || r.rules || '', rules: r.rules || '', per: {} }).get(k);
    e.per[s.label] = `${r.verdict ? r.verdict + ' · ' : ''}${r.id} @ ${r.lines}`;
  }
  const labels = results.map(r => r.s.label);
  const rows = [...m.values()].map(e => ({ ...e, branches: Object.keys(e.per).length, ...Object.fromEntries(labels.map(l => [l, e.per[l] || '-'])) }))
    .sort((x, y) => y.branches - x.branches || x.kind.localeCompare(y.kind) || x.detector.localeCompare(y.detector, undefined, { numeric: true }));
  const name = a.name || 'overview';
  await writeXlsx(path.join(out, `${name}.xlsx`), [{ name: 'Cross-branch overview', cols: [['Kind', 'kind', 12], ['Detector', 'detector', 26], ['Condition / what', 'what', 50], ['Rules', 'rules', 30], ['# branches', 'branches', 10], ...labels.map(l => [l, l, 26])], rows }]);
  fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(sortKeys({ branches: labels, findings: rows.map(({ per, ...r }) => ({ ...r, per })) }), null, 1) + '\n');
  console.log(`cross-branch overview: ${rows.length} findings, ${rows.filter(r => r.branches === labels.length).length} in all ${labels.length} branches → ${path.join(out, name)}.xlsx`);
}
