#!/usr/bin/env python3
"""domain-report.py - business-readable result of comparing ONE domain with a gold baseline.

Turns the output of `gold.mjs compare` into a workbook with tabs:
  Summary · Matching · Missing in <X> · Needs review · Extra in <X> · Gold

Usage (from validation-extract/):
  python3 domain-report.py --in out/run/report/validations.json \
      --gold out/run/gold/FIS12@2.3.0-common-for-SL.csv \
      --compare "out/run/compare/draft-FIS12SL-2.3.0_vs_FIS12@2.3.0-common-for-SL.csv.xlsx" \
      --branch draft-FIS12SL-2.3.0 --label SL \
      --out out/run/SL_vs_FIS12-2.3.0_common_validations.xlsx

Every number comes from the compare output; no AI, same input -> same output.
"""
import argparse, csv, json, collections
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter

ap = argparse.ArgumentParser()
ap.add_argument('--in', dest='inp', required=True, help='validations.json from extract-validations.mjs')
ap.add_argument('--gold', required=True, help='gold CSV from gold.mjs build-gold')
ap.add_argument('--compare', required=True, help='<branch>_vs_<gold>.xlsx from gold.mjs compare')
ap.add_argument('--branch', required=True, help='branch that was compared, e.g. draft-FIS12SL-2.3.0')
ap.add_argument('--label', default=None, help='short name used in tab titles, e.g. SL')
ap.add_argument('--out', required=True, help='output .xlsx')
a = ap.parse_args()
X = a.label or a.branch

if a.gold.endswith('.json'):   # common JSON from `gold.mjs partition`: { "L1": [...], "L2": [...] }
    _g = json.load(open(a.gold, encoding='utf-8'))
    gold = [{k: '' if v is None else str(v) for k, v in r.items()} for r in (_g if isinstance(_g, list) else _g.get('L1', []) + _g.get('L2', []))]
else:
    gold = list(csv.DictReader(open(a.gold, encoding='utf-8')))
built_from = []   # the branches the gold was built from, from gold/index.yaml next to the gold file
import os, re
idx = os.path.join(os.path.dirname(os.path.abspath(a.gold)), 'index.yaml')
if os.path.exists(idx):
    txt = open(idx, encoding='utf-8').read()
    for block in re.split(r'\n  - name:', txt):
        if re.search(r'file:\s*' + re.escape(os.path.basename(a.gold)) + r'\s*$', block, re.M):
            m = re.search(r'built_from:\s*\n((?:\s+- .+\n?)+)', block)
            if m: built_from = re.findall(r'- (\S+)', m.group(1))
data = json.load(open(a.inp, encoding='utf-8'))
# plain-English sentence for every key, from the extractor output
sentence = {}
for r in data['l1']:
    sentence.setdefault(('L1', r['branch'], r['api'], r['field'], r['ruleType']), r['validation'])
for r in data['l2']:
    sentence.setdefault(('L2', r['branch'], r['api'], r['field'], r['checkType']), r['validation'])
gold_sentence = {g['Key']: g.get('Validation', '') for g in gold}
l2_apis = {r['api'] for r in data['l2'] if r['branch'] == a.branch}   # APIs where the branch has real L2 checks

wbc = openpyxl.load_workbook(a.compare)
ws = wbc['Comparison']; hdr = [c.value for c in ws[1]]
rows = [dict(zip(hdr, [c.value if c.value is not None else '' for c in r])) for r in ws.iter_rows(min_row=2)]
ORDER = ['search', 'on_search', 'select', 'on_select', 'init', 'on_init', 'confirm', 'on_confirm', 'status', 'on_status',
         'update', 'on_update', 'cancel', 'on_cancel', 'dynamic_form', 'issue', 'on_issue', 'issue_status', 'on_issue_status']
rank = lambda api: ORDER.index(api) if api in ORDER else 99
rows.sort(key=lambda r: (rank(r['API']), r['Layer'], r['Field'], r['Check']))
runs = lambda s: str(s).split(' (')[0] if s else ''

def text(r):
    return gold_sentence.get(r['Key']) or sentence.get((r['Layer'], a.branch, r['API'], r['Field'], r['Check']), '')

match = [r for r in rows if r['Status'] == 'OK']
miss = [r for r in rows if r['Status'] == 'MISSING']
waived = [r for r in rows if r['Status'] == 'WAIVED']
review = [r for r in rows if r['Status'] in ('BLOCKER', 'CONDITIONAL', 'DIFFERENT VALUES')]
extra = [r for r in rows if r['Status'] == 'EXTRA']

def why_missing(r):
    if r['Layer'] == 'L2' and r['API'] not in l2_apis:
        return f'{X} has no checks for {r["API"]} (no such step, or its validate code is an empty pass-through stub)'
    if r['Layer'] == 'L2':
        return f'{X} has {r["API"]} checks, but not this one'
    return f'{X} has no rule for this field'
def detail(r):
    if r['Status'] == 'DIFFERENT VALUES':
        g = set(str(r['Gold values']).split(', ')); b = set(str(r['Branch values']).split(', '))
        return f"{X} does not accept: {', '.join(sorted(g - b)) or '-'}" + (f"; {X} adds: {', '.join(sorted(b - g))}" if b - g else '')
    return r['What to do']

NAVY = 'FF1F3A5F'
COL = {'Matching': 'FFE2F0D9', 'Missing': 'FFF8CBAD', 'Review': 'FFFFE699', 'Extra': 'FFDDEBF7', 'Waived': 'FFD9D9D9'}
W = {'Layer': 7, 'API': 15, 'Field': 42, 'Check': 16, 'Validation (plain English)': 55, 'Values': 30, 'Why missing': 48,
     'Suggested action': 45, 'Example in another domain': 60, 'Detail': 60, 'Where in ' + X: 50, 'Note': 40, 'Result': 16, 'Runs': 40}
wb = openpyxl.Workbook()

def sheet(name, cols, data, color):
    s = wb.create_sheet(name[:31]); s.append(cols)
    for c in s[1]:
        c.font = Font(bold=True, color='FFFFFFFF', name='Arial', size=10); c.fill = PatternFill('solid', fgColor=NAVY)
        c.alignment = Alignment(wrap_text=True, vertical='center')
    for d in data: s.append([d.get(c, '') for c in cols])
    for i, c in enumerate(cols, 1): s.column_dimensions[get_column_letter(i)].width = W.get(c, 15)
    for row in s.iter_rows(min_row=2):
        for c in row: c.alignment = Alignment(wrap_text=True, vertical='top'); c.font = Font(name='Arial', size=10)
        row[0].fill = PatternFill('solid', fgColor=color)
    s.freeze_panes = 'A2'
    if data: s.auto_filter.ref = f'A1:{get_column_letter(len(cols))}{len(data) + 1}'

sheet('Matching', ['Layer', 'API', 'Field', 'Check', 'Validation (plain English)', 'Values', 'Runs in gold', f'Runs in {X}'],
      [dict(r, **{'Validation (plain English)': text(r), 'Values': r['Gold values'], 'Runs in gold': runs(r['Gold runs']),
                  f'Runs in {X}': runs(r['Branch runs'])}) for r in match], COL['Matching'])
sheet(f'Missing in {X}', ['Layer', 'API', 'Field', 'Check', 'Validation (plain English)', 'Runs in gold', 'Why missing',
                          'Suggested action', 'Example in another domain'],
      [dict(r, **{'Validation (plain English)': text(r), 'Runs in gold': runs(r['Gold runs']), 'Why missing': why_missing(r),
                  'Suggested action': f'Add it to the {X} {r["API"]} step(s) - copy the example - or waive it with a reason',
                  'Example in another domain': r['Gold example']}) for r in miss], COL['Missing'])
sheet('Needs review', ['Result', 'Layer', 'API', 'Field', 'Check', 'Detail', 'Gold runs', f'{X} runs', 'Gold values',
                       f'{X} values', f'Where in {X}'],
      [dict(r, **{'Result': r['Status'], 'Detail': detail(r), 'Gold runs': r['Gold runs'], f'{X} runs': r['Branch runs'],
                  f'{X} values': r['Branch values'], f'Where in {X}': f"{r['Branch source']}\n{r['Branch code']}".strip()})
       for r in review], COL['Review'])
sheet(f'Extra in {X}', ['Layer', 'API', 'Field', 'Check', 'Validation (plain English)', 'Values', 'Runs', 'Note'],
      [dict(r, **{'Validation (plain English)': text(r), 'Values': r['Branch values'], 'Runs': r['Branch runs'],
                  'Note': f'{X}-specific - allowed (not in the common baseline)'}) for r in extra], COL['Extra'])
if waived:
    sheet('Waived', ['Layer', 'API', 'Field', 'Check', 'Detail'], [dict(r, Detail=r['What to do']) for r in waived], COL['Waived'])
sheet(f'Gold ({len(gold)} common)', ['Layer', 'API', 'Field', 'Check', 'Values', 'Runs', 'Validation'],
      sorted(gold, key=lambda g: (rank(g['API']), g['Layer'], g['Field'])), 'FFFFFFFF')

# ── Summary ──
s = wb.active; s.title = 'Summary'
n = lambda lst, layer=None: len([r for r in lst if layer is None or r['Layer'] == layer])
gl1 = sum(1 for g in gold if g['Layer'] == 'L1'); gl2 = len(gold) - gl1
cnt = collections.Counter(r['Status'] for r in review)
stub_missing = [r for r in miss if r['Layer'] == 'L2' and r['API'] not in l2_apis]
findings = [
    f"Field rules (L1): {n(match, 'L1')} of {gl1} common rules match; {n(miss, 'L1')} missing; {n(review, 'L1')} need review.",
    f"Flow code (L2): {n(match, 'L2')} of {gl2} common checks match; {n(miss, 'L2')} missing"
    + (f" ({len(stub_missing)} of them in APIs where {X} has no checks at all: "
       f"{', '.join(sorted({r['API'] for r in stub_missing}))})" if stub_missing else '') + '.',
    f"{cnt['BLOCKER']} BLOCKER(s): common checks {X} skips under an extra condition the gold does not have - fails the build."
    + (" APIs: " + ', '.join(sorted({r['API'] for r in review if r['Status'] == 'BLOCKER'})) if cnt['BLOCKER'] else ''),
    f"{cnt['CONDITIONAL']} check(s) run in fewer cases than the gold; {cnt['DIFFERENT VALUES']} accept different values.",
    f"{len(extra)} extra checks only in {X} ({n(extra, 'L2')} L2, {n(extra, 'L1')} L1) - allowed.",
]
lines = [
    [f'{a.branch} vs common validations'], [],
    ['Gold (common baseline)', f"{len(gold)} validations (L1: {gl1}, L2: {gl2})"
                               + (f", built from: {', '.join(built_from)}" if built_from else '')],
    ['Compared', a.branch], [],
    ['Result', 'Total', 'L1 (field rules)', 'L2 (flow code)', 'Meaning', 'Tab'],
    ['Matching', len(match), n(match, 'L1'), n(match, 'L2'), f'Common validation is in {X} and runs the same way', 'Matching'],
    [f'Missing in {X}', len(miss), n(miss, 'L1'), n(miss, 'L2'), f'Common validation not found in {X} - fails the build', f'Missing in {X}'],
    ['Needs review', len(review), n(review, 'L1'), n(review, 'L2'), 'BLOCKER (fails) / CONDITIONAL / DIFFERENT VALUES (warnings)', 'Needs review'],
    ['Waived', len(waived), n(waived, 'L1'), n(waived, 'L2'), 'Accepted exceptions from the waivers file', 'Waived'],
    [f'Extra in {X}', len(extra), n(extra, 'L1'), n(extra, 'L2'), f'Only in {X} (domain-specific) - allowed', f'Extra in {X}'],
    ['Gold total', len(match) + len(miss) + len(review) + len(waived), '', '', 'Matching + Missing + Needs review + Waived = gold size', ''],
    [], ['Key findings'], *[[str(i + 1), f] for i, f in enumerate(findings)],
]
for l in lines: s.append(l)
for row in s.iter_rows():
    for c in row: c.alignment = Alignment(wrap_text=True, vertical='top'); c.font = Font(name='Arial', size=10)
s['A1'].font = Font(bold=True, size=14, name='Arial')
for c in s[6]: c.font = Font(bold=True, color='FFFFFFFF', name='Arial'); c.fill = PatternFill('solid', fgColor=NAVY)
s['A14'].font = Font(bold=True, name='Arial')
for r, k in [(7, 'Matching'), (8, 'Missing'), (9, 'Review'), (10, 'Waived'), (11, 'Extra')]:
    s.cell(r, 1).fill = PatternFill('solid', fgColor=COL[k])
for col, w in zip('ABCDEF', [24, 12, 16, 16, 62, 18]): s.column_dimensions[col].width = w
for r in list(range(3, 5)) + list(range(15, 15 + len(findings))): s.merge_cells(start_row=r, start_column=2, end_row=r, end_column=6)
wb.save(a.out)

total = len(match) + len(miss) + len(review) + len(waived)
assert total == len(gold), f'check failed: {total} rows vs {len(gold)} gold validations'
print(f'{a.branch}: matching={len(match)} missing={len(miss)} review={len(review)} '
      f'(blocker={cnt["BLOCKER"]}) waived={len(waived)} extra={len(extra)} | gold={len(gold)} ✓ -> {a.out}')
