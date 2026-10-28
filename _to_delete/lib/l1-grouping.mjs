// L1 grouping analysis: reads config/validations/index.yaml (never changes it) and finds conditions/rules that could be
// grouped, plus business-logic differences and risks. Deterministic; every finding carries the YAML line numbers.
//
// Each rule/group becomes a record: api, name, line, parents, filters (action/domain/version), _SCOPE_, own condition
// (_CONTINUE_) and its CANONICAL form - variables replaced by their values, $.message. dropped, spacing removed - so two
// conditions are "the same" only when paths, operator, values and negation are all equal.
import { parseDocument, LineCounter, isMap, isSeq, isAlias, isScalar } from 'yaml';

const META = new Set(['_NAME_', '_RETURN_', '_CONTINUE_', '_DESCRIPTION_', '_SCOPE_', 'action', 'domain', 'version']);
const WORDS = new Set(['are', 'present', 'all', 'in', 'any', 'none', 'equal', 'to', 'follow', 'regex', 'not', 'unique', 'greater', 'less', 'than']);
export const normPath = (p) => String(p ?? '').trim().replace(/^\$\.message\./, '').replace(/^\$\./, '').replace(/\s+/g, '');
const isPath = (v) => typeof v === 'string' && /^\$\./.test(v.trim());
const valRepr = (v) => (Array.isArray(v) ? `[${v.map(String).sort().join(',')}]` : isPath(v) ? normPath(v) : JSON.stringify(v));
export function canon(expr, vars) {
  if (expr == null) return '';
  return String(expr).replace(/[A-Za-z_][\w]*/g, (w) => (WORDS.has(w) || !(w in vars) ? w : valRepr(vars[w])))
    .replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();
}
const API_ROOT = (api) => (/^search$/.test(api) ? ['intent', 'context'] : /^on_search$/.test(api) ? ['catalog', 'context'] : /issue/.test(api) ? ['issue', 'issue_id', 'context']
  : ['order', 'context', 'order_id', 'cancellation_reason_id', 'ref_id', 'descriptor', 'update_target', 'rating', 'ratings']);
const commonPrefix = (paths) => {
  const segs = paths.map(p => p.split('.')); if (!segs.length) return '';
  const out = []; for (let i = 0; ; i++) { const s = segs[0][i]; if (s === undefined || !segs.every(x => x[i] === s)) break; out.push(s); }
  return out.join('.');
};
const unfilter = (p) => String(p).replace(/\[\?\([^\]]*\)\]/g, '[*]');
const fullPath = (raw, scopes) => { const v = String(raw ?? '').trim(); const abs = /^\$\.message\./.test(v); const base = !abs && scopes?.length ? scopes.at(-1) : ''; return unfilter(base ? `${base}.${normPath(v)}` : normPath(v)); };
const rel = (p, pre) => (pre && p.startsWith(pre + '.') ? p.slice(pre.length + 1) : p);

export function analyseL1(text) {
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, uniqueKeys: false, maxAliasCount: -1, prettyErrors: false });
  const lineOf = (n) => (n?.range ? lc.linePos(n.range[0]).line : null);
  const der = (n) => (isAlias(n) ? n.resolve(doc) : n);
  const get = (m, k) => { const p = m.items.find(x => (isScalar(x.key) ? x.key.value : x.key) === k); return p ? der(p.value) : undefined; };
  const js = (n) => (n == null ? undefined : n.toJSON ? n.toJSON() : n);
  const nodes = new Map();   // line → record (a YAML node is recorded once, with every place it is used)
  const walk = (raw, ctx) => {
    const n = der(raw); if (!isMap(n)) return;
    const line = lineOf(n);
    const vars = {}; for (const p of n.items) { const k = isScalar(p.key) ? p.key.value : p.key; if (!META.has(k)) vars[k] = js(der(p.value)); }
    const filters = { ...ctx.filters }; for (const k of ['action', 'domain', 'version']) { const v = js(get(n, k)); if (v != null) filters[k] = [].concat(v).map(String).sort(); }
    const ret = get(n, '_RETURN_'); const contRaw = js(get(n, '_CONTINUE_')); const scope = js(get(n, '_SCOPE_'));
    // the field a rule checks = the path variables its _RETURN_ reads (attr, enumPath, … - any name)
    const retExpr = isSeq(ret) ? '' : String(js(ret) ?? '');
    const retPaths = [...new Set((retExpr.match(/[A-Za-z_][\w]*/g) || []).filter(w => isPath(vars[w])).map(w => normPath(vars[w])))];
    const attr = isPath(vars.attr) ? normPath(vars.attr) : (retPaths[0] || '');
    const attrRaw = isPath(vars.attr) ? vars.attr : (Object.entries(vars).find(([, v]) => isPath(v) && normPath(v) === attr)?.[1] ?? '');
    const cond = contRaw != null ? canon(contRaw, vars) : '';
    const selfGuard = [attr, ...retPaths].filter(Boolean).some(p => cond === `!(${p} are present)`);
    let rec = nodes.get(line);
    if (!rec) {
      const ownFilters = {}; for (const k of ['action', 'domain', 'version']) { const v = js(get(n, k)); if (v != null) ownFilters[k] = [].concat(v).map(String).sort(); }
      const keyLines = {}; for (const p of n.items) { const k = isScalar(p.key) ? p.key.value : p.key; keyLines[k] = lineOf(p.key); }
      rec = { line, endLine: n.range ? lc.linePos(n.range[1]).line : line, anchor: n.anchor || '', keyLines, retRaw: isSeq(ret) ? '' : String(js(ret) ?? ''), retAnchor: isSeq(ret) ? (ret.anchor || '') : '',
        ownFilters, attrRaw, name: js(get(n, '_NAME_')) || '', leaf: !isSeq(ret), attr, ret: isSeq(ret) ? '' : canon(js(ret), vars), contRaw: contRaw ?? '', cond, selfGuard, vars, scope: scope ? normPath(scope) : '',
        children: isSeq(ret) ? ret.items.map(x => lineOf(der(x))) : [], uses: [] };
      nodes.set(line, rec);
    }
    rec.uses.push({ api: ctx.api, parents: ctx.parents.map(p => p.line), parentNames: ctx.parents.map(p => p.name).join(' › '), viaAlias: ctx.viaAlias || isAlias(raw), filters, inherited: ctx.parents.map(p => p.cond).filter(Boolean), scopes: [...ctx.scopes, ...(scope ? [normPath(scope)] : [])] });
    if (isSeq(ret)) for (const x of ret.items) walk(x, { api: ctx.api, parents: [...ctx.parents, { line, name: rec.name, cond: rec.cond && !rec.selfGuard ? rec.cond : '' }], filters, viaAlias: ctx.viaAlias || isAlias(x), scopes: scope ? [...ctx.scopes, normPath(scope)] : ctx.scopes });
  };
  const tests = der(doc.get('_TESTS_', true));
  const topLists = [];   // each API's top-level list acts as a parent for detector 1
  if (isMap(tests)) for (const p of tests.items) { const list = der(p.value); const api = isScalar(p.key) ? p.key.value : String(p.key);
    if (isSeq(list)) { topLists.push({ name: `${api} (top level)`, line: lineOf(list), topOf: api, leaf: false, children: list.items.map(x => lineOf(der(x))), uses: [{ api }] });
      for (const x of list.items) walk(x, { api, parents: [], filters: {}, viaAlias: isAlias(x), scopes: [] }); } }
  const all = [...nodes.values()];
  const byLine = (l) => nodes.get(l);
  const apisOf = (r) => [...new Set(r.uses.map(u => u.api))];
  const leavesOf = (r) => (r.leaf ? [r] : r.children.flatMap(c => (byLine(c) ? leavesOf(byLine(c)) : [])));
  const findings = { opportunities: [], differences: [], risks: [], inventory: [] };
  const opp = (o) => findings.opportunities.push(o);

  // inventory: every _CONTINUE_
  for (const r of all) if (r.cond) findings.inventory.push({ line: r.line, name: r.name, kind: r.leaf ? 'rule' : `group (${leavesOf(r).length} rules)`, apis: apisOf(r).join(', '), condition: r.contRaw, canonical: r.cond, selfGuard: r.selfGuard ? 'yes' : '' });

  // 1. sibling rules repeating the same own condition (the same rules reused under several parents are reported once)
  const d1 = new Map();
  for (const p of [...all.filter(r => !r.leaf), ...topLists]) {
    const kids = p.children.map(byLine).filter(Boolean).filter(k => k.cond && !k.selfGuard);
    const by = new Map(); for (const k of kids) (by.get(k.cond) || by.set(k.cond, []).get(k.cond)).push(k);
    for (const [cond, ks] of by) if (ks.length >= 2) {
      const key = cond + '|' + ks.map(k => k.line).join(',');
      const e = d1.get(key) || d1.set(key, { cond, ks, parents: [] }).get(key); e.parents.push(p);
    }
  }
  for (const { cond, ks, parents } of d1.values()) {
    const sameFilters = new Set(ks.map(k => JSON.stringify(k.ownFilters))).size === 1;
    opp({ detector: '1 Repeated condition on siblings', area: areaOf(ks), condition: cond, rules: ks.map(k => k.name).join(', '), apis: [...new Set(parents.flatMap(apisOf))].join(', '), lines: ks.map(k => k.line).join(', '), parent: parents.map(p => `${p.name} (${p.line})`).join('; '),
      today: `${ks.length} sibling rules each declare the same _CONTINUE_${parents.length > 1 ? ` (the same rules sit under ${parents.length} parents)` : ''}`, suggestion: 'Put them under one sub-group with this _CONTINUE_ once',
      verdict: sameFilters ? 'Safe' : 'Needs decision', reason: sameFilters ? 'same condition; the rules declare no different action/domain/version filters of their own' : 'the rules declare different action/domain/version filters', key: `1|${cond}|${ks.map(k => k.name).sort().join(',')}`, _ctx: { ks, parents } });
  }
  // 2. same condition declared in many places
  const byCond = new Map(); for (const r of all) if (r.cond && !r.selfGuard) (byCond.get(r.cond) || byCond.set(r.cond, []).get(r.cond)).push(r);
  for (const [cond, rs] of byCond) if (rs.length >= 3) {
    const parents = new Set(rs.map(r => r.uses[0].parents.at(-1) ?? `top:${r.line}`));   // top-level groups of an API count as separate places
    if (parents.size < 2) continue;   // all under one parent → detector 1
    if ([...parents].every(p => String(p).startsWith('top:')) && new Set(rs.flatMap(apisOf)).size === 1) continue;   // all in one API's top list → detector 1
    opp({ detector: '2 Same condition in many places', area: areaOf(rs), condition: cond, rules: rs.map(r => r.name).join(', '), apis: [...new Set(rs.flatMap(apisOf))].join(', '), lines: rs.map(r => r.line).join(', '), parent: '',
      today: `declared ${rs.length} times (${parents.size} different parents)`, suggestion: 'Declare the condition path/values once as an anchor; per API, put the blocks that share it under one parent',
      verdict: 'Safe', reason: 'anchors only change how the YAML is written; grouping per API keeps the same condition on the same rules', key: `2|${cond}`, _ctx: { rs } });
  }
  // 3. child repeats an ancestor's condition
  for (const r of all) for (const u of r.uses.slice(0, 1)) {
    if (!r.cond) continue;
    const anc = u.parents.map(byLine).filter(Boolean).find(a => a.cond === r.cond);
    if (anc) opp({ detector: '3 Child repeats parent condition', area: areaOf([r]), condition: r.cond, rules: `${anc.name} › … › ${r.name}`, apis: apisOf(r).join(', '), lines: `${anc.line} (parent), ${r.line} (child)`, parent: anc.name,
      today: 'the child declares the condition its ancestor already applies', suggestion: 'Drop the child _CONTINUE_', verdict: 'Safe', reason: 'identical condition already inherited', key: `3|${r.cond}`, _ctx: { r, anc } });
  }
  // 4. copied blocks (same subtree at different lines, not reused through an alias)
  const sigMemo = new Map();
  const sig = (r) => { if (sigMemo.has(r.line)) return sigMemo.get(r.line); const s = JSON.stringify([r.cond, r.scope, r.attr, r.ret, r.children.map(c => (byLine(c) ? sig(byLine(c)) : c))]); sigMemo.set(r.line, s); return s; };
  const bySig = new Map(); for (const r of all) if (!r.leaf && leavesOf(r).length >= 2) (bySig.get(sig(r)) || bySig.set(sig(r), []).get(sig(r))).push(r);
  const reported = new Set();
  for (const rs of [...bySig.values()].filter(v => v.length >= 2).sort((a, b) => leavesOf(b[0]).length - leavesOf(a[0]).length)) {
    let fresh = rs.filter(r => !r.uses[0].parents.some(p => reported.has(p)));
    // same child YAML nodes (e.g. _RETURN_: *COMMON_CONTEXT) = already shared, not a copy
    const byKids = new Map(); for (const r of fresh) { const k = r.children.join(','); if (!byKids.has(k)) byKids.set(k, r); }
    fresh = [...byKids.values()];
    if (fresh.length < 2) continue;
    // ignore a parent and its only child holding the same rules
    if (fresh.length === 2 && (fresh[0].children.includes(fresh[1].line) || fresh[1].children.includes(fresh[0].line))) continue;
    fresh.forEach(r => reported.add(r.line));
    opp({ detector: '4 Copied block', area: areaOf(leavesOf(fresh[0])), condition: fresh[0].cond, rules: [...new Set(fresh.map(r => r.name))].join(' / '), apis: [...new Set(fresh.flatMap(apisOf))].join(', '), lines: fresh.map(r => r.line).join(', '), parent: '',
      today: `${leavesOf(fresh[0]).length} rules written ${fresh.length} times`, suggestion: 'Anchor the first copy (&NAME) and use an alias (*NAME) for the others',
      verdict: 'Safe', reason: 'identical content (conditions, scopes, paths, checks)', key: `4|${sig(fresh[0]).slice(0, 400)}`, _ctx: { fresh } });
  }
  // 5–9. category groups: a group whose condition tests one path against a literal list
  const cats = [];
  for (const r of all.filter(r => !r.leaf && r.cond)) {
    const m = /^(!?)\(([^\s()]+) (all in|any in|none in|equal to) \[([^\]]*)\]\)$/.exec(r.cond); if (!m) continue;   // one path, one operator, one literal list
    const leaves = leavesOf(r).filter(l => l.attr); if (!leaves.length) continue;
    const varName = (/\(\s*!?\s*\(?\s*([A-Za-z_]\w*)/.exec(r.contRaw) || [])[1] || '';
    const catPath = r.vars[varName] != null ? fullPath(r.vars[varName], r.uses[0].scopes) : unfilter(m[2]);
    const leafPaths = leaves.map(l => ({ l, p: fullPath(l.attrRaw, l.uses[0].scopes) }));
    const pre = commonPrefix([catPath, ...leafPaths.map(x => x.p)]);
    const leafByField = Object.fromEntries(leafPaths.map(x => [rel(x.p, pre) + ' ' + x.l.ret.replace(x.l.attr, 'attr'), x.l]));
    cats.push({ r, leafByField, neg: m[1], op: m[3], values: m[4], catRel: rel(catPath, pre), prefix: pre || '(none)', varName, fields: [...new Set(leafPaths.map(x => rel(x.p, pre) + ' ' + x.l.ret.replace(x.l.attr, 'attr')))].sort(), apis: apisOf(r) });
  }
  const famKey = (c) => c.catRel.replace(/\[[^\]]*\]/g, '');
  // 5. same field list behind different category values
  const byFields = new Map(); for (const c of cats) (byFields.get(c.fields.join('|')) || byFields.set(c.fields.join('|'), []).get(c.fields.join('|'))).push(c);
  for (const cs of byFields.values()) { const vals = [...new Set(cs.map(c => c.values))]; if (vals.length < 2 || cs[0].fields.length < 2) continue;
    opp({ detector: '5 Same field list for different values', area: 'Category groups', condition: `${famKey(cs[0])} in ${vals.map(v => `[${v}]`).join(' / ')}`, rules: cs.map(c => c.r.name).join(', '), apis: [...new Set(cs.flatMap(c => c.apis))].join(', '), lines: cs.map(c => c.r.line).join(', '), parent: '',
      today: `${cs.length} groups check the same ${cs[0].fields.length} fields for different values`, suggestion: 'Share one field list (anchor); keep one group per value, or one group with all values',
      verdict: 'Safe', reason: 'shared list: unchanged. One combined group: only for payloads that mix the values - decide separately', key: `5|${famKey(cs[0])}|${cs[0].fields.join('|')}`, _ctx: { cs } }); }
  // 6. same field rule repeated across category groups
  const byField = new Map(); for (const c of cats) for (const f of c.fields) (byField.get(f) || byField.set(f, new Map()).get(f)).set(c.values, c);
  for (const [f, m] of byField) if (m.size >= 3) { const cs = [...m.values()];
    opp({ detector: '6 Same field in many category groups', area: 'Category groups', condition: famKey(cs[0]), rules: f, apis: [...new Set(cs.flatMap(c => c.apis))].join(', '), lines: cs.map(c => c.r.line).join(', '), parent: '',
      today: `written in ${m.size} groups (values: ${[...m.keys()].join(' / ')})`, suggestion: 'One anchored rule reused in each group', verdict: 'Safe', reason: 'same path, same check', key: `6|${famKey(cs[0])}|${f}`, _ctx: { cs, f } }); }
  // 7. one category tested with different operators / variable names
  const byFam = new Map(); for (const c of cats) (byFam.get(famKey(c)) || byFam.set(famKey(c), []).get(famKey(c))).push(c);
  for (const [fam, cs] of byFam) { const ops = [...new Set(cs.map(c => c.op))], names = [...new Set(cs.map(c => c.varName))];
    if (ops.length > 1) findings.differences.push({ detector: '7 Operators differ', area: 'Category groups', what: `${fam} tested with ${ops.join(' / ')}`, lines: ops.map(o => `${o}: ${cs.filter(c => c.op === o).map(c => c.r.line).join(', ')}`).join('; '), detail: "all in = every element has the value; any in = at least one; equal to = compared with the list; none in = no element. Unify only after deciding the intent", key: `7|${fam}` });
    if (names.length > 1) findings.differences.push({ detector: '7 Variable names differ', area: 'Category groups', what: `${fam} held in ${names.length} variable names: ${names.join(', ')}`, lines: cs.map(c => c.r.line).join(', '), detail: 'Cosmetic - same path', key: `7n|${fam}` }); }
  // 8. same value, different payload (e.g. search intent vs on_search catalog): compare the field lists
  const byVal = new Map(); for (const c of cats) { const k = famKey(c) + '|' + c.neg + c.op + '|' + c.values; (byVal.get(k) || byVal.set(k, []).get(k)).push(c); }
  for (const [k, cs] of byVal) { const prefixes = [...new Set(cs.map(c => c.prefix))]; if (prefixes.length < 2) continue;
    const sets = cs.map(c => new Set(c.fields)); const same = cs.every(c => c.fields.join('|') === cs[0].fields.join('|'));
    if (same) opp({ detector: '8 Same list written per payload', area: 'Category groups', condition: `${famKey(cs[0])} in [${cs[0].values}]`, rules: cs.map(c => c.r.name).join(', '), apis: [...new Set(cs.flatMap(c => c.apis))].join(', '), lines: cs.map(c => c.r.line).join(', '), parent: '',
      today: `the same ${cs[0].fields.length} fields written for ${prefixes.join(' and ')}`, suggestion: `One list with relative paths; per API a group with _SCOPE_ on the items filtered by ${famKey(cs[0])}`,
      verdict: 'Needs decision', reason: `today the group runs when the ${cs[0].op} test holds for the whole array; a _SCOPE_ filter checks each matching item - same for one item, different for mixed items`, key: `8|${k}` });
    else { const base = (c) => c.fields.map(f => f.split(' ')[0].replace(/\.(value|type)$/, '')).sort().join('|');
      const props = cs.map(c => [...new Set(c.fields.map(f => (/\.(value|type) /.exec(f) || [])[1]).filter(Boolean))].join('/'));
      const sameNames = cs.every(c => base(c) === base(cs[0]));
      findings.differences.push({ detector: '8 Field lists differ per payload', area: 'Category groups', what: `${famKey(cs[0])} = [${cs[0].values}]: field lists differ between ${prefixes.join(' and ')}`, lines: cs.map(c => `${c.r.line} (${c.apis.join(',')})`).join('; '),
      detail: sameNames ? `same field names, but they check a different property: ${cs.map((c, i) => `${c.r.line} (${c.apis.join(',')}) checks .${props[i]}`).join('; ')} - e.g. on_search checks the form definition (.type), search the submitted data (.value): not the same validation`
        : cs.map((c, i) => { const others = sets.filter((_, j) => j !== i); const extra = c.fields.filter(f => others.every(o => !o.has(f))); return extra.length ? `only at ${c.r.line}: ${extra.map(f => f.split(' ')[0]).join(', ')}` : ''; }).filter(Boolean).join('; '), key: `8d|${k}` }); } }
  // 9. one category value handled by a condition in one place and a _SCOPE_ filter in another
  const scoped = []; for (const r of all) if (r.scope) for (const m of r.scope.matchAll(/\[\?\(@\.([\w.]+)\s*==\s*'([^']+)'\)\]/g)) scoped.push({ r, key: m[1], value: m[2] });
  const isUnder = (r, anc) => r.uses.some(u => u.parents.includes(anc.line)) || anc.uses.some(u => u.parents.includes(r.line));
  for (const s of scoped) {
    const base = unfilter(s.r.scope.slice(0, s.r.scope.indexOf('[?(')));   // the array the scope filters, e.g. order.payments[*]
    const sameArray = (cond) => (cond.match(/[\w\][*.]+\.[\w\][*.]+/g) || []).some(p => unfilter(p).startsWith(base) && p.endsWith(s.key));
    const others = all.filter(r => r !== s.r && r.cond && !r.selfGuard && r.cond.includes(s.value) && sameArray(r.cond) && !isUnder(r, s.r));
    if (!others.length) continue;
    findings.differences.push({ detector: '9 Two mechanisms for one value', area: areaOf([s.r]), what: `${s.key} = ${s.value}: _SCOPE_ filter at ${s.r.line} vs _CONTINUE_ condition at ${others.map(o => o.line).join(', ')}`, lines: [s.r.line, ...others.map(o => o.line)].join(', '),
      detail: 'A _SCOPE_ filter checks the matching element; a _CONTINUE_ on the whole array decides for all elements (e.g. "all in" skips when any other element exists). Group only after deciding which is intended', key: `9|${s.key}|${s.value}` }); }
  // 10. risks
  const anchors = new Map(); text.split('\n').forEach((l, i) => { for (const m of l.matchAll(/&([A-Za-z_][\w-]*)/g)) (anchors.get(m[1]) || anchors.set(m[1], []).get(m[1])).push(i + 1); });
  for (const [a, ls] of anchors) if (ls.length > 1) findings.risks.push({ detector: '10 Anchor declared more than once', what: `&${a}`, lines: ls.join(', '), detail: 'An alias binds to the latest declaration above it; moving a block can silently change what an alias points to', key: `10a|${a}` });
  for (const sc of all.filter(r => r.scope)) {
    const abs = leavesOf(sc).filter(l => /^\$\.message\./.test(String(l.attrRaw || '').trim()));
    if (abs.length) findings.risks.push({ detector: '10 Absolute paths inside _SCOPE_', what: `${sc.name} (_SCOPE_ ${sc.scope}): ${abs.length} rule(s) use absolute $.message paths`, lines: `${sc.line}; rules ${abs.map(l => l.line).join(', ')}`,
      detail: `${abs.some(l => /\[\?\(/.test(l.attrRaw)) ? 'the rules repeat the filter in their own path. ' : ''}Whether an absolute path is read from the payload root or from the scoped element depends on the engine - check that the scope applies as intended before grouping`, key: `10s|${sc.scope}|${abs.length}` });
  }
  const seenRoot = new Set();
  for (const r of all) for (const u of r.uses) for (const [k, v] of Object.entries(r.vars)) {
    if (!isPath(v) || !/^\$\.message\./.test(v.trim()) || u.scopes.length) continue;
    const root = normPath(v).split(/[.[]/)[0];
    const wrong = (root === 'catalog' && u.api !== 'on_search') || (root === 'intent' && u.api !== 'search') || (root === 'order' && /^(on_)?search$|issue/.test(u.api)) || (root === 'issue' && !/issue/.test(u.api));
    if (!wrong) continue;
    const id = `${r.line}|${u.api}|${k}`; if (seenRoot.has(id)) continue; seenRoot.add(id);
    findings.risks.push({ detector: '10 Path not in this API payload', what: `${u.api} › ${u.parentNames ? u.parentNames + ' › ' : ''}${r.name}: ${k} = ${normPath(v)}`, lines: String(r.line), detail: `${u.api} payloads have ${API_ROOT(u.api)[0]}, not ${root} - this ${k === 'attr' ? 'rule' : 'condition'} reads nothing`, key: `10r|${u.api}|${normPath(v)}` });
  }
  refine(findings.opportunities, { byLine, leavesOf, anchors, text });
  // 11. same rule (path + check) in several APIs with different conditions
  const byRule = new Map(); for (const r of all) if (r.leaf && r.attr) { const k = r.attr + ' ' + r.ret.replace(r.attr, 'attr'); (byRule.get(k) || byRule.set(k, []).get(k)).push(r); }
  for (const [k, rs] of byRule) {
    const variants = new Map();
    for (const r of rs) for (const u of r.uses) { const c = [...u.inherited, r.selfGuard ? '' : r.cond].filter(Boolean).join(' AND ') || '(always)'; (variants.get(c) || variants.set(c, new Set()).get(c)).add(`${u.api}@${r.line}`); }
    if (variants.size > 1) findings.differences.push({ detector: '11 Same rule, different conditions', area: areaOf(rs), what: `${k.split(' ')[0]} (${rs[0].ret.replace(rs[0].attr, 'attr')})`, lines: [...new Set(rs.map(r => r.line))].join(', '),
      detail: [...variants].map(([c, w]) => `${c} → ${[...w].join(', ')}`).join(' | '), key: `11|${k}` });
  }
  return { findings, stats: { nodes: all.length, rules: all.filter(r => r.leaf).length, conditions: findings.inventory.length } };
}
// ── stricter Safe check + "how to fix" remark and YAML example per opportunity (analysis only - nothing is applied) ──
function refine(opps, { byLine, leavesOf, anchors, text }) {
  const L = text.split('\n');
  // the rule exactly as written (anchors, aliases, quotes kept), as a list item at indent `ind`, without the lines in `drop`
  const raw = (r, ind, drop = []) => {
    const start = r.line; const dashLine = r.anchor && /^\s*-\s*&/.test(L[start - 2] || '') ? start - 1 : start;
    const d = L[dashLine - 1].search(/\S/);   // column of the list item's "-"
    let end = start; for (let i = start + 1; i <= L.length; i++) { const x = L[i - 1]; if (!x.trim() || /^\s*#/.test(x)) continue; if (x.search(/\S/) <= d) break; end = i; }
    const rows = []; for (let i = dashLine; i <= end; i++) { const x = L[i - 1]; if (drop.includes(i) || !x.trim() || /^\s*#/.test(x)) continue; rows.push(x); }
    return rows.map((x, i) => (i === 0 ? ind + x.slice(d) : ind + '  ' + x.slice(d + 2))).join('\n');
  };
  const taken = new Set(anchors.keys());
  const anchorName = (base) => { const a = String(base).toUpperCase().replace(/[^A-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'GROUP'; let b = a, i = 2; while (taken.has(b)) b = `${a}_${i++}`; taken.add(b); return b; };
  const pkey = (u) => u.parents.at(-1) ?? `top:${u.api}`;
  const parentKey = (p) => (p.topOf ? `top:${p.topOf}` : p.line);
  const yv = (v, ind) => (Array.isArray(v) ? '\n' + v.map(x => `${ind}  - ${x}`).join('\n') : ` ${v}`);
  const condVars = (r) => [...new Set((r.contRaw.match(/[A-Za-z_]\w*/g) || []).filter(w => w in r.vars && w !== 'attr' && !new RegExp(`\\b${w}\\b`).test(r.retRaw)))];
  const names = (r) => (r.leaf ? [r.name] : [r.name, ...r.children.map(byLine).filter(Boolean).flatMap(names)]);
  const ruleSig = (r) => JSON.stringify([r.name, r.cond, r.attr, r.ret, r.ownFilters, r.scope]);
  const tagOf = (r) => { const vals = condVars(r).map(w => r.vars[w]); const l = vals.find(Array.isArray); if (l?.length) return l.join('_'); const p = vals.find(x => typeof x === 'string'); return (p || 'COND').split('.').pop().replace(/\[.*$/, ''); };
  const ruleYaml = (r, ind, drop = []) => [`${ind}- ${r.anchor ? `&${r.anchor}\n${ind}  ` : ''}_NAME_: ${r.name}`, ...Object.entries(r.vars).filter(([k]) => !drop.includes(k)).map(([k, v]) => `${ind}  ${k}:${yv(v, ind + '  ')}`), `${ind}  _RETURN_: ${r.retRaw}`].join('\n');
  for (const o of opps) {
    const c = o._ctx; delete o._ctx; if (!c) continue;
    const no = (reason) => { o.verdict = 'Needs decision'; o.reason = reason; };
    if (o.detector.startsWith('1')) {
      const { ks, parents } = c; const keys = new Set(parents.map(parentKey));
      const alone = ks.flatMap(k => k.uses.filter(u => !keys.has(pkey(u))).map(u => `${k.name} in ${u.api}${u.parents.length ? ` (under line ${u.parents.at(-1)})` : ' (top level)'}`));
      if (o.verdict === 'Safe' && alone.length) no(`some rules are also used on their own elsewhere: ${[...new Set(alone)].slice(0, 4).join('; ')} - removing their own condition would change those uses`);
      const r0 = ks[0], cv = condVars(r0), grp = anchorName(`${parents[0].name.replace(/ \(top level\)$/, '')}_${tagOf(r0)}`);
      const delLines = ks.map(k => `${k.name}: ${[...cv.map(v => k.keyLines[v]), k.keyLines._CONTINUE_].filter(Boolean).join(', ')}`).join('; ');
      o.howToFix = [`1. In ${parents[0].name} (line ${parents[0].line}) add one group ${grp} that holds the condition once (${cv.join(', ')} and _CONTINUE_: '${r0.contRaw}').`,
        `2. Move ${ks.map(k => `${k.name} (line ${k.line})`).join(', ')} into its _RETURN_ list${ks.some(k => k.anchor) ? `, keeping their anchors (${ks.filter(k => k.anchor).map(k => '&' + k.anchor).join(', ')})` : ''}.`,
        `3. Delete each moved rule's own condition lines - ${delLines}.`,
        parents.length > 1 ? `4. Put the anchor &${grp} on the new group and, under ${parents.slice(1).map(p => `${p.name} (line ${p.line})`).join(', ')}, replace the ${ks.length} rule entries with "- *${grp}".` : ''].filter(Boolean).join('\n');
      const condText = [...cv.map(v => r0.keyLines[v]), r0.keyLines._CONTINUE_].filter(Boolean).flatMap(l => { const out = [L[l - 1]]; for (let i = l; i < L.length && /^\s+-\s/.test(L[i]) && L[i].match(/^\s*/)[0].length > L[l - 1].match(/^\s*/)[0].length; i++) out.push(L[i]); return out; });
      const ci = Math.min(...condText.map(x => x.match(/^\s*/)[0].length));
      const delOf = (k) => [...cv, '_CONTINUE_'].flatMap(v => { const l = k.keyLines[v]; if (!l) return []; const out = [l]; for (let i = l; i < L.length && /^\s+-\s/.test(L[i]) && L[i].match(/^\s*/)[0].length > L[l - 1].match(/^\s*/)[0].length; i++) out.push(i + 1); return out; });
      const short = (k) => { const t = raw(k, '    ', delOf(k)); if (k.leaf) return t; const rows = t.split('\n'); const i = rows.findIndex(x => /^\s{6}_RETURN_:/.test(x)); return i < 0 ? t : [...rows.slice(0, i + 1), '        - …  # rules unchanged'].join('\n'); };
      o.example = [`- &${grp}`, `  _NAME_: ${grp}`, ...condText.map(x => '  ' + x.slice(ci)), `  _RETURN_:`, ...ks.map(short)].join('\n');
    } else if (o.detector.startsWith('2')) {
      const { rs } = c; const first = [...rs].sort((a, b) => a.line - b.line)[0]; const cv = condVars(first);
      const anc = Object.fromEntries(cv.map(v => [v, anchorName(`${tagOf(first)}_${Array.isArray(first.vars[v]) ? 'LIST' : 'PATH'}`)]));
      o.howToFix = [`1. At the first place (${first.name}, line ${first.line}) put an anchor on each condition value: ${cv.map(v => `${v}: &${anc[v]} …`).join('; ')}.`,
        `2. At the other places (lines ${rs.filter(r => r !== first).map(r => r.line).join(', ')}) replace the same value with the alias (${cv.map(v => `*${anc[v]}`).join(', ')}); variable names there can stay.`,
        '3. The parsed YAML stays identical - the value is just maintained in one place.'].join('\n');
      o.example = [`# line ${first.line} (${first.name})`, ...cv.map(v => `${v}: &${anc[v]}${yv(first.vars[v], '')}`), `_CONTINUE_: '${first.contRaw}'`, '', '# every other place', ...cv.map(v => `${v}: *${anc[v]}`)].join('\n');
    } else if (o.detector.startsWith('3')) {
      const { r, anc } = c; const elsewhere = r.uses.filter(u => !u.parents.includes(anc.line));
      if (elsewhere.length) no(`${r.name} is also used outside ${anc.name} (${elsewhere.map(u => u.api).join(', ')}), where the parent condition does not apply`);
      const cv = condVars(r); const lines = [...cv.map(v => r.keyLines[v]), r.keyLines._CONTINUE_].filter(Boolean);
      o.howToFix = `Delete lines ${lines.join(', ')} in ${r.name} (${[...cv, '_CONTINUE_'].join(', ')}). Its parent ${anc.name} (line ${anc.line}) already skips with the same condition: '${anc.contRaw}'.`;
      o.example = raw(r, '', lines) + `\n# removed: _CONTINUE_: '${r.contRaw}'${cv.length ? ` and ${cv.join(', ')}` : ''}`;
    } else if (o.detector.startsWith('4')) {
      const { fresh } = c; const n0 = JSON.stringify(names(fresh[0]).slice(1));
      const diffNames = fresh.filter(f => JSON.stringify(names(f).slice(1)) !== n0);
      if (diffNames.length) no(`the rule names inside the blocks differ (lines ${diffNames.map(f => f.line).join(', ')}); sharing one block would change the names reported in errors`);
      const a = fresh[0].retAnchor || anchorName(`${fresh[0].name}_RULES`);
      o.howToFix = [`1. In ${fresh[0].name} (line ${fresh[0].line}) anchor its rule list: "_RETURN_: &${a}"${fresh[0].retAnchor ? ' (already there)' : ''}.`,
        `2. In ${fresh.slice(1).map(f => `${f.name} (lines ${f.line}-${f.endLine})`).join(', ')} keep _NAME_ and any action/domain/version filters, and replace the whole _RETURN_ list with "_RETURN_: *${a}".`,
        '3. Block names and filters stay as they are; only the identical rule list is shared.'].join('\n');
      o.example = [`- _NAME_: ${fresh[0].name}`, `  _RETURN_: &${a}`, '    - …  # rules unchanged', '', ...fresh.slice(1).map(f => `- _NAME_: ${f.name}\n  _RETURN_: *${a}`)].join('\n');
    } else if (o.detector.startsWith('5')) {
      const { cs } = c; const ln = (x) => JSON.stringify(leavesOf(x.r).map(l => l.name).sort());
      if (cs.some(x => ln(x) !== ln(cs[0]))) no(`same fields and checks, but the rule names differ (e.g. ${leavesOf(cs[0].r).map(l => l.name).slice(0, 2).join(', ')} vs ${leavesOf(cs[1].r).map(l => l.name).slice(0, 2).join(', ')}); sharing one list would change the names reported in errors`);
      const a = anchorName(`${cs[0].r.name}_RULES`);
      o.howToFix = [`1. In ${cs[0].r.name} (line ${cs[0].r.line}) anchor its rule list: "_RETURN_: &${a}".`,
        `2. In ${cs.slice(1).map(x => `${x.r.name} (line ${x.r.line})`).join(', ')} keep the group with its own condition and replace its _RETURN_ list with "_RETURN_: *${a}".`].join('\n');
      o.example = `- _NAME_: ${cs[0].r.name}\n  # condition unchanged\n  _RETURN_: &${a}\n    - …\n\n- _NAME_: ${cs[1].r.name}\n  # condition unchanged\n  _RETURN_: *${a}`;
    } else if (o.detector.startsWith('6')) {
      const { cs, f } = c; const rules = cs.map(x => x.leafByField[f]).filter(Boolean);
      if (new Set(rules.map(ruleSig)).size > 1) no(`the field is checked by rules with different names or details (${[...new Set(rules.map(r => r.name))].join(', ')}); one shared rule would change the names reported in errors`);
      const fp = f.split(' ')[0].split('.'); const a = rules[0].anchor || anchorName(`FORM_${fp.slice(-2).join('_')}`);
      o.howToFix = [`1. Anchor the rule at line ${rules[0].line} (${rules[0].name}): "- &${a}"${rules[0].anchor ? ' (already there)' : ''}.`,
        `2. In the other groups replace the identical rule (lines ${rules.slice(1).map(r => r.line).join(', ')}) with "- *${a}".`].join('\n');
      o.example = (rules[0].anchor ? raw(rules[0], '') : raw(rules[0], '').replace(/^- /, `- &${a}\n  `)) + `\n\n# in the other groups:\n- *${a}`;
    }
  }
}
function areaOf(rs) {
  const p = rs.map(r => r.attr || Object.values(r.vars).find(v => isPath(v)) || '').map(x => normPath(x)).join(' ');
  return /xinput|form/.test(p) ? 'Item › xinput form' : /fulfillment/.test(p) ? 'Fulfillment' : /payment/.test(p) ? 'Payments' : /items/.test(p) ? 'Item' : /tags/.test(p) ? 'Tags'
    : /issue/.test(p) ? 'IGM' : /context/.test(p) ? 'Context' : /quote/.test(p) ? 'Quote' : /provider/.test(p) ? 'Provider' : /document/.test(p) ? 'Documents' : /order/.test(p) ? 'Order' : 'Other';
}
