import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzePortfolio, inspectBatches, estimateRedemption, countTradingDays } from '../scripts/portfolio-strategy.mjs';

const asOf = '2026-10-16';
const holding = (overrides = {}) => ({ id: 'H1', code: '000001', name: 'test', amount_cny: 10000, units: 10000, redeemable_units: 10000, unit_nav: 1, nav_date: '2026-10-15', pending_buy_cny: 0, holding_pnl_cny: -1000, batches: [{ batch_id: 1, units: 10000, holding_days_min: 60, holding_days_max: null, redemption_fee_pct: 0 }], ...overrides });
const profile = (bucket = 'theme', extra = {}) => ({ bucket, exposure_group: 'index-a', theme_direction: 'robot', dealing: { cutoff_time: '15:00', timezone: 'Asia/Hong_Kong', verified_at: '2026-10-01T10:00:00+08:00', source_url: 'https://issuer.example/dealing' }, redemption: { order: 'fifo', status: 'open', verified_at: '2026-10-15T10:00:00+08:00', source_url: 'https://issuer.example/rules' }, subscription: { status: 'open', fee_pct: 0, verified_at: '2026-10-15T10:00:00+08:00' }, ...extra });
function args(overrides = {}) {
  return { snapshot: { snapshot_date: asOf, holdings: [holding()], strategy_cash: { amount_cny: 90000, pending_buy_cny: 0 }, pending_buy_total_cny: 0 }, profiles: { '000001': profile() }, ledger: { execution_history_complete: true, dca: { status: 'none', plans: [] }, baseline: { reconciled: true }, events: [] }, asOf, cutoff: `${asOf}T14:00:00+08:00`, ...overrides };
}

test('uses reported current values and never adds pending assets or treats holding loss as drawdown', () => {
  const input = args(); input.snapshot.holdings[0].pending_redemption_receivable_cny = 1234;
  input.snapshot.pending_redemption_total_cny = 1234;
  const output = analyzePortfolio(input);
  assert.equal(output.summary.total_cny, 100000);
  assert.equal(output.summary.performance_drawdown, null);
  assert.equal(output.summary.risk_state, 'unknown');
  assert.equal(output.summary.holding_pnl_cny, -1000);
  assert.equal(input.ledger.events.length, 0);
  assert.equal(input.snapshot.holdings[0].amount_cny, 10000);
});

test('closed interval endpoints overlap; a one-sided interval includes its finite boundary', () => {
  const h = holding({ batches: [{ batch_id: 1, units: 5000, holding_days_min: 30, holding_days_max: 364, redemption_fee_pct: .1 }, { batch_id: 2, units: 5000, holding_days_min: 364, holding_days_max: 729, redemption_fee_pct: .05 }] });
  assert(inspectBatches(h).some(i => i.code === 'overlapping_holding_intervals'));
  const fee = estimateRedemption(h, profile(), 2000);
  assert.equal(fee.fee_estimate_cny, null);
  assert.deepEqual(fee.batches, []);
  h.batches[1].holding_days_min = 365;
  assert(!inspectBatches(h).some(i => i.code === 'overlapping_holding_intervals'));
});

test('FIFO chooses oldest known interval and charges only touched batches', () => {
  const h = holding({ batches: [{ batch_id: 1, units: 6000, holding_days_min: 0, holding_days_max: 6, redemption_fee_pct: 1.5 }, { batch_id: 2, units: 3000, holding_days_min: 7, holding_days_max: 29, redemption_fee_pct: .5 }, { batch_id: 3, units: 1000, holding_days_min: 30, holding_days_max: null, redemption_fee_pct: 0 }] });
  assert.equal(estimateRedemption(h, profile(), 1500).fee_estimate_cny, 2.5);
  assert.deepEqual(estimateRedemption(h, profile(), 1500).batches.map(b => b.batch_id), [3, 2]);
  h.batches[2].redemption_fee_pct = null;
  assert.equal(estimateRedemption(h, profile(), 500).fee_estimate_cny, null);
  assert.equal(estimateRedemption(h, { redemption: { order: 'unknown' } }, 500).fee_estimate_cny, null);
});

test('same exposure is merged across codes and platforms before concentration caps', () => {
  const input = args();
  input.snapshot.holdings = [holding({ id: 'a', amount_cny: 1500, units: 1500, redeemable_units: 1500, batches: [{ units: 1500, holding_days_min: 60, redemption_fee_pct: 0 }] }), holding({ id: 'b', code: '000002', platform: 'other', amount_cny: 1500, units: 1500, redeemable_units: 1500, batches: [{ units: 1500, holding_days_min: 60, redemption_fee_pct: 0 }] })];
  input.snapshot.strategy_cash.amount_cny = 97000;
  input.profiles['000002'] = profile();
  const result = analyzePortfolio(input);
  assert(result.issues.some(i => i.code === 'concentration_limit'));
  assert.equal(result.lookthrough.exposure_groups.length, 1);
  assert.equal(result.lookthrough.exposure_groups[0].amount_cny, 3000);
  assert.equal(result.recommendations.filter(r => r.direction === 'sell').reduce((s, r) => s + r.amount_cny, 0), 1000);
});

test('money fund erroneous NAV is not used for valuation mismatch or redemption price', () => {
  const input = args(); input.profiles['000001'] = profile('cash', { kind: 'money_market' });
  input.snapshot.holdings[0].unit_nav = .888;
  const result = analyzePortfolio(input);
  assert(!result.holdings[0].issues.some(i => i.code === 'holding_value_unreconciled'));
  assert.equal(result.allocation.find(a => a.bucket === 'cash').amount_cny, 100000);
  assert.equal(estimateRedemption(input.snapshot.holdings[0], input.profiles['000001'], 1000).units_estimate, null);
});

test('weekly buy and sell budgets are independent and only confirmed actual trades count', () => {
  const input = args();
  input.ledger.events = [{ id: 'one', type: 'buy', status: 'confirmed', date: '2026-10-12', code: 'other', amount_cny: 4000 }, { id: 'two', type: 'sell', status: 'confirmed', date: '2026-10-12', code: 'other', amount_cny: 2000 }, { id: 'proposal', type: 'sell', status: 'recommended', date: '2026-10-16', amount_cny: 90000 }, { id: 'capital', type: 'external_deposit', status: 'confirmed', date: '2026-10-12', amount_cny: 30000 }];
  const result = analyzePortfolio(input);
  assert.equal(result.transition.buy_budget_before_proposals_cny, 1000);
  assert.equal(result.transition.sell_budget_before_proposals_cny, 3000);
  assert.equal(result.transition.proposed_sell_cny, 3000);
  assert.equal(result.summary.total_cny, 100000);
});

test('calendar holidays count correctly and proposals never start a cooldown', () => {
  const calendar = { holidays: ['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07'], complete: true };
  assert.deepEqual(countTradingDays('2026-09-30', '2026-10-09', calendar), { count: 2, verified: true });
  const input = args({ asOf: '2026-10-09', calendar });
  input.snapshot.snapshot_date = '2026-10-09';
  input.snapshot.holdings[0].nav_date = '2026-10-08';
  input.ledger.events = [{ id: 'prior', type: 'sell', status: 'confirmed', date: '2026-09-30', code: '000001', amount_cny: 100 }];
  assert.equal(analyzePortfolio(input).recommendations[0].status, 'deferred');
  input.ledger.events[0].status = 'recommended';
  assert.notEqual(analyzePortfolio(input).recommendations[0].status, 'deferred');
});

test('unverified calendar prevents ready even after estimated cooldown elapsed', () => {
  const input = args(); input.ledger.events = [{ type: 'sell', status: 'confirmed', date: '2026-10-01', code: '000001', amount_cny: 100 }];
  const rec = analyzePortfolio(input).recommendations[0];
  assert.equal(rec.status, 'conditional');
  assert(rec.conditions.some(c => c.includes('日历')));
});

test('high redemption fees defer ordinary sale without consuming another candidate budget', () => {
  const input = args(); input.snapshot.holdings[0].batches[0].redemption_fee_pct = 1.5;
  const result = analyzePortfolio(input);
  assert.equal(result.recommendations[0].status, 'deferred');
  assert.equal(result.transition.proposed_sell_cny, 0);
  assert(result.recommendations[0].cost_comparison.redeem_now_fee_cny > 0);
});

test('risk freeze uses cash-flow adjusted drawdown only; emergency exception remains explicit', () => {
  const input = args(); input.ledger.performance = { drawdown: .10 };
  input.snapshot.holdings[0].batches[0].redemption_fee_pct = 1.5;
  const result = analyzePortfolio(input);
  assert.equal(result.summary.risk_state, 'breach');
  assert.equal(result.recommendations[0].emergency_override, true);
  assert.equal(result.recommendations[0].status, 'conditional');
  assert.equal(result.holdings[0].dca_action, 'pause');
});

test('pending unknown and unlisted DCA prevent ready purchases; known orders reserve once', () => {
  const input = args(); input.profiles['000001'] = profile('pure_bond');
  input.snapshot.pending_buy_total_cny = null; input.snapshot.holdings[0].pending_buy_cny = null;
  input.ledger.dca = { status: 'partial_active_unlisted', plans: [] };
  const result = analyzePortfolio(input);
  assert.equal(result.recommendations[0].status, 'conditional');
  assert(result.transition.cash.pending_unknown);
  input.ledger.pending_reconciled = true;
  input.ledger.events = [{ id: 'pending', type: 'buy', status: 'pending', code: 'another', amount_cny: 2000, cash_basis: 'already_deducted' }];
  assert.equal(analyzePortfolio(input).transition.cash.pending_reserved_cny, 0);
  input.ledger.events[0].cash_basis = 'included_in_snapshot_cash';
  input.ledger.events.push({ ...input.ledger.events[0] });
  assert.equal(analyzePortfolio(input).transition.cash.pending_reserved_cny, 2000);
});

test('confirmed subscription limit caps daily proposed amount and suspended fund is deferred', () => {
  const input = args(); input.profiles['000001'] = profile('us_broad', { subscription: { status: 'limited', daily_limit_cny: 100, fee_pct: .1, verified_at: '2026-10-15T08:00:00+08:00' } });
  input.snapshot.holdings[0].amount_cny = 100; input.snapshot.strategy_cash.amount_cny = 99900;
  let result = analyzePortfolio(input);
  assert.equal(result.recommendations[0].amount_cny, 100);
  assert(result.recommendations[0].fee_estimate_cny > 0);
  input.profiles['000001'].subscription.status = 'suspended';
  result = analyzePortfolio(input);
  assert.equal(result.recommendations[0].status, 'deferred');
  assert.equal(result.transition.proposed_buy_cny, 0);
});

test('single pure bond fund cap limits filling the 50 percent asset bucket', () => {
  const input = args(); input.profiles['000001'] = profile('pure_bond');
  input.snapshot.holdings[0].amount_cny = 19500; input.snapshot.strategy_cash.amount_cny = 80500;
  const result = analyzePortfolio(input);
  assert.equal(result.recommendations[0].amount_cny, 500);
  assert(result.issues.some(i => i.code === 'allocation_gap_unfilled'));
});

test('unknown lookthrough remains unknown; no simple assumption fills missing stock share', () => {
  const input = args(); input.profiles['000001'] = profile('defensive_mixed', { bond_fraction: .8 });
  const result = analyzePortfolio(input);
  assert.equal(result.lookthrough.components.stock.unknown_fund_amount_cny, 10000);
  assert.equal(result.lookthrough.components.stock.complete, false);
  assert.equal(result.lookthrough.components.bond.known_amount_cny, 8000);
});

test('same-month small drift does not cause a rebalance and input replay is deterministic', () => {
  const input = args(); input.ledger.last_rebalance_date = '2026-10-02';
  input.profiles['000001'] = profile('china_broad');
  input.snapshot.holdings[0].amount_cny = 5900; input.snapshot.strategy_cash.amount_cny = 94100;
  const before = JSON.stringify(input);
  const a = analyzePortfolio(input), b = analyzePortfolio(input);
  assert.equal(a.recommendations.length, 0);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(input), before);
});

test('same fund across two platforms cannot multiply daily subscription limit', () => {
  const input = args();
  input.profiles['000001'] = profile('us_broad', { subscription: { status: 'limited', daily_limit_cny: 100, fee_pct: 0, verified_at: '2026-10-16T08:00:00+08:00' } });
  input.snapshot.holdings = [holding({ id: 'first', amount_cny: 100 }), holding({ id: 'second', amount_cny: 100, platform: 'second' })];
  input.snapshot.strategy_cash.amount_cny = 99800;
  const result = analyzePortfolio(input);
  assert.equal(result.transition.proposed_buy_cny, 100);
  assert.equal(result.recommendations.filter(r => r.direction === 'buy' && r.status !== 'deferred').length, 1);
});

test('different funds in same theme direction share the direction cap on new purchases', () => {
  const input = args();
  input.profiles['000002'] = profile('theme', { exposure_group: 'index-b' });
  input.snapshot.holdings = [holding({ id: 'first', amount_cny: 500 }), holding({ id: 'second', code: '000002', amount_cny: 500 })];
  input.snapshot.strategy_cash.amount_cny = 99000;
  const result = analyzePortfolio(input);
  assert.equal(result.transition.proposed_buy_cny, 1000);
});

test('leveraged bond exposure is preserved and future disclosure is excluded', () => {
  const input = args(); input.profiles['000001'] = profile('defensive_mixed', { bond_fraction: 1.2, lookthrough_basis_date: '2026-06-30' });
  assert.equal(analyzePortfolio(input).lookthrough.components.bond.known_amount_cny, 12000);
  input.profiles['000001'].lookthrough_published_at = '2026-10-17T09:00:00+08:00';
  assert.equal(analyzePortfolio(input).lookthrough.components.bond.unknown_fund_amount_cny, 10000);
});

test('sales do not finance same-report purchases before proceeds arrive', () => {
  const input = args();
  input.snapshot.holdings = [holding({ id: 'risk', amount_cny: 97000, units: 97000, redeemable_units: 97000, batches: [{ units: 97000, holding_days_min: 60, redemption_fee_pct: 0 }] }), holding({ id: 'bond', code: '000002', amount_cny: 1000 })];
  input.snapshot.strategy_cash.amount_cny = 2000;
  input.profiles['000002'] = profile('pure_bond', { exposure_group: 'bond' });
  const result = analyzePortfolio(input);
  assert(result.transition.proposed_sell_cny > 0);
  assert.equal(result.transition.proposed_buy_cny, 0);
});

test('explicit closed trading day defers orders and a future snapshot is rejected', () => {
  const input = args({ calendar: { complete: true, holidays: ['2026-10-16'] } });
  assert.equal(analyzePortfolio(input).recommendations[0].status, 'deferred');
  input.asOf = '2026-10-15';
  assert.throws(() => analyzePortfolio(input), /Snapshot is later/);
});

test('uniform batch fees can be costed without inventing an unverified redemption order', () => {
  const h = holding();
  const result = estimateRedemption(h, { redemption: { order: 'unknown' } }, 1000);
  assert.equal(result.fee_estimate_cny, 0);
  assert.equal(result.fee_max_pct, 0);
  assert.deepEqual(result.batches, []);
  assert(result.conditions.some(c => c.includes('先进先出')));
});

test('complete mainland calendar cannot certify QDII dealing days or cooldown', () => {
  const input = args({ calendar: { complete: true, start_date: '2026-01-01', end_date: '2026-12-31', holidays: [] } });
  input.profiles['000001'] = profile('nasdaq', { kind: 'qdii_equity_index', subscription: { status: 'open', fee_pct: 0, verified_at: '2026-10-16T08:00:00+08:00', source_url: 'https://issuer.example/subscribe' } });
  input.snapshot.holdings[0].amount_cny = 1000; input.snapshot.strategy_cash.amount_cny = 99000;
  input.ledger.events = [{ id: 'last-buy', direction: 'buy', status: 'confirmed', date: '2026-10-08', code: '000001', amount_cny: 100 }];
  const result = analyzePortfolio(input), buy = result.recommendations.find(r => r.direction === 'buy');
  assert.equal(buy.status, 'conditional');
  assert(buy.conditions.some(c => c.includes('QDII')));
  assert(buy.conditions.some(c => c.includes('冷却期使用工作日近似')));
  input.calendar.by_code = { '000001': { complete: true, start_date: '2026-01-01', end_date: '2026-12-31', holidays: [] } };
  assert.equal(analyzePortfolio(input).recommendations.find(r => r.direction === 'buy').status, 'ready');
});

test('270042 suspended subscription never proposes executable money or an increase direction', () => {
  const input = args({ calendar: { complete: true, holidays: [] } });
  input.snapshot.holdings[0].code = '270042';
  input.snapshot.holdings[0].amount_cny = 1000; input.snapshot.strategy_cash.amount_cny = 99000;
  input.profiles = { '270042': profile('nasdaq', { subscription: { status: 'suspended', daily_limit_cny: null, fee_pct: 0, verified_at: '2026-10-16T08:00:00+08:00', source_url: 'https://issuer.example/suspended' } }) };
  const result = analyzePortfolio(input), buy = result.recommendations.find(r => r.direction === 'buy');
  assert.equal(buy.status, 'deferred');
  assert.equal(buy.amount_cny, 0);
  assert.equal(result.transition.proposed_buy_cny, 0);
  assert.equal(result.holdings[0].direction, 'hold');
  assert.equal(result.holdings[0].dca_action, 'pause');
});

test('untraceable or stale batch redemption rules cannot produce ready sales', () => {
  const input = args({ calendar: { complete: true, holidays: [] } });
  input.snapshot.holdings[0].batches_as_of = asOf;
  assert.equal(analyzePortfolio(input).recommendations[0].status, 'ready');
  delete input.profiles['000001'].redemption.source_url;
  assert.equal(analyzePortfolio(input).recommendations[0].status, 'conditional');
  input.profiles['000001'].redemption.source_url = 'https://issuer.example/rules';
  input.snapshot.holdings[0].batches_as_of = '2026-10-15';
  assert.equal(analyzePortfolio(input).recommendations[0].status, 'conditional');
});

test('all actual trade states consume budgets and trigger cooldown; advice still does not', () => {
  for (const status of ['confirmed', 'completed', 'settled', 'executed', 'reconciled']) {
    const input = args({ calendar: { complete: true, holidays: [] } });
    input.ledger.events = [{ id: status, direction: 'sell', type: 'sell', status, date: '2026-10-15', code: '000001', amount_cny: 1000 }];
    const result = analyzePortfolio(input);
    assert.equal(result.transition.weekly_confirmed_sell_cny, 1000, status);
    assert.equal(result.transition.sell_budget_before_proposals_cny, 4000, status);
    assert.equal(result.recommendations[0].status, 'deferred', status);
  }
});

test('verified passed cutoff and unknown cutoff both prevent ready recommendations', () => {
  const input = args({ calendar: { complete: true, holidays: [] } });
  input.snapshot.holdings[0].batches_as_of = asOf;
  assert.equal(analyzePortfolio(input).recommendations[0].status, 'ready');
  input.cutoff = `${asOf}T16:59:00+08:00`;
  const after = analyzePortfolio(input).recommendations[0];
  assert.equal(after.status, 'conditional');
  assert(after.conditions.some(c => c.includes('下一个基金开放日')));
  assert(after.amount_cny > 0);
  input.cutoff = `${asOf}T14:00:00+08:00`;
  delete input.profiles['000001'].dealing;
  const unknown = analyzePortfolio(input).recommendations[0];
  assert.equal(unknown.status, 'conditional');
  assert(unknown.conditions.some(c => c.includes('截止时间尚未核验')));
});

test('redemption suspension prevents sales without consuming the weekly sell budget', () => {
  const input = args({ calendar: { complete: true, holidays: [] } });
  input.snapshot.holdings[0].batches_as_of = asOf;
  input.profiles['000001'].redemption.status = 'suspended';
  const result = analyzePortfolio(input);
  assert.equal(result.recommendations[0].status, 'deferred');
  assert.equal(result.transition.proposed_sell_cny, 0);
  assert(result.recommendations[0].conditions.some(c => c.includes('暂停赎回')));
});

test('precise future trade timestamps never consume the current cutoff budget', () => {
  const input = args();
  input.ledger.events = [{ id: 'future-time', type: 'buy', status: 'executed', date: asOf, at: `${asOf}T16:00:00+08:00`, code: 'other', amount_cny: 500 }];
  assert.equal(analyzePortfolio(input).transition.weekly_confirmed_buy_cny, 0);
});

test('FIFO documentation cannot stand in for verified current redemption availability', () => {
  const input = args({ calendar: { complete: true, holidays: [] } });
  input.snapshot.holdings[0].batches_as_of = asOf;
  delete input.profiles['000001'].redemption.status;
  const sale = analyzePortfolio(input).recommendations[0];
  assert.equal(sale.status, 'conditional');
  assert(sale.conditions.some(c => c.includes('当前开放赎回')));
});
