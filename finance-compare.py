#!/usr/bin/env python3
"""finance-compare.py — business-readable comparison of finance branches against the common validations.

Usage (from validation-extract/):
  node extract-validations.mjs --repo ../automation-specifications --ref origin/<branch> ... --out out/fis --json-only
  node gold.mjs simplify --in out/fis/validations.json --out out/simple
  node cc_dump.mjs out/fis/validations.json out/cc.json
  python3 finance-compare.py [out-file.xlsx]
Rows come from standard/finance-common-validations.json; branches from the BR list below.
"""
import csv, json, re, collections, os, sys
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.formatting.rule import FormulaRule
from openpyxl.utils import get_column_letter as L

G=os.path.dirname(os.path.abspath(__file__))
_STD=json.load(open(f'{G}/standard/finance-common-validations.json'))
DOC={'payloads':_STD['payloads']}
XF={x['id']:x for x in _STD['crosscall']}
CC=json.load(open(f'{G}/out/cc.json'))
BR=[('draft-FIS10-GIFTCARD-2.1.0','FIS10','Gift card 2.1.0'),('draft-FIS11-2.0.0','FIS11','FIS11 2.0.0'),
    ('draft-FIS12-PL-2.0.1','FIS12 Lending','PL 2.0.1'),('draft-FIS12-GD-2.0.2','FIS12 Lending','GD 2.0.2'),('draft-FIS12-2.0.3','FIS12 Lending','2.0.3'),
    ('draft-FIS12-PF-2.2.1','FIS12 Lending','PF 2.2.1'),('draft-FIS12-2.3.0','FIS12 Lending','2.3.0'),('draft-FIS12-PF-2.3.0','FIS12 Lending','PF 2.3.0'),
    ('draft-FIS12BL-2.3.0','FIS12 Lending','BL 2.3.0'),('draft-FIS12SL-2.3.0','FIS12 Lending','SL 2.3.0'),
    ('draft-FIS13-HEALTH-2.0.0','FIS13 Insurance','Health 2.0.0'),('draft-FIS13-HEALTH-2.0.1','FIS13 Insurance','Health 2.0.1'),('draft-FIS13-sachet','FIS13 Insurance','Sachet 2.0.0'),
    ('draft-FIS14-2.1.0','FIS14 Investments','MF 2.1.0')]
rows={b:list(csv.DictReader(open(f'{G}/out/simple/{b}_validations.csv'))) for b,_,_ in BR}
apis={b:{r['API'] for r in rows[b]} | set(CC['l2apis'].get(b,[])) for b,_,_ in BR}
l2apis={b:set(CC['l2apis'].get(b,[])) for b,_,_ in BR}

def nf(s): return re.sub(r'\[[^\]]*=[^\]]*\]','[]',s.replace('[*]','[]'))
RANK={'Always':3,'If present':2}
def runrank(r): return RANK.get(r['Runs'],1)
def area(f):
    for rx,a in [(r'issue',"Issue (IGM)"),(r'xinput','Forms'),(r'\.list\[|tags','Tags'),(r'quote','Quote'),(r'payments','Payments'),(r'fulfillments','Fulfillments'),
                 (r'documents','Documents'),(r'items','Items'),(r'provider','Provider'),(r'catalog','Catalog'),(r'intent','Search intent'),(r'order','Order')]:
        if re.search(rx,f): return a
    return 'Other'

ABS='– N/A'; MISS='✗ Missing'
# ---------- L1 ----------
def l1_status(b, api, field, rule):
    need_req='required' in rule.lower(); need_val=bool(re.search(r'values must|tag codes must',rule,re.I))
    tag_list = field.startswith('tags[*].list')
    target=nf(field)
    cand=[r for r in rows[b] if r['Layer']=='L1' and r['API']==api and (nf(r['Field']).endswith('tags[].list[].descriptor.code') if tag_list else nf(r['Field'])==target)]
    if api not in apis[b]: return ABS, ''
    req=[r for r in cand if 'Required' in r['Check']]; val=[r for r in cand if 'Allowed values' in r['Check']]
    have_req=bool(req) or not need_req; have_val=bool(val) or not need_val
    if not req and not val: return MISS, ''
    if not (have_req and have_val): return '◐ Partial', 'required check missing' if not have_req else 'allowed-values check missing'
    key = max(req, key=runrank) if need_req else max(val, key=runrank)
    note = key['Runs'] if key['Runs'] not in ('Always',) else ''
    if key['Runs']=='Always': return '✓ Always',''
    if key['Runs']=='If present': return ('⚠ Optional','checked only when the field is sent') if need_req else ('✓ If sent','')
    return '⚠ Conditional', key['Runs'].replace('Conditional (','').rstrip(')')
# ---------- L2 ----------
def L2rows(b,api): return [r for r in rows[b] if r['Layer']=='L2' and r['API']==api]
M={
 'message.order is present': lambda rs:[r for r in rs if r['Check'] in('Required','Non-empty list') and (r['Field']=='order' or r['Field'].startswith('order.') or r['Field'].startswith('order['))],
 'order.provider.id is present': lambda rs:[r for r in rs if r['Check']=='Required' and re.fullmatch(r'order\.provider\.id',r['Field'])],
 'order.items is present and each item has an id': lambda rs:[r for r in rs if r['Check'] in('Required','Non-empty list') and re.fullmatch(r'order\.items(\[\d*\])?(\.id)?',r['Field'])],
 'Selected item id exists in the on_search catalog': lambda rs:[r for r in rs if r['Check'] in('Exists in','Matches') and re.search(r'item',r['Field']+r['Validation'],re.I) and re.search(r'catalog|on_search|session',r['Validation'],re.I)],
 'order.id is present': lambda rs:[r for r in rs if r['Check']=='Required' and r['Field']=='order.id'],
 'message.issue is present': lambda rs:[r for r in rs if r['Check'] in('Required','Non-empty list') and re.match(r'issue($|[.\[])',r['Field'])],
 'issue.id is present': lambda rs:[r for r in rs if r['Check']=='Required' and r['Field']=='issue.id'],
 'issue.created_at and issue.updated_at are present': lambda rs:[r for r in rs if r['Check']=='Required' and re.fullmatch(r'issue\.(created_at|updated_at)',r['Field'])],
 'issue refs ORDER ref_id equals the order_id from the confirmed order': lambda rs:[r for r in rs if r['Check']=='Matches' and 'ref_id' in r['Field']],
 'issue actions are present (incl. the expected respondent action)': lambda rs:[r for r in rs if re.search(r'issue\.(issue_)?actions|respondent_action',r['Field'])],
 'issue.status matches the issue action (OPEN / CLOSED / RESOLVED / PROCESSING)': lambda rs:[r for r in rs if r['Check'] in('Expected value','Allowed values') and r['Field']=='issue.status'],
 'resolution, resolution_provider and respondent_info are present': lambda rs:[r for r in rs if re.search(r'issue\.(resolution|resolution_provider|respondent_info)',r['Field'])],
}
def l2_status(b, api, check):
    if api not in l2apis[b]: return ABS,''
    hit=M[check](L2rows(b,api))
    if not hit: return MISS,''
    best=max(hit,key=runrank)
    return ('✓ Always','') if best['Runs'] in('Always','If present') else ('⚠ Conditional', best['Runs'].replace('Conditional (','').rstrip(')'))
# ---------- build data ----------
L1T=[];L2T=[];XT=[]
for o in DOC['payloads']:
    api=o['api']
    for f,rule in o['l1']:
        st=[l1_status(b,api,f,rule) for b,_,_ in BR]
        L1T.append(dict(api=api,area=area(f),field=f.replace('[*]','[]'),rule=rule,st=st))
    for chk,msg in o['l2']:
        st=[l2_status(b,api,chk) for b,_,_ in BR]
        L2T.append(dict(api=api,area=area(chk),field='',rule=chk,st=st))
for c in CC['catalog']:
    x=XF.get(c['id'],{}); applies=set(x.get('apis',[]))
    st=[]
    for b,_,_ in BR:
        cov=CC['cover'].get(b,{}).get(c['id'])
        if cov: st.append(('✓ Checked','in '+', '.join(sorted(cov))))
        elif not (applies & apis[b]) or not l2apis[b]: st.append((ABS,'no L2 code for these APIs' if not l2apis[b] else ''))
        else: st.append((MISS,''))
    XT.append(dict(id=c['id'],group=x.get('group',c['group']),check=x.get('check',c['desc']),applies=', '.join(x.get('apis',[])),against=x.get('against',''),st=st))

# ---------- workbook ----------
FONT='Arial'; NAVY='1F3A5F'; WHITE='FFFFFF'
thin=Side(style='thin',color='D0D5DD'); BOX=Border(left=thin,right=thin,top=thin,bottom=thin)
F=lambda **k: Font(name=FONT,size=k.pop('size',10),**k)
FILL=lambda c: PatternFill('solid',fgColor=c)
GROUPFILL={'FIS10':'DCE9F7','FIS11':'E6F2E6','FIS12 Lending':'FFF1D6','FIS13 Insurance':'F3E3F3','FIS14 Investments':'E2F0EE'}
STATUS=[('✓','D4EDDA','1E6B34'),('⚠','FFF3CD','8A6100'),('◐','FFE5CC','9A4A00'),('✗','F8D7DA','A0222E'),('–','EEF0F3','6B7280')]
wb=Workbook()
def compare_sheet(name,title,left_cols,data,left_vals,note):
    ws=wb.create_sheet(name)
    nL=len(left_cols); nB=len(BR)
    ws.cell(1,1,title).font=F(size=14,bold=True,color=NAVY)
    ws.cell(2,1,note).font=F(size=9,italic=True,color='555555')
    # group header row 3, branch header row 4
    for i,(h,w) in enumerate(left_cols,1):
        ws.merge_cells(start_row=3,start_column=i,end_row=4,end_column=i)
        c=ws.cell(3,i,h); c.font=F(bold=True,color=WHITE); c.fill=FILL(NAVY); c.alignment=Alignment(wrap_text=True,vertical='center')
        ws.column_dimensions[L(i)].width=w
    col=nL+1; start=col
    groups=[]
    for j,(b,g,s) in enumerate(BR):
        c=ws.cell(4,col+j,s); c.font=F(bold=True,size=9); c.fill=FILL(GROUPFILL[g]); c.alignment=Alignment(wrap_text=True,horizontal='center',vertical='center'); c.border=BOX
        ws.column_dimensions[L(col+j)].width=12.5
        if not groups or groups[-1][0]!=g: groups.append([g,col+j,col+j])
        else: groups[-1][2]=col+j
    for g,a,z in groups:
        if z>a: ws.merge_cells(start_row=3,start_column=a,end_row=3,end_column=z)
        c=ws.cell(3,a,g); c.font=F(bold=True,size=10); c.fill=FILL(GROUPFILL[g]); c.alignment=Alignment(horizontal='center'); c.border=BOX
    endB=col+nB-1
    for k,h in enumerate(['Branches with it','Applicable','Coverage']):
        cc=endB+1+k; ws.merge_cells(start_row=3,start_column=cc,end_row=4,end_column=cc)
        c=ws.cell(3,cc,h); c.font=F(bold=True,color=WHITE); c.fill=FILL(NAVY); c.alignment=Alignment(wrap_text=True,vertical='center',horizontal='center'); ws.column_dimensions[L(cc)].width=11
    ws.row_dimensions[4].height=30
    r0=5
    for i,d in enumerate(data):
        r=r0+i
        for k,v in enumerate(left_vals(i,d),1):
            c=ws.cell(r,k,v); c.font=F(); c.alignment=Alignment(wrap_text=True,vertical='top'); c.border=BOX
        for j,(s,detail) in enumerate(d['st']):
            c=ws.cell(r,col+j,s); c.font=F(size=9); c.alignment=Alignment(horizontal='center',vertical='top'); c.border=BOX
            if detail:
                from openpyxl.comments import Comment
                c.comment=Comment(detail[:250],'extract-validations')
        rng=f'{L(col)}{r}:{L(endB)}{r}'
        ws.cell(r,endB+1,f'=COUNTIF({rng},"✓*")+COUNTIF({rng},"⚠*")+COUNTIF({rng},"◐*")')
        ws.cell(r,endB+2,f'=COUNTA({rng})-COUNTIF({rng},"–*")')
        ws.cell(r,endB+3,f'=IF({L(endB+2)}{r}=0,"-",COUNTIF({rng},"✓*")/{L(endB+2)}{r})'); ws.cell(r,endB+3).number_format='0%'
        for k in (1,2,3): c=ws.cell(r,endB+k); c.font=F(); c.alignment=Alignment(horizontal='center',vertical='top'); c.border=BOX
    last=r0+len(data)-1
    area=f'{L(col)}{r0}:{L(endB)}{last}'
    for sym,bg,fg in STATUS:
        ws.conditional_formatting.add(area,FormulaRule(formula=[f'LEFT({L(col)}{r0},1)="{sym}"'],fill=FILL(bg),font=Font(name=FONT,size=9,color=fg)))
    ws.freeze_panes=ws.cell(5,nL+1)
    ws.auto_filter.ref=f'A4:{L(endB+3)}{last}'
    return ws,col,endB,r0,last

# Summary placeholder first
S=wb.active; S.title='Summary'
w1,c1,e1,s1,z1=compare_sheet('L1 Field rules','L1 – common field rules (config/validations/index.yaml)',
    [('#',5),('Payload',13),('Area',13),('Field',40),('Rule',42)],L1T,lambda i,d:[i+1,d['api'],d['area'],d['field'],d['rule']],
    'Rows = common L1 rules from "Common Validations by Payload". Hover a ⚠ or ◐ cell for the reason.')
w2,c2,e2,s2,z2=compare_sheet('L2 Payload checks','L2 – common payload checks (flow validate() code)',
    [('#',5),('Payload',13),('Area',13),('Check',60)],L2T,lambda i,d:[i+1,d['api'],d['area'],d['rule']],
    'Rows = common L2 checks from "Common Validations by Payload". N/A = the branch has no L2 code for this payload.')
w3,c3,e3,s3,z3=compare_sheet('Cross-call checks','Cross-call checks (consistency between calls of one transaction)',
    [('ID',6),('Area',16),('Check',50),('Applies to',30),('Compared with',20)],XT,lambda i,d:[d['id'],d['group'],d['check'],d['applies'],d['against']],
    'Rows = the 33-check cross-call catalogue. ✓ = at least one L2 check in the branch implements it (hover for the APIs).')

# Gaps sheet
gp=wb.create_sheet('Gaps by branch')
hdr=['Domain','Branch','Layer','Payload','Validation','Status','Reason']
for i,h in enumerate(hdr,1):
    c=gp.cell(1,i,h); c.font=F(bold=True,color=WHITE); c.fill=FILL(NAVY)
for w,i in zip([18,16,14,13,70,14,50],range(1,8)): gp.column_dimensions[L(i)].width=w
r=2
for j,(b,g,s) in enumerate(BR):
    for layer,data,txt in [('L1',L1T,lambda d:f"{d['field']} – {d['rule']}"),('L2',L2T,lambda d:d['rule']),('Cross-call',XT,lambda d:f"{d['id']} {d['check']}")]:
        for d in data:
            st,det=d['st'][j]
            if st[0] in '✗◐⚠':
                vals=[g,s,layer,d.get('api') or d.get('applies',''),txt(d),st,det]
                for k,v in enumerate(vals,1): c=gp.cell(r,k,v); c.font=F(size=9); c.alignment=Alignment(wrap_text=(k in(4,5,7)),vertical='top')
                r+=1
gp.freeze_panes='A2'; gp.auto_filter.ref=f'A1:G{r-1}'
for sym,bg,fg in STATUS:
    gp.conditional_formatting.add(f'F2:F{r-1}',FormulaRule(formula=[f'LEFT(F2,1)="{sym}"'],fill=FILL(bg),font=Font(name=FONT,size=9,color=fg)))

# Summary
S['A1']='Finance domain – common validations comparison'; S['A1'].font=F(size=16,bold=True,color=NAVY)
S['A2']=('Compares every finance branch in automation-specifications against the common validations defined in '
         '"Common Validations by Payload". Built by extract-validations.mjs + gold.mjs (no manual edits): '
         'L1 from config/validations/index.yaml, L2 from flow validate() code, cross-call via standard/cross-call-catalog.json. '
         'Source: ONDC-Official/automation-specifications, upstream branch heads on 18 Oct 2026.')
S['A2'].font=F(size=10); S['A2'].alignment=Alignment(wrap_text=True,vertical='top'); S.merge_cells('A2:L2'); S.row_dimensions[2].height=48
hdr=['Domain','Branch','L1 present','L1 always runs','L1 applicable','L1 coverage','L2 present','L2 applicable','L2 coverage','Cross-call checked','Cross-call applicable','Cross-call coverage','Missing (all layers)']
R0=4
for i,h in enumerate(hdr,1):
    c=S.cell(R0,i,h); c.font=F(bold=True,color=WHITE); c.fill=FILL(NAVY); c.alignment=Alignment(wrap_text=True,vertical='center',horizontal='center')
S.row_dimensions[R0].height=32
def rng(sheet,col,a,z): return f"'{sheet}'!{L(col)}{a}:{L(col)}{z}"
for j,(b,g,s) in enumerate(BR):
    r=R0+1+j; A=rng('L1 Field rules',c1+j,s1,z1); B=rng('L2 Payload checks',c2+j,s2,z2); X=rng('Cross-call checks',c3+j,s3,z3)
    vals=[g,s,
      f'=COUNTIF({A},"✓*")+COUNTIF({A},"⚠*")+COUNTIF({A},"◐*")', f'=COUNTIF({A},"✓ Always")', f'=COUNTA({A})-COUNTIF({A},"–*")',
      f'=IF(E{r}=0,"-",D{r}/E{r})',
      f'=COUNTIF({B},"✓*")+COUNTIF({B},"⚠*")', f'=COUNTA({B})-COUNTIF({B},"–*")', f'=IF(H{r}=0,"-",COUNTIF({B},"✓*")/H{r})',
      f'=COUNTIF({X},"✓*")', f'=COUNTA({X})-COUNTIF({X},"–*")', f'=IF(K{r}=0,"-",J{r}/K{r})',
      f'=COUNTIF({A},"✗*")+COUNTIF({B},"✗*")+COUNTIF({X},"✗*")']
    for i,v in enumerate(vals,1):
        c=S.cell(r,i,v); c.font=F(bold=(i==2)); c.border=BOX; c.alignment=Alignment(horizontal='left' if i<3 else 'center')
        if i in(6,9,12): c.number_format='0%'
    S.cell(r,1).fill=FILL(GROUPFILL[g]); S.cell(r,2).fill=FILL(GROUPFILL[g])
last=R0+len(BR)
for col in ('F','I','L'):
    S.conditional_formatting.add(f'{col}{R0+1}:{col}{last}',FormulaRule(formula=[f'AND(ISNUMBER({col}{R0+1}),{col}{R0+1}>=0.8)'],fill=FILL('D4EDDA')))
    S.conditional_formatting.add(f'{col}{R0+1}:{col}{last}',FormulaRule(formula=[f'AND(ISNUMBER({col}{R0+1}),{col}{R0+1}<0.5)'],fill=FILL('F8D7DA')))
for i,w in enumerate([18,15,10,10,10,10,10,10,10,11,11,11,11],1): S.column_dimensions[L(i)].width=w
r=last+2
S.cell(r,1,'How to read the status').font=F(size=12,bold=True,color=NAVY); r+=1
legend=[('✓ Always','The validation exists and always runs.'),('✓ If sent','Allowed-values / format rule checked whenever the field is sent (normal for value rules).'),
        ('✓ Checked','Cross-call check implemented in at least one L2 step (hover for the APIs).'),
        ('⚠ Optional','A "required" rule that is skipped when the field is absent – so the field is effectively optional.'),
        ('⚠ Conditional','Present, but skipped in some scenarios (hover for the condition).'),
        ('◐ Partial','Only part of the rule exists (e.g. required check present, allowed-values check missing).'),
        ('✗ Missing','The branch uses this payload but does not have this validation.'),
        ('– N/A','The branch does not use this payload / has no L2 code for it.')]
for k,(a,bb) in enumerate(legend):
    c=S.cell(r+k,1,a); c.font=F(bold=True,size=10); sym=a[0]
    for s_,bg,fg in STATUS:
        if s_==sym: c.fill=FILL(bg); c.font=F(bold=True,size=10,color=fg)
    S.cell(r+k,2,bb).font=F(size=10); S.merge_cells(start_row=r+k,start_column=2,end_row=r+k,end_column=12)
r+=len(legend)+1
S.cell(r,1,'Tabs').font=F(size=12,bold=True,color=NAVY); r+=1
for a,bb in [('L1 Field rules',f'{len(L1T)} common field rules × 14 branches'),('L2 Payload checks',f'{len(L2T)} common payload checks × 14 branches'),
             ('Cross-call checks',f'{len(XT)} cross-call checks × 14 branches'),('Gaps by branch','Every ✗ / ◐ / ⚠ as an actionable list, filterable by branch'),
             ('Method','How each status is decided')]:
    S.cell(r,1,a).font=F(bold=True); S.cell(r,2,bb).font=F(); S.merge_cells(start_row=r,start_column=2,end_row=r,end_column=12); r+=1
S.freeze_panes='C5'

# Method
mt=wb.create_sheet('Method'); mt.column_dimensions['A'].width=22; mt.column_dimensions['B'].width=120
lines=[('Rows','The common validations from "Common Validations by Payload" (L1 field rules, L2 payload checks, 33 cross-call checks). Context ($.context) rules are excluded, as in that document.'),
 ('Branch data','extract-validations.mjs (v0.4, deterministic) on each upstream branch → gold.mjs simplify → one row per validation (Layer, API, Field, Check, Runs).'),
 ('L1 match','Same payload (API) and same field path; [*] and tag filters such as [descriptor.code=LOAN_INFO] are treated as the same list. A rule needs a Required check and/or an Allowed-values check depending on the rule text.'),
 ('L1 run status','Taken from the strongest matching rule: Always → ✓ Always; skipped only when the field itself is absent → ⚠ Optional (required rules) or ✓ If sent (value rules); any other skip → ⚠ Conditional.'),
 ('L2 match','Fixed field/check patterns per common check, e.g. "order.provider.id is present" = an L2 Required check on order.provider.id in that payload. "message.order is present" also counts deeper checks under order.* (presence is implied).'),
 ('Cross-call','lib/crosscall.mjs maps each L2 check onto the catalogue IDs with fixed rules; ✓ when at least one check in the branch maps to the ID.'),
 ('N/A','L1/L2: the branch has no rule / no flow step for that payload. Cross-call: none of the APIs the check applies to are in the branch, or the branch has no L2 code at all.'),
 ('Reproduce','node extract-validations.mjs --repo ../automation-specifications --ref <each branch> --out out/fis  →  node gold.mjs simplify --in out/fis/validations.json --out out/simple  →  python3 finance-compare.py')]
for i,(a,bb) in enumerate(lines,1):
    mt.cell(i,1,a).font=F(bold=True); c=mt.cell(i,2,bb); c.font=F(); c.alignment=Alignment(wrap_text=True,vertical='top'); mt.row_dimensions[i].height=32
wb.move_sheet('Summary',-wb.index(wb['Summary']))
OUT=sys.argv[1] if len(sys.argv)>1 else f'{G}/out/Finance_Common_Validations_Comparison.xlsx'
wb.save(OUT)
print(f'{len(L1T)} L1 rules, {len(L2T)} L2 checks, {len(XT)} cross-call checks x {len(BR)} branches -> {OUT}')
