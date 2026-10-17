import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { parseFund, parseFred, parseHoldings, validateSnapshot, staleness, reconcileCorporateActions } from '../scripts/lib.mjs';

import { markdown } from './fixtures/holdings.mjs';
const sample = code => `var fS_code="${code}"; var fS_name="测试基金"; var Data_netWorthTrend=[{"x":1704038400000,"y":1.2,"equityReturn":0,"unitMoney":"分红"},{"x":1704124800000,"y":1.1}];`;
test('import preserves independent cross-platform holdings and reviewed totals', async () => {
  const holdings = parseHoldings(markdown);
  assert.deepEqual(validateSnapshot({ snapshot_date: null, holdings }), { count: 25, codes: 21, total_cny: 25000 });
  assert.equal(holdings.filter(h => h.code === '000120').length, 3);
  assert.equal(holdings.find(h => h.id === 'B01').code_confirmed_by_user, false);
});
test('NAV dates use China calendar and do not claim adjusted returns', () => {
  const result = parseFund(sample('420002'), '420002');
  assert.equal(result.series[0].date, '2024-01-01');
  assert.equal(result.series[0].corporate_action_note, '分红');
  assert.equal(result.adjusted_for_distributions, false);
  assert.equal(result.publication_date, null);
});
test('reject wrong code, empty, duplicate timestamps, and non-JSON payload', () => {
  assert.throws(() => parseFund(sample('000032'), '420002'), /mismatch/);
  assert.throws(() => parseFund(sample('420002').replace(/\[\{.*\}\]/, '[]'), '420002'), /Empty/);
  assert.throws(() => parseFund(sample('420002').replace('1704124800000', '1704038400000'), '420002'), /unordered/);
  assert.throws(() => parseFund(sample('420002').replace('"420002"', '(globalThis.compromised = true)'), '420002'));
  assert.equal(globalThis.compromised, undefined);
});
test('stale/future dates are explicit', () => {
  const now = new Date('2026-10-02T12:00:00Z');
  assert.equal(staleness('2026-09-01', now).state, 'stale');
  assert.equal(staleness('2026-10-10', now).state, 'future');
  assert.equal(staleness('2026-10-01', now).state, 'recent');
});
test('FRED missing values stay null and negative real yields remain valid', () => {
  assert.deepEqual(parseFred('observation_date,DFII10\n2024-01-01,.\n2024-01-02,-0.5\n', 'DFII10'), [{ date: '2024-01-01', value: null }, { date: '2024-01-02', value: -0.5 }]);
  assert.throws(() => parseFred('observation_date,DGS10\n2024-01-01,5', 'DFII10'), /header/);
  assert.throws(() => parseFred('DATE,DFII10\n2024-01-01,\n', 'DFII10'), /Empty/);
});

test('money market income remains income and cannot masquerade as unit NAV', () => {
  const raw='var fS_code="000640"; var fS_name="货币基金"; var Data_millionCopiesIncome=[[1704038400000,"0.35"],[1704124800000,0.36]]; var Data_sevenDaysYearIncome=[[1704038400000,1.2]];';
  const n=parseFund(raw,'000640');
  assert.equal(n.series_kind,'money_market_income');
  assert.equal(n.series[0].income_per_10000_cny,.35);
  assert.equal(n.series[0].seven_day_annualized_pct,1.2);
  assert.equal(n.series[1].seven_day_annualized_pct,null);
  assert.equal(n.series[0].unit_nav,undefined);
});

test('restore a missing dividend only from unambiguous matching archived evidence', () => {
  const current={code:'420002',series:[{date:'2024-01-01',unit_nav:1.2,corporate_action_note:'分红：每10份派现金元'}]};
  const archive={...structuredClone(current),sha256:'checked-raw-hash',raw_file:'data/raw/x',collected_at:'2024-01-02T00:00:00Z'};
  archive.series[0].corporate_action_note='分红：每10份派现金0.5元';
  const n=reconcileCorporateActions(current,[archive]);
  assert.equal(n.series[0].corporate_action_note,archive.series[0].corporate_action_note);
  assert.equal(n.series[0].corporate_action_source.source_sha256,'checked-raw-hash');
  assert.equal(n.corporate_action_reconciliation.length,1);
  assert.equal(current.series[0].corporate_action_note,'分红：每10份派现金元');
  for(const mismatch of [{...archive,code:'000032'},{...archive,series:[{...archive.series[0],unit_nav:1.21}]},{...archive,series:[{...archive.series[0],date:'2024-01-02'}]}]){
    assert.equal(reconcileCorporateActions(current,[mismatch]).corporate_action_reconciliation.length,0);
  }
  const conflicting={...archive,series:[{...archive.series[0],corporate_action_note:'分红：每10份派现金0.6元'}]};
  assert.equal(reconcileCorporateActions(current,[archive,conflicting]).corporate_action_reconciliation.length,0);
  const absent={code:'420002',series:[{date:'2024-01-01',unit_nav:1.2,corporate_action_note:null}]};
  assert.equal(reconcileCorporateActions(absent,[archive]).series[0].corporate_action_note,null);
});
