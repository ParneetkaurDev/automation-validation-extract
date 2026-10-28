// changes.xlsx for restructure-xval: what the restructure changed in config/validations/index.yaml, place by place.
import ExcelJS from 'exceljs';
const NAVY = 'FF1F3A5F', ZEBRA = 'FFF5F7FA', FONT = 'Arial', GREEN = 'FFE8F3EC', BLUE = 'FFE8EEF7';
const KIND = { RULES: 'Rule group', RULE: 'Rule', LIST: 'Value list' };
const API_ORDER = ['search', 'on_search', 'select', 'on_select', 'init', 'on_init', 'confirm', 'on_confirm', 'update', 'on_update', 'status', 'on_status', 'cancel', 'on_cancel', 'issue', 'on_issue', 'issue_status', 'on_issue_status'];
const rank = (a) => { const i = API_ORDER.indexOf(a); return i < 0 ? 999 : i; };
const cap = (s, n = 40) => { const a = String(s || '').split('\n'); return a.length > n ? [...a.slice(0, n), `… (${a.length - n} more lines)`].join('\n') : a.join('\n'); };

export function changeText(c) {
  return c.change === 'moved' ? `Moved to _COMMON_ as ${c.block}, replaced here by *${c.block}` : `Duplicate removed, replaced by *${c.block}`;
}
export function perApi(info) {
  const m = new Map();
  for (const c of info.changes) {
    const k = c.api || '(inside _COMMON_ blocks)';
    if (!m.has(k)) m.set(k, { api: k, places: 0, moved: 0, replaced: 0, oldLines: 0, blocks: new Set() });
    const e = m.get(k); e.places++; e[c.change]++; e.blocks.add(c.block);
    if (c.oldLines && !c.note) e.oldLines += c.oldLines[1] - c.oldLines[0] + 1;
  }
  return [...m.values()].sort((a, b) => rank(a.api) - rank(b.api));
}

export async function writeChangesXlsx(file, info) {
  const wb = new ExcelJS.Workbook(); wb.creator = 'restructure-xval.mjs'; wb.created = new Date(0);
  const sheet = (name, cols, rows, wrap = []) => {
    const ws = wb.addWorksheet(name);
    ws.columns = cols.map(([header, key, width]) => ({ header, key, width }));
    rows.forEach((r) => ws.addRow(r));
    const h = ws.getRow(1);
    h.font = { name: FONT, bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; h.alignment = { vertical: 'middle', wrapText: true }; h.height = 28;
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    if (rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
    ws.eachRow((row, i) => {
      if (i === 1) return;
      row.font = { name: FONT, size: 10 }; row.alignment = { vertical: 'top' };
      for (const c of wrap) row.getCell(c).alignment = { vertical: 'top', wrapText: true };
      if (i % 2 === 0) row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ZEBRA } };
    });
    return ws;
  };

  // 1. Changes - one row per place in the old file that changed
  const changes = [...info.changes].sort((a, b) => (a.api ? 0 : 1) - (b.api ? 0 : 1) || (a.oldLines?.[0] ?? 1e9) - (b.oldLines?.[0] ?? 1e9));
  const ws = sheet('Changes', [['#', 'n', 5], ['API', 'api', 14], ['Where (rule path)', 'where', 40], ['Before (old file)', 'before', 60],
    ['Change', 'change', 34], ['After (new file)', 'after', 30], ['Common block', 'block', 34], ['Note', 'note', 34]],
  changes.map((c, i) => ({ n: i + 1, api: c.api || `_COMMON_ › ${c.inBlock}`, where: c.rulePath || '(whole API list)', before: cap(c.oldText),
    change: changeText(c), after: `*${c.block}`, block: c.block, note: c.note })), ['before', 'change', 'where', 'note']);
  ws.eachRow((row, i) => { if (i > 1) row.getCell('change').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: changes[i - 2].change === 'moved' ? GREEN : BLUE } }; });

  // 2. Common blocks - what is now at the top of the file
  sheet('Common blocks', [['#', 'n', 5], ['Name', 'name', 36], ['Type', 'kind', 12], ['Used', 'uses', 7], ['APIs', 'apis', 40], ['Definition (in _COMMON_)', 'def', 70], ['Uses blocks', 'deps', 34]],
    info.defs.map((d, i) => ({ n: i + 1, name: d.name, kind: KIND[d.kind], uses: d.uses, apis: [...new Set(d.usedIn.map((u) => u.split(' › ')[0]))].join(', '),
      def: cap(d.definition, 60), deps: d.dependsOn.join(', ') })), ['def', 'apis', 'deps']);

  // 3. Per API
  sheet('Per API', [['API', 'api', 26], ['Places changed', 'places', 14], ['Moved to _COMMON_', 'moved', 16], ['Replaced by reference', 'replaced', 18], ['Common blocks used', 'blocks', 70]],
    perApi(info).map((e) => ({ ...e, blocks: [...e.blocks].join(', ') })), ['blocks']);

  // 4. Old anchors
  sheet('Old anchors', [['Old anchor', 'old', 26], ['Times used', 'used', 12], ['Now', 'now', 46]],
    info.anchorMap.map((a) => ({ old: `&${a.old}`, used: a.usedAt.length, now: a.now.startsWith('(') ? a.now : `&${a.now}` })), ['used']);

  await wb.xlsx.writeFile(file);
}
