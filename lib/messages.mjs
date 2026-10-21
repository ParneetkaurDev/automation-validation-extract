// Developer-facing messages for a compare result: console text, GitHub annotations and a markdown fix list.
// Every failing row says WHAT is wrong, WHERE to fix it, an EXAMPLE that works in another branch, and HOW to waive it.

const ICON = { MISSING: '✖', BLOCKER: '✖', CONDITIONAL: '⚠', 'DIFFERENT VALUES': '⚠' };
const ghEscape = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A');
const ghProp = (s) => ghEscape(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

function whereToAdd(g) {
  if (g.Layer === 'L1') return `config/validations/index.yaml → _TESTS_ → ${g.API}`;
  const fn = /mock\.requirements/.test(g.Source || '') ? 'mock.requirements' : 'mock.validate';
  return `config/flows/**/*.yaml → the ${fn} function of the "${g.API}" step(s)`;
}
function howToFixSkip(r) {
  const c = r._c;
  if (r.Layer === 'L1')
    return `Remove the extra _CONTINUE_ condition (or move the rule out of the group that sets it) so it runs like the gold: ${r['Gold runs'] || 'Always'}`;
  return `Move the check out of the surrounding if-block (${(c?.Runs || '').replace(/^Conditional \(|\)$/g, '')}) so it runs like the gold: ${r['Gold runs'] || 'Always'}`;
}

export function describe(r) {
  const head = `${ICON[r.Status] || '•'} ${r.Status}  [${r.Layer}] ${r.API} › ${r.Field || '(payload)'} › ${r.Check}`;
  const rule = r._g?.Validation || r._c?.Validation || '';
  const lines = [];
  const waive = `add  "${r.Key}",<reason>,<approver>  to config/validation-waivers.csv`;
  if (r.Status === 'MISSING') {
    lines.push(['Missing', `${rule}${r['Gold values'] ? `  (values: ${r['Gold values']})` : ''}  - gold runs it: ${r['Gold runs'] || 'Always'}`]);
    lines.push(['Add it to', whereToAdd(r._g || r)]);
    if (r._g?.Source) lines.push(['Example', r._g.Source]);
    if (r._g?.Code) lines.push(['', r._g.Code]);
    lines.push(['Or waive', waive]);
  } else if (r.Status === 'BLOCKER') {
    lines.push(['Problem', `${rule} - but this branch skips it in some cases`]);
    lines.push(['Branch', r['Branch runs']]);
    lines.push(['Gold', r['Gold runs'] || 'Always']);
    lines.push(['Why', r['What to do']]);
    if (r._c?.Source) lines.push(['Fix here', r._c.Source]);
    if (r._c?.Code) lines.push(['', r._c.Code]);
    lines.push(['How', howToFixSkip(r)]);
    if (r._g?.Source) lines.push(['Gold example', `${r._g.Source}  ${r._g.Code || ''}`]);
    lines.push(['Or waive', waive]);
  } else if (r.Status === 'CONDITIONAL') {
    lines.push(['Warning', `${rule} - branch: ${r['Branch runs']}; gold: ${r['Gold runs']}`]);
    if (r._c?.Source) lines.push(['Where', r._c.Source]);
  } else if (r.Status === 'DIFFERENT VALUES') {
    const gold = new Set(String(r['Gold values']).split(', ')), br = new Set(String(r['Branch values']).split(', '));
    const missing = [...gold].filter((v) => !br.has(v));
    lines.push(['Warning', `allowed values are missing: ${missing.join(', ')}`]);
    if (r._c?.Source) lines.push(['Where', r._c.Source]);
  }
  const w = Math.max(...lines.map(([k]) => k.length), 7);
  return [head, ...lines.map(([k, v]) => `    ${(k ? k + ':' : '').padEnd(w + 2)}${v}`)].join('\n');
}

export function developerMessages(rows, { branch, goldName, result, summary, maxWarnings = 20 }) {
  const fails = rows.filter((r) => r.Status === 'MISSING' || r.Status === 'BLOCKER');
  const warns = rows.filter((r) => r.Status === 'CONDITIONAL' || r.Status === 'DIFFERENT VALUES');
  const count = Object.fromEntries(summary.map((s) => [s.Status, s.Count]));
  const bar = '─'.repeat(100);

  // ── console ──
  const out = [bar, `VALIDATION GATE  ${branch}  vs gold ${goldName}  →  ${result}`, bar];
  if (fails.length) {
    out.push(`\n${fails.length} validation(s) must be fixed before this build can pass:\n`);
    fails.forEach((r, i) => out.push(`${i + 1}. ${describe(r)}\n`));
  }
  if (warns.length) {
    out.push(`${warns.length} warning(s) - the build still passes; please review:`);
    warns.slice(0, maxWarnings).forEach((r) => out.push(describe(r)));
    if (warns.length > maxWarnings) out.push(`  … ${warns.length - maxWarnings} more in the compare report`);
  }
  if (!fails.length && !warns.length) out.push('All gold validations are present and run as in the gold baseline.');
  out.push(`\nOK=${count.OK}  WAIVED=${count.WAIVED}  EXTRA (domain-specific)=${count.EXTRA}`);
  out.push(bar);

  // ── GitHub annotations (shown on the PR / run page; GitHub displays at most 10 errors per step) ──
  const annotations = [...fails, ...warns].map((r) => {
    const level = r.Status === 'MISSING' || r.Status === 'BLOCKER' ? 'error' : 'warning';
    const src = r.Status === 'MISSING' ? (r._g || {}) : (r._c || {});
    const file = r.Status === 'MISSING' ? (r.Layer === 'L1' ? 'config/validations/index.yaml' : null) : src._file;
    const line = r.Status === 'MISSING' ? null : src._line;
    const props = [file && `file=${ghProp(file)}`, line && `line=${line}`, `title=${ghProp(`${r.Status}: [${r.Layer}] ${r.API} › ${r.Field} › ${r.Check}`)}`].filter(Boolean).join(',');
    return `::${level} ${props}::${ghEscape(describe(r).split('\n').slice(1).map((l) => l.trim()).join('\n'))}`;
  });

  // ── markdown fix list (GitHub step summary + file) ──
  const md = [`## Validation gate: \`${branch}\` vs gold \`${goldName}\` - **${result}**`, '',
    `| MISSING | BLOCKER | CONDITIONAL | DIFFERENT VALUES | WAIVED | OK | EXTRA |`, `|---|---|---|---|---|---|---|`,
    `| ${count.MISSING} | ${count.BLOCKER} | ${count.CONDITIONAL} | ${count['DIFFERENT VALUES']} | ${count.WAIVED} | ${count.OK} | ${count.EXTRA} |`, ''];
  const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, '<br>');
  if (fails.length) {
    md.push(`### Must fix (${fails.length})`, '', '| # | Status | Layer | API | Field | Check | What is wrong | Fix here / example |', '|---|---|---|---|---|---|---|---|');
    fails.forEach((r, i) => md.push(`| ${i + 1} | ${r.Status} | ${r.Layer} | ${r.API} | \`${cell(r.Field)}\` | ${r.Check} | ${cell(r.Status === 'MISSING' ? `Missing: ${r._g?.Validation || ''}` : r['What to do'])} | ${cell(r.Status === 'MISSING' ? `Add to ${whereToAdd(r._g || r)}<br>Example: ${r._g?.Source || ''}<br>\`${r._g?.Code || ''}\`` : `${r._c?.Source || ''}<br>\`${r._c?.Code || ''}\``)} |`));
    md.push('', 'To accept an exception instead, add its **Key** to `config/validation-waivers.csv` with a reason and approver.', '');
  }
  if (warns.length) {
    md.push(`<details><summary>Warnings (${warns.length})</summary>`, '', '| Status | Layer | API | Field | Check | Detail | Where |', '|---|---|---|---|---|---|---|');
    warns.forEach((r) => md.push(`| ${r.Status} | ${r.Layer} | ${r.API} | \`${cell(r.Field)}\` | ${r.Check} | ${cell(r['What to do'])} | ${cell(r._c?.Source || '')} |`));
    md.push('', '</details>', '');
  }
  return { text: out.join('\n'), annotations, markdown: md.join('\n') };
}
