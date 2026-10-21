// Registry of the L2 code patterns the analyser (lib/l2-analyse.mjs) understands - one place to see, document and
// test them. Every entry is checked by test/l2-patterns.test.mjs: its example must produce `expect` (the first check's
// "Type | field | values"). To support a new pattern: add the rule in l2-analyse.mjs AND an entry here.
//
//   group   failure = how the code says "invalid", runs = when the check runs, check = what the condition means
//   body    the inside of validate(targetPayload, sessionData); FAIL = a failing return, O = const order = …
export const FAIL = `return { valid: false, code: 400, description: 'x' };`;
export const O = `const order = targetPayload?.message?.order;`;
const ERR = `const errors = []; const pushError = (code, description) => { errors.push({ code, description }); };`;
const END = `return { valid: errors.length === 0, code: 400, description: JSON.stringify(errors) };`;

export const PATTERNS = [
  // ── failure points ──
  { id: 'F1', group: 'failure', name: 'return { valid: false }', body: `${O} if (!order.id) ${FAIL}`, expect: 'Required | order.id' },
  { id: 'F2', group: 'failure', name: 'reporter function (pushError) into an error list that decides valid', body: `${ERR} ${O} if (!order.id) pushError(400, 'x'); ${END}`, expect: 'Required | order.id', raw: true },
  { id: 'F3', group: 'failure', name: 'errors.push({ … }) into that list', body: `const errors = []; ${O} if (!order.id) errors.push({ code: 400, description: 'x' }); ${END}`, expect: 'Required | order.id', raw: true },
  { id: 'F4', group: 'failure', name: 'throw new Error inside try, catch returns valid:false', body: `try { ${O} if (!order.id) throw new Error('x'); } catch (e) { ${FAIL} } return { valid: true };`, expect: 'Required | order.id', raw: true },
  // ── run conditions ──
  { id: 'R1', group: 'runs', name: 'enclosing if', body: `${O} if (order.items.length > 0) { if (!order.items[0].id) ${FAIL} }`, expect: 'Required | order.items[0].id', when: 'Only when order.items has entries' },
  { id: 'R2', group: 'runs', name: 'earlier if (x) return { valid: true }', body: `${O} if (order.status === 'DRAFT') return { valid: true }; if (!order.id) ${FAIL}`, expect: 'Required | order.id', when: 'Only when order.status is not DRAFT' },
  { id: 'R3', group: 'runs', name: 'earlier if (x) continue; in the loop', body: `${O} for (const it of order.items) { if (!it.location_id) continue; if (it.location_id !== 'L1') ${FAIL} }`, expect: 'Expected value | order.items[].location_id | L1', when: 'Only when order.items[].location_id is sent' },
  { id: 'R4', group: 'runs', name: 'a && check (value from an earlier call must exist)', body: `${O} const exp = sessionData.order_id; if (exp && order.id !== exp) ${FAIL}`, expect: 'Matches | order.id | order_id from a previous call', when: 'Only when order_id from a previous call is available' },
  // ── what is checked ──
  { id: 'C1', group: 'check', name: '!x / x == null / typeof x === "undefined"', body: `${O} if (order.id == null) ${FAIL}`, expect: 'Required | order.id' },
  { id: 'C2', group: 'check', name: '!Array.isArray(x) || x.length === 0', body: `${O} if (!Array.isArray(order.items) || order.items.length === 0) ${FAIL}`, expect: 'Non-empty list | order.items' },
  { id: 'C3', group: 'check', name: 'x !== "V"', body: `${O} if (order.status !== 'ACTIVE') ${FAIL}`, expect: 'Expected value | order.status | ACTIVE' },
  { id: 'C4', group: 'check', name: '!["A","B"].includes(x) / x !== "A" && x !== "B"', body: `${O} if (!['A', 'B'].includes(order.status)) ${FAIL}`, expect: 'Allowed values | order.status | A,B' },
  { id: 'C5', group: 'check', name: 'x !== value from an earlier call', body: `${O} if (order.id !== sessionData.order_id) ${FAIL}`, expect: 'Matches | order.id | order_id from a previous call' },
  { id: 'C6', group: 'check', name: '!list.includes(x)', body: `${O} const ids = sessionData.item_ids; for (const it of order.items) { if (!ids.includes(it.id)) ${FAIL} }`, expect: 'Exists in | order.items[].id | item_ids from a previous call' },
  { id: 'C6b', group: 'check', name: '!new Set(list).has(x)', body: `${O} const ids = new Set(sessionData.item_ids); for (const it of order.items) { if (!ids.has(it.id)) ${FAIL} }`, expect: 'Exists in | order.items[].id | item_ids from a previous call' },
  { id: 'C7', group: 'check', name: '!x.some(i => i.k === "V")', body: `${O} if (!order.tags.some(t => t.code === 'X')) ${FAIL}`, expect: 'Must contain | order.tags[].code | X' },
  { id: 'C8', group: 'check', name: 'x.find(i => i.k === "V") then !found / found.f', body: `${O} const s = order.stops.find(x => x.type === 'START'); if (!s?.gps) ${FAIL}`, expect: 'Required | order.stops[type=START].gps' },
  { id: 'C9', group: 'check', name: 'loop flag: has = true inside the loop, if (!has)', body: `${O} let has = false; for (const s of order.stops) { if (s.type === 'START') has = true; } if (!has) ${FAIL}`, expect: 'Must contain | order.stops[].type | START' },
  { id: 'C10', group: 'check', name: 'loop over a literal list with .some() / .includes()', body: `${O} for (const t of ['A', 'B']) { if (!order.tags.some(g => g.code === t)) ${FAIL} }`, expect: 'Must contain | order.tags[].code | A,B' },
  { id: 'C11', group: 'check', name: 'table-driven [[value, label], …]; if (!c[0])', body: `${O} const checks = [[order.id, 'id']]; for (const c of checks) { if (!c[0]) ${FAIL} }`, expect: 'Required | order.id' },
  { id: 'C12', group: 'check', name: '!a && !b (different fields)', body: `${O} if (!order.a && !order.b) ${FAIL}`, expect: 'At least one of | order.a | order.a,order.b' },
  { id: 'C13', group: 'check', name: 'isNaN(Number(x))', body: `${O} if (isNaN(Number(order.price))) ${FAIL}`, expect: 'Data type | order.price | number' },
  { id: 'C14', group: 'check', name: '!/re/.test(x)', body: `${O} if (!/^[0-9]+$/.test(order.id)) ${FAIL}`, expect: 'Format | order.id | /^[0-9]+$/' },
  { id: 'C15', group: 'check', name: 'x < y (numbers / dates)', body: `${O} if (order.a < order.b) ${FAIL}`, expect: 'Comparison | order.a' },
  { id: 'C16', group: 'check', name: 'x !== undefined (must not be sent)', body: `${O} if (order.cancel !== undefined) ${FAIL}`, expect: 'Must be absent | order.cancel' },
  { id: 'S1', group: 'check', name: 'declarative standard: return runChecks([{ id, desc, path, rule, when }], …) - read exactly', body: `return runChecks([{ id: 'O04', desc: 'provider id', path: '$.message.order.provider.id', rule: 'required' }], targetPayload, sessionData);`, expect: 'Required | order.provider.id', raw: true },
];
