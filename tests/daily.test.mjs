import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReport, renderReport, loadBundle, runDaily } from '../scripts/daily.mjs';
import { sha256 } from '../scripts/lib.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const asOf = '2026-01-12';
const cutoff = '2026-01-12T14:00:00+08:00';
const targets = { cash: .15, pure_bond: .50, defensive_mixed: .10, china_broad: .06, us_broad: .07, nasdaq: .03, theme: .04, gold: .05 };
const flatRates = Object.fromEntries(Object.keys(targets).map(key => [key, 0]));
const clone = value => structuredClone(value);

function holding(overrides = {}) {
  return {
    id: 'holding-A', code: '000001', name: '测试纯债A', platform: '测试平台',
    category: 'bond', analysis_enabled: true, amount_cny: 100, holding_pnl_cny: 10,
    holding_return_pct: null, estimated_holding_return_pct: 11.111111,
    unit_nav: 1, nav_date: '2026-01-09', units: 100, redeemable_units: 100,
    all_redeemable: true, pending_buy_cny: 0, pending_redemption_receivable_cny: 0,
    batches: [{ batch_id: 1, units: 100, holding_days_min: 60, holding_days_max: null, redemption_fee_pct: 0 }],
    ...overrides
  };
}
function bundle() {
  return {
    schema_version: 1, as_of: asOf, cutoff, input_hash: 'fixture-input-hash',
    snapshot: {
      schema_version: 5, snapshot_date: asOf, imported_at: '2026-01-12T05:00:00Z', holdings: [holding()],
      strategy_cash: { amount_cny: 900, pending_buy_cny: 0, pending_redemption_receivable_cny: 0 },
      fund_total_cny: 100, fund_plus_available_cash_cny: 1000,
      pending_buy_total_cny: 0, pending_redemption_total_cny: 0
    },
    mandate: {
      strategy_version: 'test-v1', allowed_fund_codes: ['000001', '000002'], allocation_targets: targets,
      target_annual_net_return: .04, limits: { weekly_one_way: .05, minimum_trade_cny: 100 },
      return_scenarios: { conservative: flatRates, central: flatRates, optimistic: flatRates },
      stress_scenarios: { risk_off: flatRates, severe: flatRates }
    },
    ledger: {
      schema_version: 1, baseline: { date: '2026-01-01', total_cny: 1000, reconciled: true, status: 'confirmed' },
      valuations: [{ date: '2026-01-11', total_cny: 1000, reconciled: true }], events: [],
      external_flows_complete_since: '2026-01-01', pending_reconciled: true, execution_history_complete: true,
      dca: { status: 'all_stopped', plans: [] }
    },
    product_profiles: { profiles: { '000001': {
      bucket: 'pure_bond', kind: 'bond', stock_fraction: 0, bond_fraction: 1, convertible_fraction: 0,
      lookthrough_basis_date: '2025-09-30', lookthrough_published_at: '2025-10-31T12:00:00+08:00',
      redemption: { order: 'fifo' }, subscription: { status: 'unknown' }, notes: []
    } } },
    navs: { '000001': {
      series_kind: 'unit_nav', collected_at: '2026-01-12T05:00:00Z', official_crosscheck: 'verified',
      series: [{ date: '2026-01-08', unit_nav: 1 }, { date: '2026-01-09', unit_nav: 1 }]
    } },
    markets: {}, research: { as_of: asOf, market_events: [], limitations: [] },
    calendar: { complete: true, start_date: '2025-12-01', end_date: '2026-01-31', holidays: [] },
    collection_issues: [], code_hashes: {}
  };
}

async function fixture(t) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temporaryRoot, 'financing-daily-test-'));
  t.after(async () => {
    // Delete only the exact temporary directory created by this test.
    assert.equal(path.dirname(path.resolve(root)), temporaryRoot);
    assert.match(path.basename(root), /^financing-daily-test-/);
    await fs.rm(root, { recursive: true, force: true });
  });
  const b = bundle();
  const put = async (relative, value) => {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');
  };
  const editor = { format: 'financing-holdings-editor-v1', status: 'validated', snapshot_date: asOf, cash: b.snapshot.strategy_cash, holdings: b.snapshot.holdings };
  await put('每日持仓.json', editor);
  await put('data/holdings/current.json', b.snapshot);
  await put('config/investment-mandate.json', b.mandate);
  await put('config/product-profiles.json', b.product_profiles);
  await put('config/trading-calendar.json', b.calendar);
  await put('config/market-series.json', { series: [] });
  await put('data/account/ledger.json', b.ledger);
  await put(`data/research/${asOf}.json`, b.research);
  await put('data/normalized/nav/000001.json', b.navs['000001']);
  await fs.mkdir(path.join(root, 'scripts'), { recursive: true });
  for (const file of ['daily.mjs', 'portfolio-metrics.mjs', 'portfolio-strategy.mjs', 'lib.mjs', 'editor-core.mjs']) {
    await fs.copyFile(path.join(projectRoot, 'scripts', file), path.join(root, 'scripts', file));
  }
  return { root, put, editor, initial: b };
}

test('report uses the current user mandate instead of fixed personal objectives and fees', () => {
  const b = bundle();
  Object.assign(b.mandate, { target_annual_net_return: .06, investment_horizon_years_min: 8, risk_budget_drawdown_fraction: .12 });
  Object.assign(b.mandate.limits, { pure_bond_fund: .25, theme_direction: .03, cooldown_trading_days: 9, max_routine_redemption_fee_pct: .8 });
  const report = renderReport(buildReport(b));
  assert.match(report, /至少8年.*目标6.00%.*预算12.00%/);
  assert.match(report, /上限25.00%.*上限3.00%/);
  assert.match(report, /冷却9个交易日.*高于0.8%/);
  assert.match(report, /相对6.00%目标仍差6.000个百分点/);
  assert.doesNotMatch(report, /10月9日|4%目标|纯债-3%/);
});

test('report excludes future and untimed market evidence and future-collected economic series', () => {
  const b = bundle();
  const event = { date: asOf, title: '已公开证据', fact: '仅包含截止前事实', source_url: 'https://example.com/known', published_at: '2026-01-12T13:00:00+08:00' };
  b.research.market_events = [event,
    { ...event, title: '未来证据', published_at: '2026-01-12T15:00:00+08:00' },
    { ...event, title: '未知时间证据', published_at: null },
    { ...event, title: '未来日期证据', date: '2026-01-13' }
  ];
  b.markets.TEST = {
    name: '测试经济序列', unit: 'percent', collected_at: '2026-01-12T15:00:00+08:00',
    reference_url: 'https://example.com/series', series: [{ date: '2026-01-09', value: 999 }]
  };
  const report = buildReport(b), markdown = renderReport(report);
  assert.deepEqual(report.market_events.map(e => e.title), ['已公开证据']);
  assert.equal(report.market.TEST.available, false);
  assert.equal(report.market.TEST.value, null);
  assert.match(markdown, /已公开证据/);
  assert.doesNotMatch(markdown, /未来证据|未知时间证据|未来日期证据/);
});

test('new external capital increases asset amount without becoming investment profit', () => {
  const b = bundle();
  b.snapshot.strategy_cash.amount_cny += 300;
  b.snapshot.fund_plus_available_cash_cny += 300;
  b.ledger.valuations[0].total_cny = 1300;
  b.ledger.events.push({ id: 'external-300', date: '2026-01-06', type: 'external_deposit', amount_cny: 300, status: 'confirmed' });
  const report = buildReport(b);
  assert.equal(report.summary.total_cny, 1300);
  assert.equal(report.summary.holding_pnl_cny, 10);
  assert.equal(report.performance.net_external_flow_cny, 300);
  assert.equal(report.performance.return_fraction, 0);
  assert.equal(report.performance.annualized_return, null);
  assert.equal(report.performance.current_drawdown, null);
});

test('stale account valuation cannot classify current drawdown risk as normal', () => {
  const b = bundle();
  b.ledger.valuations[0].date = '2026-01-02';
  b.snapshot.holdings[0].amount_cny = 20;
  b.snapshot.holdings[0].unit_nav = .2;
  const report = buildReport(b);
  assert.equal(report.performance.return_fraction, 0, 'historical period return may remain available');
  assert.equal(report.strategy.summary.risk_state, 'unknown');
  assert.equal(report.strategy.summary.performance_drawdown, null);
});

test('unclassified holdings remain included in simulated post-trade asset totals', () => {
  const b = bundle();
  b.snapshot.holdings.push(holding({ id: 'unknown-holding', code: '000002', name: '尚未分类基金' }));
  const report = buildReport(b);
  assert.equal(report.summary.total_cny, 1100);
  assert.equal(report.conditional_after_sells.total_cny, 1100);
  assert.equal(report.scenarios.stress[0].current_return, null);
});

test('known redemption suspension defers selling despite available units and zero fees', () => {
  const b = bundle();
  b.snapshot.strategy_cash.amount_cny = 600;
  b.snapshot.holdings[0] = holding({ amount_cny: 400, units: 400, redeemable_units: 400,
    batches: [{ batch_id: 1, units: 400, holding_days_min: 60, holding_days_max: null, redemption_fee_pct: 0 }] });
  b.product_profiles.profiles['000001'].redemption = { order: 'fifo', status: 'suspended', verified_at: '2026-01-12T13:00:00+08:00' };
  const report = buildReport(b), sale = report.strategy.recommendations.find(r => r.direction === 'sell' && r.code === '000001');
  assert.ok(sale);
  assert.equal(sale.status, 'deferred');
});

test('settled actual trades consume weekly limits consistently with the performance ledger', () => {
  const b = bundle();
  b.ledger.events.push({ id: 'settled-buy', type: 'buy', direction: 'buy', code: '000001', date: asOf, status: 'settled', amount_cny: 10 });
  const report = buildReport(b);
  assert.equal(report.strategy.transition.weekly_confirmed_buy_cny, 10);
});

test('after-close report cannot label same-day fund applications ready', () => {
  const b = bundle();
  b.cutoff = '2026-01-12T17:00:00+08:00';
  b.snapshot.strategy_cash.amount_cny = 600;
  b.snapshot.holdings[0] = holding({ amount_cny: 400, units: 400, redeemable_units: 400,
    batches: [{ batch_id: 1, units: 400, holding_days_min: 60, holding_days_max: null, redemption_fee_pct: 0 }] });
  b.product_profiles.profiles['000001'].redemption = { order: 'fifo', status: 'open', verified_at: '2026-01-12T13:00:00+08:00' };
  const report = buildReport(b), sale = report.strategy.recommendations.find(r => r.direction === 'sell' && r.code === '000001');
  assert.ok(sale);
  assert.notEqual(sale.status, 'ready');
  assert.match(sale.conditions.join('；'), /截止|下一.*开放日|受理/);
});

test('identical frozen input yields identical structured and rendered reports without input mutation', () => {
  const b = bundle(), before = clone(b);
  const first = buildReport(b), second = buildReport(clone(b));
  assert.deepEqual(first, second);
  assert.equal(renderReport(first), renderReport(second));
  assert.deepEqual(b, before);
});

test('unknown holding profit remains unknown in summary and rendered report', () => {
  const b = bundle();
  b.snapshot.holdings[0].holding_pnl_cny = null;
  b.snapshot.holdings[0].estimated_holding_return_pct = null;
  const report = buildReport(b), markdown = renderReport(report);
  assert.equal(report.summary.holding_pnl_cny, null);
  assert.match(markdown, /持有收益合计[^\n]*未知/);
  assert.doesNotMatch(markdown, /持有收益合计\s*\*\*0\.00/);
});

test('partially missing holding profit does not silently become a complete sum', () => {
  const b = bundle();
  b.snapshot.holdings.push(holding({ id: 'holding-B', code: '000002', holding_pnl_cny: null, estimated_holding_return_pct: null }));
  b.product_profiles.profiles['000002'] = clone(b.product_profiles.profiles['000001']);
  b.navs['000002'] = clone(b.navs['000001']);
  const report = buildReport(b);
  assert.equal(report.summary.holding_pnl_cny, null);
  assert.equal(report.snapshot.holdings[0].holding_pnl_cny, 10);
  assert.equal(report.snapshot.holdings[1].holding_pnl_cny, null);
});

test('offline bundle loading is deterministic and frozen input hash matches payload', async t => {
  const { root } = await fixture(t);
  const options = { asOf, cutoff, offline: true };
  const first = await loadBundle(root, options), second = await loadBundle(root, options);
  assert.deepEqual(first, second);
  const { input_hash, ...input } = first;
  assert.equal(sha256(JSON.stringify(input)), input_hash);
  assert.equal(first.snapshot.snapshot_date, asOf);
});

test('previous report is strictly from an earlier day and ignores current-day and future reports', async t => {
  const { root, put } = await fixture(t);
  const reportStub = date => ({ as_of: date, input_hash: `hash-${date}`, strategy_version: 'test-v1', strategy: { recommendations: [] }, summary: { total_cny: 1000 } });
  await put('docs/reports/2026-01-08-daily.json', reportStub('2026-01-08'));
  await put('docs/reports/2026-01-09-daily.json', reportStub('2026-01-09'));
  await put('docs/reports/2026-01-12-daily.json', reportStub('2026-01-12'));
  await put('docs/reports/2026-01-13-daily.json', reportStub('2026-01-13'));
  const loaded = await loadBundle(root, { asOf, cutoff, offline: true });
  assert.equal(loaded.previous_report.as_of, '2026-01-09');
  assert.equal(loaded.previous_report.input_hash, 'hash-2026-01-09');
});

test('loadBundle rejects draft and mismatched snapshot dates', async t => {
  const { root, put, editor } = await fixture(t);
  await put('每日持仓.json', { ...editor, status: 'draft' });
  await assert.rejects(loadBundle(root, { asOf, cutoff, offline: true }), /草稿|保存并校验/);
  await put('每日持仓.json', { ...editor, snapshot_date: '2026-01-09' });
  await assert.rejects(loadBundle(root, { asOf, cutoff, offline: true }), /日期.*不一致/);
});

test('runDaily rejects invalid dates, timezone-free or mismatched cutoff and online historical collection', async t => {
  const { root } = await fixture(t);
  await assert.rejects(runDaily({ asOf: '2026-02-30', cutoff, offline: true }, root), /日期/);
  await assert.rejects(runDaily({ asOf, cutoff: '2026-01-12T14:00:00', offline: true }, root), /截止时间/);
  await assert.rejects(runDaily({ asOf, cutoff: '2026-01-13T14:00:00+08:00', offline: true }, root), /截止时间/);
  await assert.rejects(runDaily({ asOf, cutoff, offline: false }, root), /历史报告/);
});

test('archived inputs replay the same report and repeated daily runs do not recursively change the hash', async t => {
  const { root } = await fixture(t);
  const originalLedger = await fs.readFile(path.join(root, 'data/account/ledger.json'), 'utf8');
  const first = await runDaily({ asOf, cutoff, offline: true }, root);
  const frozenPath = path.join(first.relative, 'inputs.json');
  const frozen = JSON.parse(await fs.readFile(path.join(root, frozenPath), 'utf8'));
  const { input_hash, ...input } = frozen;
  assert.equal(sha256(JSON.stringify(input)), input_hash);
  const replay = await runDaily({ replay: frozenPath }, root);
  assert.deepEqual(replay.report, first.report);
  assert.equal(replay.markdown, first.markdown);
  const rerun = await runDaily({ asOf, cutoff, offline: true }, root);
  assert.equal(rerun.bundle.input_hash, first.bundle.input_hash);
  assert.equal(rerun.markdown, first.markdown);
  const valuationFiles = await fs.readdir(path.join(root, 'data/account/valuations'));
  assert.equal(valuationFiles.length, 1);
  const provisional = JSON.parse(await fs.readFile(path.join(root, 'data/account/valuations', valuationFiles[0]), 'utf8'));
  assert.equal(provisional.reconciled, false);
  assert.equal(provisional.status, 'provisional');
  assert.equal(provisional.total_cny, 1000);
  assert.equal(await fs.readFile(path.join(root, 'data/account/ledger.json'), 'utf8'), originalLedger);
});

test('replay cannot overwrite latest pointer or report from a later current input', async t => {
  const { root, editor, put } = await fixture(t);
  const first = await runDaily({ asOf, cutoff, offline: true }, root);
  const changedEditor = clone(editor);
  changedEditor.holdings[0].holding_pnl_cny = 12;
  await put('每日持仓.json', changedEditor);
  const later = await runDaily({ asOf, cutoff, offline: true }, root);
  assert.notEqual(first.bundle.input_hash, later.bundle.input_hash);
  const latestFile = path.join(root, `docs/reports/${asOf}-latest.json`);
  const currentFile = path.join(root, `docs/reports/${asOf}-daily.md`);
  const latest = await fs.readFile(latestFile, 'utf8'), current = await fs.readFile(currentFile, 'utf8');
  await runDaily({ replay: path.join(first.relative, 'inputs.json') }, root);
  assert.equal(await fs.readFile(latestFile, 'utf8'), latest);
  assert.equal(await fs.readFile(currentFile, 'utf8'), current);
});

test('replay rejects modified frozen inputs and changed code versions', async t => {
  const { root, put } = await fixture(t);
  const first = await runDaily({ asOf, cutoff, offline: true }, root);
  const relative = path.join(first.relative, 'inputs.json');
  const original = JSON.parse(await fs.readFile(path.join(root, relative), 'utf8'));
  await put(relative, { ...original, cutoff: '2026-01-12T13:00:00+08:00' });
  await assert.rejects(runDaily({ replay: relative }, root), /哈希不匹配/);
  await put(relative, original);
  await fs.appendFile(path.join(root, 'scripts/portfolio-metrics.mjs'), '\n// changed test version\n');
  await assert.rejects(runDaily({ replay: relative }, root), /版本已变化/);
});
