// L1 ↔ L2 comparison: for every L2 check, is the same validation already in L1 (config/validations/index.yaml)?
// Deterministic. Both sides are already reduced to { api, path, check, values, runs } by the extractors
// (L1: YAML tree + rule expression parser, L2: Babel syntax tree + lib/l2-analyse.mjs); this file only compares those records.
//
// Result labels (field "inL1") - plain words, the remark says what it means for this row:
//   Already in L1      L1 has exactly this check → the L2 copy can be removed
//   Covered by L1      L1 requires a field inside this object/list, so it cannot be missing → L2 copy can be removed
//   L2 is stricter     same check, but L2 accepts fewer values or checks in more cases → usually intended, keep
//   Conflicts with L1  L2 accepts a value L1 rejects → fix one of them
//   L2 adds a check    L1 checks the field, L2 checks something extra (e.g. same value as an earlier call) → keep
//   Only in L2         L1 has no rule for this field in this call → candidate to add to L1
//   Check manually     the tool could not read this L2 code → review by hand

export const L1_LABELS = ['Already in L1', 'Covered by L1', 'L2 is stricter', 'Conflicts with L1', 'L2 adds a check', 'Only in L2', 'Check manually'];
export const L1_LABEL_HELP = {
  'Already in L1': 'L1 already has exactly this check - the L2 copy can be removed',
  'Covered by L1': 'L1 already requires a field inside this object/list, so it can never be missing - the L2 copy can be removed',
  'L2 is stricter': 'Same check as L1, but L2 accepts fewer values or checks in more cases - usually on purpose, keep it',
  'Conflicts with L1': 'L2 accepts a value that L1 rejects - the two disagree, fix one of them',
  'L2 adds a check': 'L1 checks this field, L2 checks something extra (e.g. same value as an earlier call) - keep it',
  'Only in L2': 'L1 has no rule for this field in this call - consider adding it to L1',
  'Check manually': 'The tool could not read this L2 code - review it by hand',
};

// $.message.order.items[*].id / order.items[0].id / stops[type=START] / tags[?(@.descriptor.code=='X')] → order.items.id
export const normPath = (p) => String(p || '').trim().replace(/^\$\.?/, '').replace(/^message\./, '').replace(/\[[^\]]*\]/g, '').replace(/\.+/g, '.').replace(/\.$/, '').toLowerCase();
// filters on array elements: { 'descriptor.code': 'X' } from either notation
function filtersOf(p) {
  const f = {};
  for (const m of String(p || '').matchAll(/\[\?\(@\.([\w.]+)\s*==\s*['"]([^'"]*)['"]\)\]/g)) f[m[1].toLowerCase()] = m[2];   // L1 JSONPath
  for (const m of String(p || '').matchAll(/\[([\w.]+)=([^\]]*)\]/g)) f[m[1].toLowerCase()] = m[2];                          // L2 x[type=START]
  return f;
}
const filtersAgree = (a, b) => Object.keys(a).every(k => !(k in b) || a[k] === b[k]);
const splitValues = (v) => String(v || '').split('\n')[0].split(',').map(x => x.trim()).filter(Boolean);

// what an L1 rule checks, from its rule expression (ruleType merges all/any/none into "Allowed values")
function l1Ops(r) {
  const e = String(r.expression || '');
  return { required: /are present/.test(e), allIn: /all in/.test(e), anyIn: /any in/.test(e), noneIn: /none in/.test(e),
    absent: /are not present/.test(e), regex: /follow regex/.test(e), equalTo: /equal to/.test(e), compare: /greater than|less than/.test(e) };
}
const l1Runs = (r) => (r.runClass === 'Always runs' ? 'Always' : String(r.runClass).startsWith('Optional') ? 'If present' : 'Conditional');
const ref = (r) => `${r.ruleName}, line ${r.line}`;
const refs = (rs) => [...new Map(rs.map(r => [ref(r), r])).values()].slice(0, 2).map(ref).join('; ') + (rs.length > 2 ? ` +${rs.length - 2} more` : '');
const tag = (rs) => ` [L1: ${refs(rs)}]`;
const short = (s, n = 110) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const list = (v) => (v.length > 6 ? `${v.slice(0, 6).join(', ')} … (${v.length} values)` : v.join(', '));
// L1 skip text → "when …" in plain words ("Skipped when X is absent" → "when X is sent")
function plainWhen(when) {
  const parts = String(when || '').split('; ').map(p => p.replace(/^Skipped when /, '').replace(/ \(inherited from [^)]*\)/, '').trim()).filter(p => p && p !== 'Always');
  const one = (p) => {
    let m;
    if ((m = /^(.+?) is absent$/.exec(p))) return `${m[1].split('/').join(' / ')} is sent`;
    if ((m = /^(.+?) is present$/.exec(p))) return `${m[1]} is not sent`;
    if ((m = /^every value of (.+?) is NOT one of \[(.+)\]$/.exec(p))) return `${m[1]} is ${m[2].split(', ').join(' or ')}`;
    if ((m = /^every value of (.+?) is one of \[(.+)\]$/.exec(p))) return `${m[1]} is not ${m[2].split(', ').join(' or ')}`;
    return `not: ${p}`;
  };
  if (!parts.length) return '';
  return short(`when ${one(parts[0])}${parts.length > 1 ? ` (+${parts.length - 1} more condition${parts.length > 2 ? 's' : ''})` : ''}`, 120);
}
// "x from previous call on_search" → "the value sent earlier in on_search"
const earlier = (cw) => { const m = /from previous call (\S+)$/.exec(cw || ''); return m ? `the value sent earlier in ${m[1]}` : /previous call|user input/.test(cw || '') ? 'a value from an earlier call' : (cw || 'another field'); };

function setCompare(l2, l1) {   // 'equal' | 'subset' (L2 narrower) | 'outside' (L2 has values L1 rejects)
  const A = new Set(l2), B = new Set(l1);
  const out = [...A].filter(x => !B.has(x));
  if (out.length) return { rel: 'outside', out };
  return { rel: A.size === B.size ? 'equal' : 'subset' };
}

export function indexL1(l1rows) {
  const byApiPath = new Map(), byPath = new Map();
  for (const r of l1rows) {
    if (!r.jsonPath) continue;
    const n = normPath(r.jsonPath);
    const k = `${r.api}|${n}`;
    (byApiPath.get(k) || byApiPath.set(k, []).get(k)).push(r);
    (byPath.get(n) || byPath.set(n, []).get(n)).push(r);
  }
  return { byApiPath, byPath, all: l1rows };
}

export function compareCheck(c, idx) {
  // exact = L1 has exactly the same validation (same field, same check, same values, same conditions, nothing more) → "Duplicate"
  const res = (inL1, l1Remark, rules = [], exact = false) => ({ inL1, l1Remark, l1Rules: rules.map(ref).join('; '), exact });
  const onlyOne = (r) => Object.values(l1Ops(r)).filter(Boolean).length === 1;   // the L1 rule does just this one check
  if (c.checkType === 'Custom logic') return res('Check manually', 'This L2 code does not follow a known pattern, so the tool cannot tell what it checks. Please review it by hand.');
  if (!c.field || c.fieldRoot === 'var') return res('Check manually', `The tool could not tell which payload field this L2 code checks ("${c.field}" is a variable in the code). Please review it by hand.`);
  if (c.fieldRoot === 'session') return res('Only in L2', 'L2 checks data saved from an earlier call. L1 only looks at the current payload, so it cannot do this. Keep it.');

  const n = normPath(c.field), f2 = filtersOf(c.field);
  const cands = (idx.byApiPath.get(`${c.api}|${n}`) || []).filter(r => filtersAgree(filtersOf(r.jsonPath), f2));
  const l2Cond = !!c.onlyWhen;
  const t = c.checkType, v2 = splitValues(c.values);
  const pick = (pred) => cands.filter(r => pred(l1Ops(r)));

  // same check in both: who checks in more cases?
  const byRuns = (r, what, sameValues = true) => {
    const l1 = l1Runs(r);
    const diff = [!sameValues && 'the values differ', !onlyOne(r) && `the L1 rule also checks more (${r.expression})`].filter(Boolean);
    // a difference in the check itself (values, L1 rule does more) → not a duplicate;
    // only a difference in WHEN it runs (L1 conditional / optional, or L2 conditional) → still a Duplicate: L1 has the check
    if (diff.length) return res('Already in L1', `L1 already checks that ${what}, but ${diff.join(' and ')} - not exactly the same.${tag([r])}`, [r]);
    if (l1 === 'Always' && l2Cond) return res('Already in L1', `L1 always checks that ${what}; L2 checks it only ${short(c.onlyWhen, 80)}. Duplicate - L1 already covers it.${tag([r])}`, [r], true);
    if (l1 === 'Always') return res('Already in L1', `L1 already checks that ${what}. This L2 check can be removed.${tag([r])}`, [r], true);
    const l1When = l1 === 'If present' ? 'when the field is sent' : (plainWhen(r.when) || 'in some cases');
    if (!l2Cond && l1 === 'If present' && /is sent$/.test(what)) return res('L2 is stricter', `Duplicate - L1 has this check, conditionally: L1 treats ${c.field} as optional, L2 makes it mandatory in this flow step.${tag([r])}`, [r], true);
    if (!l2Cond) return res('L2 is stricter', `Duplicate - L1 has this check, conditionally: both check that ${what}, L1 only ${l1When}, L2 always.${tag([r])}`, [r], true);
    return res('Already in L1', `Duplicate - L1 has this check, conditionally: both check that ${what} only in some cases (L1 ${l1When}; L2 ${short(c.onlyWhen, 80)}) - make sure the conditions match.${tag([r])}`, [r], true);
  };

  if (t === 'At least one of') {   // L2: at least one of a, b is sent - covered when L1 always requires one of them
    const req = v2.flatMap(a => (idx.byApiPath.get(`${c.api}|${normPath(a)}`) || []).filter(r => l1Ops(r).required && l1Runs(r) === 'Always'));
    if (req.length) return res('Covered by L1', `L1 always requires ${req[0].field}, so at least one of ${v2.join(', ')} is always sent. This L2 check can be removed.${tag(req)}`, req.slice(0, 3));
    return res('Only in L2', `L1 has no rule that requires any of ${v2.join(', ')} in ${c.api}. Consider adding it to L1 if it applies to every flow.`);
  }

  if (t === 'Required' || t === 'Non-empty list') {
    const child = [...idx.byApiPath.entries()].filter(([k]) => k.startsWith(`${c.api}|${n}.`)).flatMap(([, rs]) => rs)
      .filter(r => l1Ops(r).required && l1Runs(r) === 'Always' && filtersAgree(filtersOf(r.jsonPath), f2));
    const same = pick(o => o.required);
    if (t === 'Required' && same.length) return byRuns(same.sort((a, b) => (l1Runs(a) === 'Always' ? 0 : 1) - (l1Runs(b) === 'Always' ? 0 : 1))[0], `${c.field} is sent`);
    if (child.length) return res('Covered by L1', `L1 always requires ${child[0].field}${child.length > 1 ? ` (and ${child.length - 1} other field${child.length > 2 ? 's' : ''})` : ''} inside ${c.field}, so ${c.field} can never be ${t === 'Required' ? 'missing' : 'missing or empty'}. This L2 check can be removed.${tag(child)}`, child.slice(0, 3));
    if (same.length) return res('L2 is stricter', `L1 only checks that ${c.field} is sent. L2 also checks it has at least one entry.${tag(same)}`, same);
  }

  if (t === 'Allowed values' || t === 'Expected value') {
    const lists = pick(o => o.allIn);
    if (lists.length) {
      const r = lists[0], v1 = splitValues(r.values), cmp = setCompare(v2, v1);
      if (cmp.rel === 'outside') return res('Conflicts with L1', `L2 accepts ${cmp.out.join(', ')}, but L1 only allows ${list(v1)}. A payload with ${cmp.out[0]} passes L2 but fails L1 - fix one of them.${tag([r])}`, [r]);
      if (cmp.rel === 'subset') return res('L2 is stricter', `L1 allows ${list(v1)}. In this flow step L2 accepts only ${v2.join(', ')}. Usually on purpose - keep it.${l1Runs(r) === 'Always' ? '' : ` (L1 checks it only ${plainWhen(r.when) || 'when the field is sent'}.)`}${tag([r])}`, [r]);
      return byRuns(r, `${c.field} is one of ${list(v1)}`);
    }
  }

  if (t === 'Must contain') {
    const any = pick(o => o.anyIn);
    if (any.length) {
      const r = any[0], v1 = splitValues(r.values);
      if (v2.every(x => v1.includes(x)) && v1.length === v2.length && v2.length === 1) return byRuns(r, `${c.field} contains ${v2[0]}`);
      if (v2.every(x => v1.includes(x))) return res('L2 is stricter', `L1 needs at least one of ${list(v1)}. L2 needs ${v2.join(' and ')}.${tag([r])}`, [r]);
    }
  }
  if (t === 'Must be absent') { const r = pick(o => o.absent)[0]; if (r) return byRuns(r, `${c.field} is not sent`); }
  if (t === 'Must not be value') { const r = pick(o => o.noneIn)[0]; if (r && v2.every(x => splitValues(r.values).includes(x))) return byRuns(r, `${c.field} is not ${v2.join(', ')}`, splitValues(r.values).length === v2.length); }
  if (t === 'Format') {
    const r = pick(o => o.regex)[0];
    const re2 = String(c.values).replace(/^\/|\/[a-z]*$/g, '');
    if (r && String(r.values).includes(re2)) return byRuns(r, `${c.field} has the right format`, String(r.values).replace(/^\/|\/[a-z]*$/g, '').trim() === re2.trim());
  }

  if (cands.length) {
    const l1what = [...new Set(cands.map(r => r.ruleType.replace('Required', 'is sent').replace('Allowed values', 'has an allowed value').replace('Format', 'has the right format')))].join(', ').replace(/ \+ /g, ', ');
    const extra = ['Matches', 'Exists in'].includes(t) ? (t === 'Matches' ? `matches ${earlier(c.comparedWith)}` : `is one of the values in ${earlier(c.comparedWith)}`)
      : t === 'Comparison' ? 'passes a number/date comparison'
      : t === 'Data type' ? `is a valid ${c.values}`
      : ['Allowed values', 'Expected value'].includes(t) ? `is ${v2.join(' or ')}`
      : t === 'Must contain' ? `contains ${v2.join(' and ')}`
      : t === 'Non-empty list' ? 'has at least one entry'
      : `passes a "${t}" check`;
    return res('L2 adds a check', `L1 checks that ${c.field} ${l1what}. L2 also checks that it ${extra}. Keep it.${tag(cands)}`, cands.slice(0, 3));
  }
  const other = [...new Set((idx.byPath.get(n) || []).map(r => r.api))].filter(a => a !== c.api);
  const inside = [...idx.byApiPath.entries()].filter(([k]) => k.startsWith(`${c.api}|${n}.`)).flatMap(([, rs]) => rs);
  const why = other.length ? `L1 has no rule for ${c.field} in ${c.api} (it checks it in ${other.slice(0, 4).join(', ')}${other.length > 4 ? ` +${other.length - 4} more` : ''}).`
    : `L1 has no rule for ${c.field} in any call.`;
  const ins = !other.length && inside.length ? ` L1 does check ${new Set(inside.map(r => r.field)).size} field(s) inside it, e.g. ${inside[0].field}.` : '';
  return res('Only in L2', `${why}${ins} Consider adding it to L1 if it applies to every flow.`);
}

// What the workbook shows in "In L1?": only two values.
//   Duplicate - L1 has the same validation: same field, same check, same values and the L1 rule does nothing more.
//               It also counts when only the condition differs (L1 runs it conditionally / only when the field is sent,
//               or L2 runs it conditionally) - L1 has the check, so the L2 copy duplicates it
//   -         - anything else, including any difference in the check (stricter / other values, conflicts, covered by a
//               child field, L1 rule checks more, Only in L2, L2 adds a check, Check manually);
//               the remark says what L1 has and what differs
// The detailed label is kept in validations.json as "l1Detail".
export const DUPLICATE_LABELS = new Set(['Already in L1', 'Covered by L1', 'L2 is stricter', 'Conflicts with L1']);
export const IN_L1_VALUES = ['Duplicate', '-'];
export const IN_L1_HELP = {
  Duplicate: 'L1 has the same validation (same field, check and values) - also when L1 runs it only conditionally; the remark says the L1 rule and any condition difference',
  '-': 'not in L1, or the check itself differs (other values, L1 rule checks more, covered by another field) - the remark says what differs',
};
export function annotateL2(l1rows, checks) {
  const idx = indexL1(l1rows);
  for (const c of checks) {
    const r = compareCheck(c, idx);
    Object.assign(c, { inL1: r.exact ? 'Duplicate' : '-', l1Detail: r.inL1, l1Remark: r.l1Remark, l1Rules: r.l1Rules });
  }
  return checks;
}
