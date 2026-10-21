/**
 * runChecks - the shared runner for the L2 coding standard (see standard/L2_STANDARD.md).
 *
 * Self-contained, no imports: paste it once into the flow's helper library (or above `validate`)
 * and every validate/requirements function becomes a declarative list of checks:
 *
 *   function validate(targetPayload, sessionData) {
 *     return runChecks([
 *       { id: 'S02', desc: 'context.action must be on_select', path: '$.context.action', rule: { eq: 'on_select' } },
 *     ], targetPayload, sessionData);
 *   }
 *
 * Returns the runner contract: { valid, code, description } (+ failed: [ids]).
 */
function runChecks(checks, payload, session) {
  // ── tiny JSONPath subset: $.a.b, $.a[*].b, $.a[0].b, session:key.path ──
  function read(root, path) {
    var src = root, p = String(path);
    if (p.indexOf('session:') === 0) { src = session; p = '$.' + p.slice(8); }
    var parts = p.replace(/^\$\.?/, '').match(/[^.[\]]+|\[\*\]|\[\d+\]/g) || [];
    var nodes = [src];
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i], next = [];
      for (var j = 0; j < nodes.length; j++) {
        var n = nodes[j];
        if (n == null) continue;
        if (seg === '[*]') { if (Array.isArray(n)) next = next.concat(n); }
        else if (/^\[\d+\]$/.test(seg)) next.push(n[Number(seg.slice(1, -1))]);
        else next.push(n[seg]);
      }
      nodes = next;
    }
    return nodes;
  }
  var present = function (v) { return v !== undefined && v !== null && v !== ''; };
  var sessionValue = function (key) { var v = read(session, '$.' + key); return v.length ? v[0] : undefined; };

  function whenOk(w) {
    if (!w) return true;
    var list = Array.isArray(w) ? w : [w];
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c.session) { if (!present(sessionValue(c.session))) return false; continue; }
      var vals = read(payload, c.path).filter(present);
      if ('eq' in c) { if (!vals.some(function (v) { return v === c.eq; })) return false; }
      else if ('in' in c) { if (!vals.some(function (v) { return c.in.indexOf(v) >= 0; })) return false; }
      else if ('includes' in c) { if (!vals.some(function (v) { return Array.isArray(v) ? v.indexOf(c.includes) >= 0 : v === c.includes; })) return false; }
      else if (!vals.length) return false;
    }
    return true;
  }

  function pass(c) {
    if (typeof c.custom === 'function') return !!c.custom(payload, session);
    var vals = read(payload, c.path);
    var r = c.rule, k = typeof r === 'string' ? r : Object.keys(r || {})[0], arg = r && typeof r === 'object' ? r[k] : undefined;
    var all = function (fn) { return vals.length > 0 && vals.every(fn); };
    switch (k) {
      case 'required': return all(present);
      case 'nonEmpty': return all(function (v) { return Array.isArray(v) && v.length > 0; });
      case 'absent':   return vals.every(function (v) { return !present(v); });
      case 'eq':       return all(function (v) { return v === arg; });
      case 'in':       return all(function (v) { return arg.indexOf(v) >= 0; });
      case 'regex':    return all(function (v) { return new RegExp(arg).test(String(v)); });
      case 'contains': return [].concat.apply([], vals).indexOf(arg) >= 0;   // the values found at path (as a set) include arg
      case 'gte':      return all(function (v) { return Number(v) >= Number(arg); });
      case 'lte':      return all(function (v) { return Number(v) <= Number(arg); });
      case 'eqSession': { var s = sessionValue(arg); return all(function (v) { return v === s; }); }
      case 'eqPath':   { var o = read(payload, arg)[0]; return all(function (v) { return v === o; }); }
      case 'existsIn': {
        var pool = String(arg).indexOf('session:') === 0 ? read(session, '$.' + String(arg).slice(8)) : read(payload, arg);
        pool = [].concat.apply([], pool);
        return all(function (v) { return pool.indexOf(v) >= 0; });
      }
      default: throw new Error('unknown rule in check ' + c.id + ': ' + k);
    }
  }

  var failed = [];
  try {
    for (var i = 0; i < checks.length; i++) {
      var c = checks[i];
      if (!whenOk(c.when)) continue;
      if (!pass(c)) failed.push(c);
    }
  } catch (e) {
    return { valid: false, code: 500, description: 'validation error: ' + e.message };
  }
  if (!failed.length) return { valid: true, code: 200, description: 'Valid request' };
  return {
    valid: false, code: 400,
    description: failed.map(function (c) { return '[' + c.id + '] ' + c.desc; }).join('; '),
    failed: failed.map(function (c) { return c.id; }),
  };
}

if (typeof module !== 'undefined') module.exports = { runChecks: runChecks };
