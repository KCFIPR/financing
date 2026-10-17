import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { editorRows, attachEditorDetails, normalizeHoldingDays, normalizeHoldingDayBounds, normalizeHoldingPnl, estimateHoldingReturnPct, parseEditorJson, createEditorDocument, validateEditorDocument } from '../scripts/editor-core.mjs';
import { encodeCsv, parseSnapshotCsv, snapshotHeaders } from '../scripts/snapshot.mjs';
import { parseHoldings } from '../scripts/lib.mjs';
import { previous, mandate } from './fixtures/holdings.mjs';
function document() {
  return { format: 'financing-holdings-editor-v1', snapshot_date: '2026-10-08', cash: { amount_cny: '1000' }, holdings: previous.holdings.map(h => ({ id: h.id, code: h.code, name: h.name, platform: h.platform, amount_cny: '120', unit_nav: '', nav_date: '', all_redeemable: true, batches: [{ units: '50', holding_days: '9', redemption_fee_pct: '0.5' }, { units: '50', holding_days: '100', redemption_fee_pct: '0' }] })) };
}
const parse = doc => attachEditorDetails(parseSnapshotCsv(encodeCsv(editorRows(doc,snapshotHeaders)), { ...previous, snapshot_date: null },mandate,'2026-10-08'),doc);

test('holding P/L accepts negative and zero values, percent units, blanks and rejects invalid input', () => {
  for (const [value,expected] of [[undefined,null],[null,null],['',null],['0',0],[0,0],['-123.45',-123.45],['+1.25',1.25],[150,150],[0.00000001,0.00000001]]) {
    assert.equal(normalizeHoldingPnl(value),expected);
  }
  for (const value of [true,{},[],Infinity,NaN,'Infinity','bad',' ','1,000','1%','1e309']) {
    assert.throws(()=>normalizeHoldingPnl(value),/有效数字/);
  }
  for (const prop of ['holding_pnl_cny','holding_return_pct']) {
    const doc=document();doc.holdings[0][prop]='invalid';
    for (const draft of [true,false]) assert.throws(()=>validateEditorDocument(doc,previous.holdings,mandate.allowed_fund_codes,{draft,today:'2026-10-08'}),/收益/);
    assert.throws(()=>parse(doc),/收益/);
  }
});

test('estimated return uses current cost, handles missing or invalid cost and recalculates on save', () => {
  for (const [amount,pnl,expected] of [[1100,100,10],[900,-100,-10],[1000,0,0],[0,-100,-100],[100,100,null],[100,150,null],[null,10,null],[100,null,null],[100,'',null]]) {
    assert.equal(estimateHoldingReturnPct(amount,pnl),expected);
  }
  const doc=document();doc.holdings[0].amount_cny=1100;doc.holdings[0].holding_pnl_cny=100;
  doc.holdings[0].estimated_holding_return_pct=999;
  const normalized=validateEditorDocument(doc,previous.holdings,mandate.allowed_fund_codes,{draft:true,today:'2026-10-08'});
  assert.equal(normalized.holdings[0].estimated_holding_return_pct,10);
  normalized.holdings[0].amount_cny=2100;
  assert.equal(parseEditorJson(normalized,previous,mandate,'2026-10-08').holdings[0].estimated_holding_return_pct,5);
});

test('removed cumulative input is not written to editable records or used as holding P/L', () => {
  const doc=document();
  Object.assign(doc.holdings[0],{amount_cny:1100,holding_pnl_cny:100,holding_return_pct:9.5,reported_cumulative_pnl_cny:'-250.25'});
  for(const snapshot of [parseEditorJson(doc,previous,mandate,'2026-10-08'),parse(doc)]) {
    const h=snapshot.holdings[0];
    assert.equal(h.reported_cumulative_pnl_cny,null);
    assert.equal(h.holding_pnl_cny,100);
    assert.equal(h.estimated_holding_return_pct,10);
    assert.equal(h.holding_return_pct,9.5);
    assert.equal(snapshot.fund_plus_available_cash_cny,4980);
    const reload=createEditorDocument(snapshot);
    assert.ok(!Object.hasOwn(reload.holdings[0],'reported_cumulative_pnl_cny'));
  }
  doc.holdings[0].analysis_enabled=false;
  assert.equal(parseEditorJson(doc,previous,mandate,'2026-10-08').excluded_holdings[0].reported_cumulative_pnl_cny,null);
});

test('current holding P/L survives snapshots and reload without reusing cumulative P/L or double counting assets', () => {
  const doc=document();
  doc.holdings[0].holding_pnl_cny='-123.45';doc.holdings[0].holding_return_pct='-1.25';
  doc.holdings[1].holding_pnl_cny=0;doc.holdings[1].holding_return_pct=0;
  const native=parseEditorJson(doc,previous,mandate,'2026-10-08');
  for (const snapshot of [native,parse(doc)]) {
    assert.equal(snapshot.holdings[0].holding_pnl_cny,-123.45);
    assert.equal(snapshot.holdings[0].holding_return_pct,-1.25);
    assert.equal(snapshot.holdings[1].holding_pnl_cny,0);
    assert.equal(snapshot.holdings[2].holding_pnl_cny,null);
    assert.equal(snapshot.holdings[2].holding_return_pct,null);
    assert.equal(snapshot.fund_plus_available_cash_cny,4000);
    const reload=createEditorDocument(snapshot);
    assert.equal(reload.holdings[0].holding_pnl_cny,-123.45);
    assert.equal(reload.holdings[0].holding_return_pct,-1.25);
  }
  const reload=createEditorDocument(native);
  reload.holdings[0].holding_pnl_cny='';reload.holdings[0].holding_return_pct='';
  const cleared=parseEditorJson(reload,native,mandate,'2026-10-08');
  assert.equal(cleared.holdings[0].holding_pnl_cny,null);
  assert.equal(cleared.holdings[0].holding_return_pct,null);
  const initial=createEditorDocument(previous);
  assert.ok(initial.holdings.every(h=>h.holding_pnl_cny===null&&h.holding_return_pct===null));
  doc.holdings[0].analysis_enabled=false;
  const excluded=parseEditorJson(doc,previous,mandate,'2026-10-08').excluded_holdings[0];
  assert.equal(excluded.holding_pnl_cny,-123.45);
});

test('holding day intervals normalize inclusive and exclusive boundaries without losing meaning', () => {
  for (const [input, expected] of [[null,null],['',null],[0,0],['60天',60],[' 7 至 59 天 ','7-59'],['7～59','7-59'],['0-0','0-0'],['>=60天','>=60'],['≥60天','>=60'],['>60','>60'],['<7天','<7'],['≤7天','<=7'],['<=0','<=0']]) {
    assert.equal(normalizeHoldingDays(input),expected);
  }
  for (const input of ['59-7','-1','2.5','7-59.5','>=-60','<0','60以上','abc',' ',Infinity,NaN,{},true,'9007199254740992']) {
    assert.throws(() => normalizeHoldingDays(input),/有效区间/);
  }
});

test('ranges survive draft validation, native snapshots, reload and legacy import', () => {
  const doc = document();
  doc.holdings[0].batches[0].holding_days = '7-59天';
  doc.holdings[0].batches[1].holding_days = '>=60天';
  const draft = validateEditorDocument(doc,previous.holdings,mandate.allowed_fund_codes,{draft:true,today:'2026-10-08'});
  assert.deepEqual(draft.holdings[0].batches.map(b=>[b.holding_days_min,b.holding_days_max]),[[7,59],[60,null]]);
  const native = parseEditorJson(doc,{...previous,snapshot_date:null},mandate,'2026-10-08');
  const legacy = parse(doc);
  for (const snapshot of [native,legacy]) {
    assert.deepEqual(snapshot.holdings[0].batches.map(b=>[b.holding_days_min,b.holding_days_max]),[[7,59],[60,null]]);
    assert.ok(snapshot.holdings[0].batches.every(b=>!Object.hasOwn(b,'holding_days')));
    assert.equal(snapshot.holdings[0].first_holding_date,null);
    assert.deepEqual(snapshot.missing_execution_fields,[]);
    assert.deepEqual(createEditorDocument(snapshot).holdings[0].batches.map(b=>[b.holding_days_min,b.holding_days_max]),[[7,59],[60,null]]);
  }
  assert.match(legacy.holdings[0].notes,/持有>=60天/);
  for (const invalid of ['59-7','<0','>=2.5']) {
    doc.holdings[0].batches[0].holding_days = invalid;
    assert.throws(()=>parseEditorJson(doc,{...previous,snapshot_date:null},mandate,'2026-10-08'),/持有天数/);
    assert.throws(()=>parse(doc),/持有天数/);
  }
});

test('two day bounds validate open intervals, exact days, empty bounds and legacy migration', () => {
  for (const [batch,expected] of [
    [{holding_days_min:'7',holding_days_max:'59'},[7,59]],
    [{holding_days_min:'60',holding_days_max:''},[60,null]],
    [{holding_days_min:'',holding_days_max:'6'},[null,6]],
    [{holding_days_min:0,holding_days_max:0},[0,0]],
    [{holding_days_min:null,holding_days_max:null},[null,null]],
    [{holding_days:60},[60,60]],
    [{holding_days:'>60'},[61,null]],
    [{holding_days:'<7'},[null,6]]
  ]) {
    const bounds = normalizeHoldingDayBounds(batch);
    assert.deepEqual([bounds.holding_days_min,bounds.holding_days_max],expected);
  }
  for (const bounds of [[60,7],[-1,7],[1.5,7],['abc',7],[true,7],[0,Infinity],[0,9007199254740992]]) {
    assert.throws(()=>normalizeHoldingDayBounds({holding_days_min:bounds[0],holding_days_max:bounds[1]}),/持有天数/);
  }
  const doc = document();
  doc.holdings[0].batches=[{units:100,holding_days_min:60,holding_days_max:null,redemption_fee_pct:0}];
  const snapshot=parseEditorJson(doc,{...previous,snapshot_date:null},mandate,'2026-10-08');
  assert.deepEqual(snapshot.missing_execution_fields,[]);
  const reloaded=createEditorDocument(snapshot);
  reloaded.holdings[0].batches[0].holding_days_min=null;
  assert.deepEqual(parseEditorJson(reloaded,snapshot,mandate,'2026-10-08').missing_execution_fields,[doc.holdings[0].id]);
});
test('batch days and percent rates survive JSON conversion without invented start dates', () => {
  const doc = document(); doc.holdings[0].unit_nav = '1.2'; doc.holdings[0].nav_date = '2026-10-07';
  const snapshot = parse(doc);
  assert.equal(snapshot.holdings[0].units,100);
  assert.equal(snapshot.holdings[0].redeemable_units,100);
  assert.equal(snapshot.holdings[0].first_holding_date,null);
  assert.equal(snapshot.holdings[0].unit_nav,1.2);
  assert.equal(snapshot.holdings[0].batches_as_of,'2026-10-08');
  assert.equal(snapshot.holdings[0].batches[0].redemption_fee_pct,0.5);
  assert.equal(snapshot.holdings[0].batches[1].redemption_fee_pct,0);
  assert.deepEqual(snapshot.missing_execution_fields,[]);
  assert.equal(snapshot.fund_plus_available_cash_cny,4000);
  const csvOnly = parseSnapshotCsv(encodeCsv(editorRows(doc,snapshotHeaders)),snapshot,mandate,'2026-10-08');
  assert.deepEqual(csvOnly.holdings[0].batches,[]);
  assert.equal(csvOnly.holdings[0].unit_nav,null);
});
test('unknown fees stay unknown, incomplete batches and missing amounts are rejected', () => {
  const doc = document(); doc.holdings[0].batches[0].redemption_fee_pct = '';
  assert.equal(parse(doc).holdings[0].batches[0].redemption_fee_pct,null);
  assert.deepEqual(parse(doc).missing_execution_fields,[doc.holdings[0].id]);
  doc.holdings[0].batches[0].units = '';
  assert.throws(() => parse(doc),/批次份额/);
  const noAmount = document(); noAmount.cash.amount_cny = '';
  assert.throws(() => parse(noAmount),/可用现金不能为空/);
});
test('rates, days, formal NAV date and partial redeemability are checked', () => {
  const doc = document(); const h = doc.holdings[0];
  h.all_redeemable = false; h.redeemable_units = '40';
  assert.equal(parse(doc).holdings[0].redeemable_units,40);
  h.redeemable_units = '101'; assert.throws(() => parse(doc),/超过总份额/);
  h.redeemable_units = '40'; h.batches[0].holding_days = '2.5'; assert.throws(() => parse(doc),/天数须为整数/);
  h.batches[0].holding_days = '2'; h.batches[0].redemption_fee_pct = '101'; assert.throws(() => parse(doc),/费率须在/);
  h.batches[0].redemption_fee_pct = '0'; h.unit_nav = '1'; assert.throws(() => parse(doc),/净值日期/);
  h.nav_date = '2026-10-09'; assert.throws(() => parse(doc),/不能晚于/);
});
test('CLI JSON imports preserve source and structured batches and reject bad corrections', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(),'financing-editor-test-'));
  for (const dir of ['scripts','config','data/holdings']) await fs.mkdir(path.join(temp,dir),{recursive:true});
  for (const name of ['snapshot.mjs','lib.mjs','editor-core.mjs']) await fs.copyFile(new URL(`../scripts/${name}`,import.meta.url),path.join(temp,'scripts',name));
  await fs.writeFile(path.join(temp,'config/investment-mandate.json'),JSON.stringify(mandate));
  const statePath = path.join(temp,'data/holdings/current.json');
  await fs.writeFile(statePath,JSON.stringify({...previous,snapshot_date:null}));
  const doc = document(); doc.snapshot_date = new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Hong_Kong'});
  doc.holdings[0].batches[1].holding_days = '>=60天';
  const input = path.join(temp,'input.json'); const raw = JSON.stringify(doc);
  await fs.writeFile(input,raw);
  const run = () => promisify(execFile)(process.execPath,[path.join(temp,'scripts/snapshot.mjs'),'import','input.json'],{cwd:temp});
  await run(); const state = JSON.parse(await fs.readFile(statePath,'utf8'));
  assert.equal(state.schema_version,5); assert.equal(state.holdings[0].batches.length,2);
  assert.equal(state.holdings[0].batches[1].holding_days_min,60);
  assert.equal(state.holdings[0].batches[1].holding_days_max,null);
  assert.match(state.source_archive,/\.json$/);
  assert.equal(await fs.readFile(path.join(temp,state.source_archive),'utf8'),raw);
  const before = await fs.readFile(statePath,'utf8');
  doc.holdings[0].batches[0].redemption_fee_pct = 'bad'; await fs.writeFile(input,JSON.stringify(doc));
  await assert.rejects(run(),/赎回费率/);
  assert.equal(await fs.readFile(statePath,'utf8'),before);
});
