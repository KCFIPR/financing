import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTotalReturn, analyzeNav, correlations, calculatePerformance, stressPortfolio } from '../scripts/portfolio-metrics.mjs';

const close = (actual, expected, epsilon = 1e-10) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`);
const point = (date, unit_nav, corporate_action_note = null) => ({ date, unit_nav, corporate_action_note });
const nav = series => ({ series_kind: 'unit_nav', collected_at: '2026-10-16T08:00:00Z', series });
const today = { asOf: '2026-10-16', cutoff: '2026-10-16T17:00:00+08:00' };

test('unknown publication and capture time cannot establish indicators at a historical cutoff', () => {
  const result=analyzeNav({series_kind:'unit_nav',series:[point('2026-10-15',1),point('2026-10-16',1.01)]},today);
  assert.equal(result.status,'unavailable');
  assert.equal(result.returns['20'],null);
  assert(result.issues.includes('availability_timestamp_unknown'));
});

test('unresolved corporate action retains only labelled price observations, not total-return signals', () => {
  const result=analyzeNav(nav([point('2026-10-15',1),point('2026-10-16',.9,'分红：每10份派现金元')]),today);
  assert.equal(result.status,'unverified');
  assert.equal(result.price_basis,'unadjusted_unit_nav_only');
  assert.equal(result.price_series.at(-1).unit_nav,.9);
  assert.equal(result.returns['20'],null);
  assert.equal(result.volatility_annualized,null);
});

function dailySeries(count = 300, everyDays = 1) {
  let time = Date.parse('2025-01-01T00:00:00Z'), value = 1;
  return Array.from({ length: count }, (_, i) => {
    const date = new Date(time + i * everyDays * 86400_000).toISOString().slice(0, 10);
    value *= 1 + (i % 7 - 2) / 1000;
    return point(date, value);
  });
}
function ledger(overrides = {}) {
  return {
    schema_version: 1,
    baseline: { date: '2026-10-01', total_cny: 100_000, reconciled: true, status: 'confirmed' },
    external_flows_complete_since: '2026-10-01',
    valuations: [{ date: '2026-10-11', total_cny: 100_000, reconciled: true }],
    events: [], ...overrides
  };
}

test('cash distributions are reinvested once and per-ten-share distributions are scaled', () => {
  const result = buildTotalReturn(nav([
    point('2026-10-01', 1), point('2026-10-02', 0.9, '分红：每份派现金0.1元'),
    point('2026-10-03', 0.85, '分红：每10份派现金0.5元')
  ]));
  assert.equal(result.status, 'ok');
  close(result.series[1].value, 1);
  close(result.series[2].value, 1);
  assert.equal(result.verification, 'provider_data_not_independently_verified');
});

test('explicit forward and reverse splits maintain total-return continuity', () => {
  const result = buildTotalReturn(nav([
    point('2026-10-01', 2), point('2026-10-02', 1, '拆分比例：1:2'),
    point('2026-10-03', 2, '折算：每2份基金份额折算为1份'),
    point('2026-10-04', 1, '拆分：每份基金份额折算2份')
  ]));
  assert.equal(result.status, 'ok');
  for (const row of result.series) close(row.value, 1);
});

test('unrecognized corporate actions and cumulative NAV cannot supply total-return indicators', () => {
  for (const note of ['分红', '分红：每10份派现金元', '拆分：比例待确认', '分红：每份派现金0.1元；拆分比例1:2']) {
    const source = nav([point('2026-10-01', 1), point('2026-10-02', 0.5, note)]);
    const result = analyzeNav(source, today);
    assert.equal(result.status, 'unverified');
    assert.deepEqual(result.series, []);
    assert.equal(result.max_drawdown, null);
    assert.equal(result.returns['20'], null);
  }
  assert.equal(buildTotalReturn({ ...nav([point('2026-10-01', 2)]), series_kind: 'cumulative_nav' }).status, 'unverified');
});

test('invalid, duplicate and descending NAV dates fail closed', () => {
  for (const source of [
    nav([point('2026-02-30', 1)]), nav([point('2026-10-02', 1), point('2026-10-01', 1)]),
    nav([point('2026-10-01', 1), point('2026-10-01', 2)]), nav([point('2026-10-01', 0)])
  ]) assert.equal(analyzeNav(source, today).status, 'unverified');
});

test('NAV window returns require N+1 observations and sparse history has no daily annualized volatility', () => {
  const short = analyzeNav(nav(dailySeries(20)), today);
  assert.equal(short.returns['20'], null);
  assert.notEqual(short.ma20, null);
  assert.equal(short.ma60, null);
  assert.equal(short.volatility_annualized, null);
  const full = analyzeNav(nav(dailySeries()), today);
  assert.equal(full.status, 'ok');
  assert.notEqual(full.returns['252'], null);
  assert.ok(full.volatility_annualized > 0);
  assert.equal(full.annualization.sparse, false);
  const sparseSource = { ...nav(dailySeries(70, 7)), collected_at: '2026-10-16T08:00:00Z' };
  const sparse = analyzeNav(sparseSource, today);
  assert.equal(sparse.annualization.sparse, true);
  assert.equal(sparse.volatility_annualized, null);
});

test('current and maximum product drawdowns differ and use negative fractions', () => {
  const result = analyzeNav(nav([
    point('2026-10-01', 1), point('2026-10-02', 1.2), point('2026-10-03', 0.9), point('2026-10-04', 1.1)
  ]), today);
  close(result.max_drawdown, -0.25);
  close(result.drawdown_from_peak, 1.1 / 1.2 - 1);
});

test('future observations are truncated without using their corporate actions', () => {
  const source = nav([point('2026-10-15', 1), point('2026-10-16', 1.1), point('2026-10-17', 100, '未知行动')]);
  const result = analyzeNav(source, today);
  assert.equal(result.status, 'ok');
  assert.equal(result.data_date, '2026-10-16');
  assert.equal(result.observations, 2);
  close(result.series.at(-1).value, 1.1);
});

test('new downloads cannot be replayed at an earlier asOf even with a later explicit cutoff', () => {
  const source = nav([point('2026-10-01', 1), point('2026-10-10', 1.1)]);
  const result = analyzeNav(source, { asOf: '2026-10-10', cutoff: '2026-10-16T17:00:00+08:00' });
  assert.equal(result.status, 'unavailable');
  assert.match(result.issues.join(','), /collected_after_cutoff/);
});

test('intraday cutoff enforces publication availability and verified publication can enable historical replay', () => {
  const source = {
    ...nav([point('2026-10-15', 1)]),
    publication_at: '2026-10-16T16:00:00+08:00', publication_time_verified: true
  };
  assert.equal(analyzeNav(source, { asOf: '2026-10-16', cutoff: '2026-10-16T14:00:00+08:00' }).status, 'unavailable');
  source.publication_at = '2026-10-15T20:00:00+08:00';
  assert.equal(analyzeNav(source, { asOf: '2026-10-15', cutoff: '2026-10-15T22:00:00+08:00' }).status, 'ok');
  source.publication_time_verified = false;
  assert.equal(analyzeNav(source, { asOf: '2026-10-15' }).status, 'unavailable');
});

test('correlations align common-date intervals and require at least 60 returns', () => {
  const series = dailySeries(130).map(p => ({ date: p.date, value: p.unit_nav }));
  const sparse = series.filter((_, i) => i % 2 === 0);
  const [result] = correlations({ A: { status: 'ok', series }, B: { status: 'ok', series: sparse } });
  assert.equal(result.samples, 64);
  assert.equal(result.status, 'ok');
  close(result.correlation, 1);
  const [short] = correlations({ A: { status: 'ok', series }, B: { status: 'ok', series: sparse.slice(0, 60) } });
  assert.equal(short.samples, 59);
  assert.equal(short.correlation, null);
});

test('constant series correlation is unavailable instead of NaN', () => {
  const series = dailySeries(65).map(p => ({ date: p.date, value: 1 }));
  const [result] = correlations({ A: { status: 'ok', series }, B: { status: 'ok', series } });
  assert.equal(result.status, 'constant_series');
  assert.equal(result.correlation, null);
});

test('external deposit is not profit and date-only flows produce explicitly approximate Dietz returns', () => {
  const result = calculatePerformance(ledger({
    valuations: [{ date: '2026-10-11', total_cny: 130_000, reconciled: true }],
    events: [{ id: 'deposit1', date: '2026-10-06', type: 'external_deposit', status: 'confirmed', amount_cny: 30_000 }]
  }), today);
  assert.equal(result.status, 'approximate');
  assert.equal(result.method, 'modified_dietz');
  close(result.return_fraction, 0);
  assert.equal(result.net_external_flow_cny, 30_000);
  assert.equal(result.current_drawdown, null);
  assert.equal(result.annualized_return, null);
});

test('Modified Dietz weights a midperiod flow and withdrawal sign correctly', () => {
  const deposit = calculatePerformance(ledger({
    valuations: [{ date: '2026-10-11', total_cny: 141_500, reconciled: true }],
    events: [{ id: 'd', date: '2026-10-06', type: 'external_deposit', status: 'confirmed', amount_cny: 30_000 }]
  }), today);
  close(deposit.return_fraction, 0.1);
  const withdrawal = calculatePerformance(ledger({
    valuations: [{ date: '2026-10-11', total_cny: 70_000, reconciled: true }],
    events: [{ id: 'w', date: '2026-10-06', type: 'external_withdrawal', status: 'settled', amount_cny: 30_000 }]
  }), today);
  close(withdrawal.return_fraction, 0);
  assert.equal(withdrawal.net_external_flow_cny, -30_000);
});

test('internal trades, dividends and fees are not counted twice', () => {
  const result = calculatePerformance(ledger({
    valuations: [{ date: '2026-10-11', total_cny: 100_900, reconciled: true }],
    events: ['buy', 'sell', 'dividend', 'fee'].map((type, i) => ({
      id: `internal${i}`, date: '2026-10-05', type, status: 'confirmed', amount_cny: type === 'fee' ? 100 : 1_000
    }))
  }), today);
  assert.equal(result.status, 'ok');
  close(result.return_fraction, 0.009);
  assert.equal(result.net_external_flow_cny, 0);
});

test('exact pre-flow boundary valuations produce TWR independent of deposit size', () => {
  const result = calculatePerformance(ledger({
    valuations: [
      { at: '2026-10-06T12:00:00+08:00', total_cny: 110_000, flow_after_cny: 30_000, reconciled: true },
      { date: '2026-10-11', total_cny: 126_000, reconciled: true }
    ],
    events: [{ id: 'd', at: '2026-10-06T12:00:00+08:00', type: 'external_deposit', status: 'confirmed', amount_cny: 30_000 }]
  }), today);
  assert.equal(result.status, 'ok');
  assert.equal(result.method, 'time_weighted_return');
  close(result.return_fraction, -0.01);
  close(result.max_drawdown, 0.1);
  close(result.current_drawdown, 0.1);
});

test('TWR current drawdown recovers without erasing historical maximum', () => {
  const result = calculatePerformance(ledger({ valuations: [
    { date: '2026-10-04', total_cny: 110_000, reconciled: true },
    { date: '2026-10-07', total_cny: 88_000, reconciled: true },
    { date: '2026-10-11', total_cny: 104_500, reconciled: true }
  ] }), today);
  close(result.max_drawdown, 0.2);
  close(result.current_drawdown, 0.05);
});

test('boundary cash-flow metadata must match confirmed events', () => {
  const result = calculatePerformance(ledger({
    valuations: [
      { at: '2026-10-06T12:00:00+08:00', total_cny: 100_000, flow_after_cny: 50_000, reconciled: true },
      { date: '2026-10-11', total_cny: 130_000, reconciled: true }
    ],
    events: [{ id: 'd', date: '2026-10-06', type: 'external_deposit', status: 'confirmed', amount_cny: 30_000 }]
  }), today);
  assert.equal(result.status, 'unavailable');
  assert.match(result.issues.join(','), /flow_boundary/);
});

test('unreconciled or incomplete account data blocks performance', () => {
  const cases = [
    ledger({ baseline: { date: '2026-10-01', total_cny: 100_000, reconciled: false } }),
    ledger({ external_flows_complete_since: null }),
    ledger({ valuations: [{ date: '2026-10-11', total_cny: 130_000, reconciled: false }] }),
    ledger({ events: [{ id: 'd', date: null, type: 'external_deposit', status: 'confirmed', amount_cny: 30_000 }] }),
    ledger({ events: [{ id: 'd', date: '2026-10-05', type: 'external_deposit', status: 'unknown', amount_cny: 30_000 }] })
  ];
  for (const value of cases) {
    const result = calculatePerformance(value, today);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.return_fraction, null);
    assert.equal(result.current_drawdown, null);
  }
});

test('unknown historical cash-flow date already included in baseline does not block future measurement', () => {
  const source = ledger({
    baseline: { date: '2026-10-16', total_cny: 324_447.12, reconciled: true },
    external_flows_complete_since: undefined, cashflows_complete_since: '2026-10-16',
    valuations: [{ date: '2026-10-17', total_cny: 324_447.12, reconciled: true }],
    events: [{ id: 'historical', date: null, type: 'external_deposit', status: 'confirmed', amount_cny: 30_000,
      occurred_between: { after: '2026-10-09', on_or_before: '2026-10-16' }, accounted_in_baseline: true }]
  });
  const result = calculatePerformance(source, { asOf: '2026-10-17' });
  assert.equal(result.status, 'ok');
  close(result.return_fraction, 0);
  source.events[0].accounted_in_baseline = false;
  assert.equal(calculatePerformance(source, { asOf: '2026-10-17' }).status, 'unavailable');
});

test('pending instructions do not become executed cash flows', () => {
  const result = calculatePerformance(ledger({ events: [
    { id: 'planned', date: null, type: 'external_deposit', status: 'planned', amount_cny: 30_000 }
  ] }), today);
  assert.equal(result.status, 'ok');
  close(result.return_fraction, 0);
});

test('performance truncates valuations and events after cutoff', () => {
  const source = ledger({
    valuations: [
      { date: '2026-10-05', total_cny: 101_000, reconciled: true },
      { date: '2026-10-12', total_cny: 500_000, reconciled: true }
    ],
    events: [{ id: 'later', date: '2026-10-12', type: 'external_deposit', status: 'confirmed', amount_cny: 399_000 }]
  });
  const result = calculatePerformance(source, { asOf: '2026-10-16', cutoff: '2026-10-06T14:00:00+08:00' });
  assert.equal(result.end_date, '2026-10-05');
  close(result.return_fraction, 0.01);
});

test('account annualization is unavailable under a year and disclosed after 365 days', () => {
  const source = ledger({
    baseline: { date: '2025-10-01', total_cny: 100_000, reconciled: true },
    external_flows_complete_since: '2025-10-01',
    valuations: [{ date: '2026-10-01', total_cny: 104_000, reconciled: true }]
  });
  const result = calculatePerformance(source, today);
  assert.equal(result.days, 365);
  close(result.annualized_return, 0.04);
});

test('stress scenarios preserve weights and identify assumptions without asserting a maximum loss', () => {
  const result = stressPortfolio([{ key: 'cash' }, { key: 'equity' }], { cash: 0.8, equity: 0.2 }, { cash: 0, equity: -0.3 });
  close(result.return_fraction, -0.06);
  assert.match(result.basis, /not_maximum_loss/);
  assert.throws(() => stressPortfolio([{ key: 'cash' }], { cash: 0.8 }, { cash: 0 }), /sum to one/);
});
