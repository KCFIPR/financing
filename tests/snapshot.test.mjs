import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { encodeCsv, decodeCsv, parseSnapshotCsv, snapshotHeaders } from '../scripts/snapshot.mjs';
import { validateSnapshot, parseHoldings } from '../scripts/lib.mjs';

import { previous, mandate } from './fixtures/holdings.mjs';
function rows() {
  return [snapshotHeaders, ...previous.holdings.map(h => ['2026-10-02', h.id, h.code, h.name, h.platform, h.amount_cny, '', '', '', '', 0, 0, '']), ['2026-10-02', 'CASH01', '', '策略可用现金', '后备资金', 100000, '', '', '', '', 0, 0, '']];
}
const parse = data => parseSnapshotCsv(encodeCsv(data), { ...previous, snapshot_date: null }, mandate, '2026-10-02');

test('CSV preserves independent records, leading zeros, quotes and multiline notes', () => {
  const data = rows();
  data[1][12] = '当天申请,备注"原文"\n尚未确认';
  const output = parse(data);
  assert.equal(output.holdings.length, 25);
  assert.equal(output.holdings.filter(h => h.code === '000120').length, 3);
  assert.equal(output.holdings[1].code, '000101');
  assert.equal(output.holdings[0].notes, data[1][12]);
  assert.equal(output.fund_total_cny, 25000);
  assert.equal(output.fund_plus_available_cash_cny, 125000);
  assert.equal(output.snapshot_date, '2026-10-02');
  assert.equal(output.holdings[0].reported_cumulative_pnl_cny, null);
});
test('Excel-stripped fund code is restored only after stable-ID crosscheck', () => {
  const data = rows(); data[2][2] = '101';
  assert.equal(parse(data).holdings[1].code, '000101');
  data[2][2] = '000100';
  assert.throws(() => parse(data), /登记不符/);
});
test('zero marks closed holding, blank money never becomes zero', () => {
  const data = rows(); data[1][5] = 0; data[1][6] = 0;
  const output = parse(data);
  assert.equal(output.holdings[0].amount_cny, 0);
  assert.doesNotThrow(() => validateSnapshot(output));
  data[1][5] = '';
  assert.throws(() => parse(data), /当前持有金额/);
  const cashBlank = rows(); cashBlank.at(-1)[5] = '';
  assert.throws(() => parse(cashBlank), /CASH01当前持有金额/);
});
test('reject missing rows, duplicate IDs, missing cash and unauthorized code', () => {
  const missing = rows(); missing.splice(1, 1);
  assert.throws(() => parse(missing), /缺少持仓B01/);
  const duplicate = rows(); duplicate[2][1] = 'B01';
  assert.throws(() => parse(duplicate), /重复/);
  const noCash = rows(); noCash.pop();
  assert.throws(() => parse(noCash), /缺少CASH01/);
  const unknown = rows(); unknown[1][2] = '999999';
  assert.throws(() => parse(unknown), /授权范围/);
});
test('snapshot date must be valid, shared, non-future and not older than current', () => {
  const mixed = rows(); mixed[1][0] = '2026-10-01';
  assert.throws(() => parse(mixed), /同一个/);
  for (const bad of ['', '2026-02-30', '2026-10-03']) {
    const data = rows(); data[1][0] = bad;
    assert.throws(() => parse(data), /日期/);
  }
  assert.throws(() => parseSnapshotCsv(encodeCsv(rows()), { ...previous, snapshot_date: '2026-10-03' }, mandate, '2026-10-03'), /较早日期/);
});
test('unknown optional data remains null; pending amounts are not added to totals', () => {
  const data = rows(); data[1][10] = ''; data[2][11] = 1000;
  const output = parse(data);
  assert.equal(output.holdings[0].units, null);
  assert.equal(output.pending_buy_total_cny, null);
  assert.equal(output.pending_redemption_total_cny, 1000);
  assert.equal(output.fund_plus_available_cash_cny, 125000);
  assert.equal(output.pending_amounts_added_to_total, false);
});
test('reject impossible redeemable units and NAV date after snapshot', () => {
  const data = rows(); data[1][6] = 10; data[1][7] = 11;
  assert.throws(() => parse(data), /不能大于/);
  data[1][7] = 5; data[1][8] = '2026-10-03';
  assert.throws(() => parse(data), /不能晚于/);
});
test('reject malformed CSV and spreadsheet formula amounts', () => {
  assert.throws(() => decodeCsv('a,"unterminated'), /未闭合/);
  assert.throws(() => decodeCsv('a,"quoted"junk'), /格式错误/);
  const data = rows(); data[1][5] = '=100+200';
  assert.throws(() => parse(data), /非负数字/);
});
test('CLI imports only validated files, archives same-day corrections and preserves state on error', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'financing-snapshot-test-'));
  for (const dir of ['scripts', 'config', 'data/holdings']) await fs.mkdir(path.join(tempRoot, dir), { recursive: true });
  for (const file of ['snapshot.mjs', 'lib.mjs', 'editor-core.mjs']) await fs.copyFile(new URL(`../scripts/${file}`, import.meta.url), path.join(tempRoot, 'scripts', file));
  await fs.writeFile(path.join(tempRoot, 'config/investment-mandate.json'), JSON.stringify(mandate));
  await fs.writeFile(path.join(tempRoot, 'data/holdings/current.json'), JSON.stringify(previous));
  const csvPath = path.join(tempRoot, '每日持仓.csv');
  const data = rows();
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
  for (const row of data.slice(1)) row[0] = today;
  const run = promisify(execFile);
  const invoke = () => run(process.execPath, [path.join(tempRoot, 'scripts/snapshot.mjs'), 'import', '每日持仓.csv'], { cwd: tempRoot });
  await fs.writeFile(csvPath, encodeCsv(data));
  await invoke();
  let current = JSON.parse(await fs.readFile(path.join(tempRoot, 'data/holdings/current.json'), 'utf8'));
  assert.equal(current.snapshot_date, today);
  assert.equal(current.fund_plus_available_cash_cny, 125000);
  assert.equal(await fs.readFile(path.join(tempRoot, current.source_archive), 'utf8'), encodeCsv(data));
  assert.match((await invoke()).stdout, /已导入，未重复/);
  data[1][5] = 0;
  await fs.writeFile(csvPath, encodeCsv(data));
  await invoke();
  assert.equal((await fs.readdir(path.join(tempRoot, 'data/holdings/history', today))).length, 2);
  const before = await fs.readFile(path.join(tempRoot, 'data/holdings/current.json'), 'utf8');
  data[1][5] = '';
  await fs.writeFile(csvPath, encodeCsv(data));
  await assert.rejects(invoke(), /当前持有金额/);
  assert.equal(await fs.readFile(path.join(tempRoot, 'data/holdings/current.json'), 'utf8'), before);
});
