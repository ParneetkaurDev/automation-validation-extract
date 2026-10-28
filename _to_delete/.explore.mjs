import { execFileSync } from 'node:child_process'; import YAML from 'yaml';
const repo = process.env.HOME + '/spec-cache', ref = process.argv[2], file = process.argv[3];
const t = execFileSync('git', ['-C', repo, 'show', `${ref}:${file}`], { maxBuffer: 1 << 28 }).toString();
const d = YAML.parse(t); const dec = (s) => s ? Buffer.from(s, 'base64').toString() : '';
console.log('TOP', Object.keys(d), 'helper:', dec(d.helperLib).slice(0, 400));
for (const [i, s] of (d.steps || []).entries()) {
  const m = s.mock || {};
  console.log(`\n=== ${i} ${s.api} ${s.action_id} owner=${s.owner} resp=${s.responseFor} mockKeys=${Object.keys(m)}`);
  console.log('saveData', JSON.stringify(m.saveData));
  if (process.argv[4] == i || process.argv[4] === 'all') { console.log('--GEN\n' + dec(m.generate)); console.log('--REQ\n' + dec(m.requirements)); console.log('--VAL\n' + dec(m.validate).slice(0, 600)); console.log('--INPUTS', JSON.stringify(m.inputs)?.slice(0, 300)); }
}
