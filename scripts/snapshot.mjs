import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, sum } from './lib.mjs';
import { parseEditorJson } from './editor-core.mjs';

export const snapshotHeaders = ['快照日期', '持仓编号', '基金代码', '基金名称', '持仓平台', '当前持有金额(元)', '持有份额', '可赎回份额', '净值日期', '持有起始日期', '待确认申购金额(元)', '待到账赎回金额(元)', '备注'];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function encodeCsv(rows) {
  return '\uFEFF' + rows.map(row => row.map(value => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }).join(',')).join('\r\n') + '\r\n';
}

// Local CSV import requires strict row/column and missing-value validation.
// Quoted multiline notes and Excel UTF-8 BOM are supported; no formulas run.
export function decodeCsv(input) {
  const text = input.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], cell = '', state = 'unquoted';
  function nextCell() { row.push(cell); cell = ''; state = 'unquoted'; }
  function nextRow() { nextCell(); if (row.some(v => v !== '')) rows.push(row); row = []; }
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (state === 'quoted') {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else state = 'closed';
      } else cell += c;
    } else if (c === ',') nextCell();
    else if (c === '\r' || c === '\n') { if (c === '\r' && text[i + 1] === '\n') i++; nextRow(); }
    else if (c === '"' && cell === '' && state === 'unquoted') state = 'quoted';
    else {
      if (state === 'closed' || c === '"') throw new Error('CSV引号格式错误');
      cell += c;
    }
  }
  if (state === 'quoted') throw new Error('CSV引号未闭合');
  if (cell !== '' || row.length || state === 'closed') nextRow();
  return rows;
}

function validDate(text, label, optional = false) {
  if (!text && optional) return null;
  const [year, month, day] = text.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || year < 1900 || d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) throw new Error(`${label}须填写有效日期YYYY-MM-DD`);
  return text;
}
function numberValue(text, label, optional = false) {
  if (!text && optional) return null;
  // Accept Excel thousands separators only when properly grouped.
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text)) throw new Error(`${label}须填写非负数字；未知值留空，不能用空值代替0`);
  const value = Number(text.replaceAll(',', ''));
  if (!Number.isFinite(value)) throw new Error(`${label}无效`);
  return value;
}

export function parseSnapshotCsv(text, previous, mandate, today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' })) {
  const [headers, ...rows] = decodeCsv(text);
  if (!headers || headers.length !== snapshotHeaders.length || headers.some((h, i) => h.trim() !== snapshotHeaders[i])) throw new Error('表头被修改，请保留原13列及顺序');
  const known = new Map(previous.holdings.map(h => [h.id, h]));
  const allowedCodes = new Set(mandate.allowed_fund_codes);
  const seen = new Set(), dates = new Set(), holdings = [];
  let cash = null;
  for (const row of rows) {
    if (row.length !== headers.length) throw new Error('CSV列数错误：备注含逗号时需用引号包围');
    const [date, id, rawCode, name, platform, amountText, unitsText, redeemableText, navDateText, firstDateText, pendingBuyText, pendingSellText, notes] = row.map(v => v.trim());
    if (!id || seen.has(id)) throw new Error(`持仓编号为空或重复：${id}`);
    seen.add(id);
    const snapshotDate = validDate(date, `${id}快照日期`);
    if (snapshotDate > today) throw new Error(`${id}快照日期不能晚于今天`);
    dates.add(snapshotDate);
    const amount = numberValue(amountText, `${id}当前持有金额`);
    const pendingBuy = numberValue(pendingBuyText, `${id}待确认申购金额`, true);
    const pendingSell = numberValue(pendingSellText, `${id}待到账赎回金额`, true);
    if (id === 'CASH01') {
      if (rawCode || unitsText || redeemableText || navDateText || firstDateText) throw new Error('CASH01为策略可用现金，基金代码、份额及净值日期等留空');
      cash = { id, name, platform, amount_cny: amount, snapshot_date: snapshotDate, pending_buy_cny: pendingBuy, pending_redemption_receivable_cny: pendingSell, notes };
      continue;
    }
    // Excel often removes leading zeros. Accept only integer codes and restore
    // six digits, then cross-check against the stable holding ID and whitelist.
    if (!/^\d{1,6}$/.test(rawCode)) throw new Error(`${id}基金代码须为六位数字`);
    const code = rawCode.padStart(6, '0');
    if (!allowedCodes.has(code)) throw new Error(`${id}基金代码不在授权范围内：${code}`);
    const old = known.get(id);
    if (!old) throw new Error(`未知持仓编号：${id}；新增账户/份额记录需先登记`);
    if (old.code !== code || old.platform !== platform) throw new Error(`${id}基金代码或平台与登记不符，不要改动身份列`);
    const units = numberValue(unitsText, `${id}持有份额`, true);
    const redeemable = numberValue(redeemableText, `${id}可赎回份额`, true);
    if (redeemable !== null && units !== null && redeemable > units + 1e-8) throw new Error(`${id}可赎回份额不能大于持有份额`);
    if (amount === 0 && units !== null && units > 0) throw new Error(`${id}金额为0但仍填写正持有份额，请核对`);
    const navDate = validDate(navDateText, `${id}净值日期`, true);
    const firstDate = validDate(firstDateText, `${id}持有起始日期`, true);
    if ([navDate, firstDate].some(d => d && d > snapshotDate)) throw new Error(`${id}净值日期或持有起始日期不能晚于快照日期`);
    holdings.push({ ...old, name: name || old.name, amount_cny: amount, snapshot_date: snapshotDate, units, redeemable_units: redeemable, nav_date: navDate, first_holding_date: firstDate, unit_nav: null, batches: [], batches_as_of: null, redeemability_basis: null, pending_buy_cny: pendingBuy, pending_redemption_receivable_cny: pendingSell, notes, reported_cumulative_pnl_cny: null, previous_reported_cumulative_pnl_cny: old.reported_cumulative_pnl_cny ?? old.previous_reported_cumulative_pnl_cny ?? null });
  }
  if (dates.size !== 1) throw new Error('所有行必须填写同一个快照日期');
  if (!cash) throw new Error('缺少CASH01现金行；没有可用现金时填0，不要删除');
  for (const id of known.keys()) if (!seen.has(id)) throw new Error(`缺少持仓${id}：已卖完请保留行并将金额填0`);
  const snapshotDate = [...dates][0];
  if (previous.snapshot_date && snapshotDate < previous.snapshot_date) throw new Error('不能用较早日期覆盖当前持仓快照');
  const fundTotal = sum(holdings.map(h => h.amount_cny));
  const pendingBuyValues = holdings.map(h => h.pending_buy_cny).concat(cash.pending_buy_cny);
  const pendingSellValues = holdings.map(h => h.pending_redemption_receivable_cny).concat(cash.pending_redemption_receivable_cny);
  return {
    ...previous,
    schema_version: 2,
    snapshot_date: snapshotDate,
    imported_at: new Date().toISOString(),
    amount_basis: 'user_updated_platform_holding_value',
    holdings,
    strategy_cash: cash,
    fund_total_cny: fundTotal,
    fund_plus_available_cash_cny: sum([fundTotal, cash.amount_cny]),
    pending_buy_total_cny: pendingBuyValues.every(v => v !== null) ? sum(pendingBuyValues) : null,
    pending_redemption_total_cny: pendingSellValues.every(v => v !== null) ? sum(pendingSellValues) : null,
    pending_amounts_added_to_total: false,
    pending_amount_basis: 'not_reconciled_with_platform_totals; never_add_automatically',
    missing_execution_fields: holdings.filter(h => h.amount_cny > 0 && (h.units === null || h.redeemable_units === null || h.first_holding_date === null)).map(h => h.id)
  };
}

async function readJson(relative) { return JSON.parse((await fs.readFile(path.join(root, relative), 'utf8')).replace(/^\uFEFF/, '')); }
export async function atomicJson(relative, value, workspaceRoot = root) {
  const file = path.join(workspaceRoot, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.tmp`, JSON.stringify(value, null, 2) + '\n');
  await fs.rename(`${file}.tmp`, file);
}
export async function persistSnapshot(snapshot, text, sourceFile, workspaceRoot = root) {
  const hash = sha256(text);
  const previous = JSON.parse(await fs.readFile(path.join(workspaceRoot,'data/holdings/current.json'),'utf8'));
  if (previous.source_sha256 === hash && previous.snapshot_date === snapshot.snapshot_date) return false;
  snapshot.source_file = sourceFile;
  snapshot.source_sha256 = hash;
  snapshot.source_archive = `data/raw/holdings/${hash}.${path.extname(sourceFile).toLowerCase() === '.json' ? 'json' : 'csv'}`;
  const rawFile = path.join(workspaceRoot,snapshot.source_archive);
  await fs.mkdir(path.dirname(rawFile), {recursive:true});
  await fs.writeFile(rawFile,text);
  await atomicJson(`data/holdings/history/${snapshot.snapshot_date}/${hash}.json`,snapshot,workspaceRoot);
  await atomicJson(`data/holdings/history/prior/${sha256(JSON.stringify(previous))}.json`,previous,workspaceRoot);
  await fs.mkdir(path.join(workspaceRoot,'data/manifests'),{recursive:true});
  await fs.appendFile(path.join(workspaceRoot,'data/manifests/holdings.jsonl'),JSON.stringify({imported_at:snapshot.imported_at,source_file:sourceFile,source_archive:snapshot.source_archive,sha256:hash,snapshot_date:snapshot.snapshot_date})+'\n');
  await atomicJson('data/holdings/current.json',snapshot,workspaceRoot);
  return true;
}
async function main() {
  const [command = 'check', ...args] = process.argv.slice(2);
  if (!['check', 'import'].includes(command)) throw new Error('Usage: node scripts/snapshot.mjs check|import [path.csv|path.json]');
  const csvPath = path.resolve(root, args[0] ?? '每日持仓.json');
  const relative = path.relative(root, csvPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('持仓文件须在当前项目目录内');
  const text = await fs.readFile(csvPath, 'utf8');
  const previous = await readJson('data/holdings/current.json');
  const mandate = await readJson('config/investment-mandate.json');
  const isEditorJson = path.extname(csvPath).toLowerCase() === '.json';
  const editorDoc = isEditorJson ? JSON.parse(text.replace(/^\uFEFF/, '')) : null;
  const snapshot = isEditorJson ? parseEditorJson(editorDoc,previous,mandate) : parseSnapshotCsv(text,previous,mandate);
  const summary = { date: snapshot.snapshot_date, count: snapshot.holdings.length, fund_total_cny: snapshot.fund_total_cny, available_cash_cny: snapshot.strategy_cash.amount_cny, total_cny: snapshot.fund_plus_available_cash_cny, execution_fields_missing_count: snapshot.missing_execution_fields.length, pending_amounts_complete: snapshot.pending_buy_total_cny !== null && snapshot.pending_redemption_total_cny !== null };
  if (command === 'check') { console.log('校验通过（未导入）', JSON.stringify(summary)); return; }
  if (!await persistSnapshot(snapshot,text,relative.replaceAll(path.sep,'/'))) { console.log('这份快照已导入，未重复写入。'); return; }
  console.log('快照已导入并保留历史', JSON.stringify(summary));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
