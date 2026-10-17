// Pure calculations. Returns are fractions, not percentage points. No network or file I/O.
const DAY = 86_400_000;
const WINDOWS = [20, 60, 120, 252];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const positive = value => finite(value) && value > 0;
const near = (a, b) => Math.abs(a - b) <= Math.max(0.011, Math.abs(b) * 1e-9);

function validDate(value) {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
function dateOf(value) {
  if (validDate(value)) return value;
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? new Date(time + 8 * 3600_000).toISOString().slice(0, 10) : null;
}
function timeOf(value, endOfDay = true) {
  if (validDate(value)) return Date.parse(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}+08:00`);
  // Timestamp inputs must carry a timezone; host-local parsing is not reproducible.
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return NaN;
  return Date.parse(value);
}
function limits({ asOf, cutoff } = {}) {
  const asTime = asOf == null ? Date.now() : timeOf(asOf);
  const cutTime = cutoff == null ? asTime : timeOf(cutoff);
  if (!Number.isFinite(asTime) || !Number.isFinite(cutTime)) return null;
  const time = Math.min(asTime, cutTime);
  return { time, date: dateOf(new Date(time).toISOString()), cutoff: new Date(time).toISOString() };
}
function verifiedPublication(record) {
  if (record?.publication_time_verified !== true) return null;
  const value = record.publication_at ?? record.published_at ?? record.publication_date;
  const time = timeOf(value);
  return Number.isFinite(time) ? time : null;
}

// Accepted ratios explicitly specify old:new shares. Ambiguous conversion notes fail closed.
function corporateAction(note) {
  if (note == null || note === '') return { cash: 0, split: 1, kind: 'none' };
  if (typeof note !== 'string') return null;
  const text = note.trim().replace(/\s+/g, '').replaceAll('：', ':');
  if (!text) return { cash: 0, split: 1, kind: 'none' };
  let match = text.match(/^(?:分红:?)?每(\d+(?:\.\d+)?)?份(?:基金份额)?(?:派现金|派现|派发现金|派发红利|分配红利|分红)(\d+(?:\.\d+)?)元[。；;]?$/);
  if (match) {
    const units = match[1] == null ? 1 : Number(match[1]);
    const amount = Number(match[2]);
    return positive(units) && finite(amount) ? { cash: amount / units, split: 1, kind: 'cash_dividend' } : null;
  }
  match = text.match(/^(?:拆分|折算)(?:比例)?:?(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)[。；;]?$/)
    ?? text.match(/^(?:拆分|折算):?每(\d+(?:\.\d+)?)?份(?:基金份额)?(?:拆分为?|折算为?|变为)(\d+(?:\.\d+)?)份[。；;]?$/);
  if (match) {
    const before = match[1] == null ? 1 : Number(match[1]), after = Number(match[2]);
    return positive(before) && positive(after) ? { cash: 0, split: after / before, kind: 'split' } : null;
  }
  return null;
}

/**
 * Build a normalized total-return index, reinvesting cash distributions at ex-date NAV.
 * Uses unit NAV and explicit action notes only; cumulative NAV is never a substitute.
 * "ok" means calculable, not independently verified. See verification and issues.
 */
export function buildTotalReturn(nav) {
  const verification = nav?.official_crosscheck === 'verified' || nav?.official_crosscheck?.status === 'verified'
    ? 'official_crosscheck_verified' : 'provider_data_not_independently_verified';
  const base = { status: 'unavailable', basis: 'distribution_reinvested_total_return', verification, series: [], issues: [], actions: [] };
  if (!Array.isArray(nav?.series) || !nav.series.length) return { ...base, issues: ['missing_nav_series'] };
  if (nav.series_kind && nav.series_kind !== 'unit_nav') return { ...base, status: 'unverified', issues: ['requires_unit_nav_not_cumulative_nav'] };
  let previousDate = '', previousNav = null, value = 1;
  const series = [], actions = [];
  for (const point of nav.series) {
    if (!validDate(point.date) || point.date <= previousDate || !positive(point.unit_nav)) {
      return { ...base, status: 'unverified', issues: ['invalid_or_unordered_unit_nav'] };
    }
    const action = corporateAction(point.corporate_action_note);
    if (!action) return { ...base, status: 'unverified', issues: [`unrecognized_corporate_action:${point.date}`] };
    if (action.kind !== 'none') actions.push({ date: point.date, ...action });
    if (previousNav !== null) value *= (point.unit_nav * action.split + action.cash) / previousNav;
    if (!positive(value)) return { ...base, status: 'unverified', issues: ['nonfinite_total_return'] };
    series.push({ date: point.date, value });
    previousNav = point.unit_nav;
    previousDate = point.date;
  }
  return {
    ...base, status: 'ok', series, actions,
    basis: actions.length ? 'distribution_reinvested_total_return' : 'unit_nav_no_reported_actions',
    issues: verification === 'provider_data_not_independently_verified' ? ['corporate_actions_require_official_crosscheck'] : []
  };
}

function drawdowns(series) {
  let peak = series[0]?.value, max = 0, current = 0;
  for (const point of series) {
    peak = Math.max(peak, point.value);
    current = point.value / peak - 1;
    max = Math.min(max, current);
  }
  return { maximum: max, current };
}
const average = values => values.reduce((a, b) => a + b, 0) / values.length;

/** Product drawdowns are negative fractions; MA values use the normalized total-return index. */
export function analyzeNav(nav, options = {}) {
  const empty = {
    status: 'unavailable', basis: null, data_date: null, observations: 0,
    returns: Object.fromEntries(WINDOWS.map(n => [String(n), null])),
    volatility_annualized: null, max_drawdown: null, drawdown_from_peak: null,
    ma20: null, ma60: null, trend: 'insufficient_data', series: [], issues: [],
    annualization: { observations_per_year: 252, window: 'last_up_to_252_return_observations', actual_return_observations: 0, sparse: null },
    drawdown_convention: 'negative_return_fraction', ma_basis: 'normalized_total_return_index'
  };
  const bound = limits(options);
  if (!bound) return { ...empty, issues: ['invalid_as_of_or_cutoff'] };
  if (!Array.isArray(nav?.series)) return { ...empty, issues: ['missing_nav_series'] };
  if (nav.series.some(point => !validDate(point.date))) return { ...empty, status: 'unverified', issues: ['invalid_observation_date'] };
  const globalPublication = verifiedPublication(nav);
  const collected = nav.collected_at == null ? null : timeOf(nav.collected_at);
  if (collected !== null && !Number.isFinite(collected)) return { ...empty, issues: ['invalid_collection_timestamp'] };
  const candidates = nav.series.filter(point => validDate(point.date) && point.date <= bound.date);
  if (collected === null && globalPublication === null && candidates.some(p => verifiedPublication(p) === null)) return { ...empty, issues: ['availability_timestamp_unknown'] };
  // In a historical replay a newer download is admissible only with verified public availability.
  if (collected !== null && collected > bound.time && globalPublication === null && candidates.some(p => verifiedPublication(p) === null)) {
    return { ...empty, issues: ['collected_after_cutoff_without_verified_publication'] };
  }
  if (globalPublication !== null && globalPublication > bound.time) return { ...empty, issues: ['published_after_cutoff'] };
  const selected = candidates.filter(point => {
    const published = verifiedPublication(point) ?? globalPublication;
    return published === null || published <= bound.time;
  });
  if (!selected.length) return { ...empty, issues: ['no_observations_available_at_cutoff'] };
  const total = buildTotalReturn({ ...nav, series: selected });
  const result = { ...empty, ...total, data_date: selected.at(-1).date, observations: selected.length, cutoff: bound.cutoff };
  if (total.status !== 'ok') {
    // Price observations remain visible, but are never fed into total-return signals.
    result.price_series=selected.map(p=>({date:p.date,unit_nav:p.unit_nav}));
    result.price_basis='unadjusted_unit_nav_only';
    return result;
  }
  if (collected === null && globalPublication === null) result.issues = [...result.issues, 'availability_timestamp_unknown'];
  const series = total.series;
  for (const n of WINDOWS) if (series.length > n) result.returns[String(n)] = series.at(-1).value / series.at(-1 - n).value - 1;
  if (series.length >= 20) result.ma20 = average(series.slice(-20).map(p => p.value));
  if (series.length >= 60) result.ma60 = average(series.slice(-60).map(p => p.value));
  if (result.ma60 !== null) {
    const current = series.at(-1).value;
    result.trend = current > result.ma20 && current > result.ma60 ? 'above_both'
      : current < result.ma20 && current < result.ma60 ? 'below_both' : 'mixed';
  }
  if (series.length > 1) {
    const dd = drawdowns(series);
    result.max_drawdown = dd.maximum;
    result.drawdown_from_peak = dd.current;
  }
  const sample = series.slice(-253), returns = sample.slice(1).map((p, i) => p.value / sample[i].value - 1);
  const gaps = sample.slice(1).map((p, i) => (timeOf(p.date) - timeOf(sample[i].date)) / DAY);
  const sparse = gaps.some(days => days > 14) || (gaps.length >= 60 && average(gaps) > 2.1);
  result.annualization = { ...empty.annualization, actual_return_observations: returns.length, sparse, max_calendar_gap_days: gaps.length ? Math.max(...gaps) : null };
  if (returns.length >= 60 && !sparse) {
    const mean = average(returns);
    result.volatility_annualized = Math.sqrt(returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1)) * Math.sqrt(252);
  } else if (sparse) result.issues = [...result.issues, 'sparse_history_no_daily_volatility_annualization'];
  return result;
}

/** Correlate returns over identical common-date intervals; never forward-fill missing NAVs. */
export function correlations(metricsByCode) {
  const entries = metricsByCode instanceof Map ? [...metricsByCode] : Object.entries(metricsByCode ?? {});
  const output = [];
  for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
    const [a, left] = entries[i], [b, right] = entries[j];
    const row = { code_a: a, code_b: b, status: 'unavailable', correlation: null, samples: 0, start_date: null, end_date: null, basis: 'common_date_interval_returns' };
    if (left?.status !== 'ok' || right?.status !== 'ok') { output.push(row); continue; }
    const rightMap = new Map(right.series.filter(p => positive(p.value)).map(p => [p.date, p.value]));
    const common = left.series.filter(p => positive(p.value) && rightMap.has(p.date));
    const x = [], y = [];
    for (let k = 1; k < common.length; k++) {
      x.push(common[k].value / common[k - 1].value - 1);
      y.push(rightMap.get(common[k].date) / rightMap.get(common[k - 1].date) - 1);
    }
    Object.assign(row, { samples: x.length, start_date: common[0]?.date ?? null, end_date: common.at(-1)?.date ?? null });
    if (x.length >= 60) {
      const mx = average(x), my = average(y);
      let covariance = 0, vx = 0, vy = 0;
      for (let k = 0; k < x.length; k++) { covariance += (x[k] - mx) * (y[k] - my); vx += (x[k] - mx) ** 2; vy += (y[k] - my) ** 2; }
      if (vx > 1e-24 && vy > 1e-24) Object.assign(row, { status: 'ok', correlation: Math.max(-1, Math.min(1, covariance / Math.sqrt(vx * vy))) });
      else row.status = 'constant_series';
    } else row.status = 'insufficient_data';
    output.push(row);
  }
  return output;
}

const EXTERNAL = new Set(['external_deposit', 'external_withdrawal']);
const INTERNAL = new Set(['buy', 'sell', 'dividend', 'fee']);
const CONFIRMED = new Set(['confirmed', 'completed', 'settled', 'executed', 'reconciled']);
const UNEXECUTED = new Set(['planned', 'pending', 'cancelled', 'canceled', 'rejected']);
const signedFlow = event => event.type === 'external_withdrawal' ? -event.amount_cny : event.amount_cny;

function baselineIncludes(event, baseline) {
  if (event.accounted_in_baseline !== true) return false;
  const latest = event.occurred_between?.on_or_before ?? event.date;
  return validDate(latest) && latest <= baseline.date;
}
function exactFlowBoundaries(points, flows) {
  const matched = new Set();
  for (const point of points) {
    if (point.flow_after_cny == null || point.flow_after_cny === 0) continue;
    if (!finite(point.flow_after_cny) || !point.at) return false;
    let matching;
    if (Array.isArray(point.flow_event_ids)) {
      matching = point.flow_event_ids.map(id => flows.find(event => event.id === id));
      if (matching.some(event => !event) || new Set(point.flow_event_ids).size !== matching.length) return false;
    } else matching = flows.filter(event => event.date === point.date && !matched.has(event.id));
    // Multiple flows require explicit IDs, avoiding accidental matching of offsetting cash flows.
    if (!matching.length || (!point.flow_event_ids && matching.length !== 1)) return false;
    if (!near(matching.reduce((sum, event) => sum + signedFlow(event), 0), point.flow_after_cny)) return false;
    for (const event of matching) {
      if (matched.has(event.id) || event.date !== point.date || (event.at && timeOf(event.at) !== point.time)) return false;
      matched.add(event.id);
    }
  }
  return matched.size === flows.length;
}

/**
 * A valuation is TOTAL strategy wealth including strategy cash and owned receivables.
 * Baseline date-only means end of that HK date. date-only cash flows use end-of-day
 * timing for Modified Dietz. Internal trades/dividends/fees are already in wealth;
 * they are never added/subtracted a second time. External amounts are positive.
 * Exact TWR optionally uses {at,total_cny,flow_after_cny,flow_event_ids}: total_cny
 * is the wealth immediately BEFORE that signed external flow. Intermediate and
 * terminal ordinary valuations contain wealth AFTER all earlier cash flows.
 * Drawdowns are POSITIVE loss fractions, and only supplied for an exact TWR index.
 */
export function calculatePerformance(ledger, options = {}) {
  const empty = {
    status: 'unavailable', method: null, return_fraction: null, annualized_return: null,
    max_drawdown: null, current_drawdown: null, index_series: [], days: null,
    start_date: ledger?.baseline?.date ?? null, end_date: null, net_external_flow_cny: null,
    issues: [], drawdown_convention: 'positive_loss_fraction',
    timing: 'date_only_baseline_and_dietz_cash_flows_at_Hong_Kong_day_end'
  };
  const unavailable = issue => ({ ...empty, issues: [issue] });
  const bound = limits(options), baseline = ledger?.baseline;
  if (!bound) return unavailable('invalid_as_of_or_cutoff');
  if (!baseline || !validDate(baseline.date) || !positive(baseline.total_cny)) return unavailable('invalid_baseline');
  if (baseline.reconciled !== true || ['draft', 'pending', 'unreconciled', 'unverified'].includes(baseline.status)) return unavailable('baseline_not_reconciled');
  const completeSince = ledger.external_flows_complete_since ?? ledger.cashflows_complete_since;
  if (!validDate(completeSince) || completeSince > baseline.date) return unavailable('external_cash_flow_coverage_incomplete');
  const start = timeOf(baseline.at ?? baseline.date);
  if (!Number.isFinite(start) || start >= bound.time) return unavailable('no_period_after_baseline');
  if (baseline.at && dateOf(baseline.at) !== baseline.date) return unavailable('baseline_timestamp_date_mismatch');
  if (baseline.recorded_at && (!Number.isFinite(timeOf(baseline.recorded_at)) || timeOf(baseline.recorded_at) > bound.time)) return unavailable('baseline_recorded_after_cutoff_or_invalid');
  if (!Array.isArray(ledger.valuations) || !Array.isArray(ledger.events)) return unavailable('invalid_ledger_arrays');
  const points = [];
  for (const point of ledger.valuations) {
    const date = point.date ?? dateOf(point.at), time = timeOf(point.at ?? point.date);
    if (!validDate(date) || !Number.isFinite(time)) return unavailable('invalid_valuation_date');
    if (point.at && dateOf(point.at) !== date) return unavailable('valuation_timestamp_date_mismatch');
    if (time <= start || time > bound.time) continue;
    if (point.recorded_at && !Number.isFinite(timeOf(point.recorded_at))) return unavailable('invalid_valuation_recorded_at');
    if (point.recorded_at && timeOf(point.recorded_at) > bound.time) continue;
    if (point.reconciled !== true || !positive(point.total_cny)) return unavailable('valuation_not_reconciled');
    if (point.flow_after_cny != null && !finite(point.flow_after_cny)) return unavailable('invalid_valuation_flow_boundary');
    points.push({ ...point, date, time });
  }
  points.sort((a, b) => a.time - b.time);
  if (!points.length) return unavailable('no_reconciled_ending_valuation');
  if (points.some((point, i) => i && point.time === points[i - 1].time)) return unavailable('duplicate_valuation_time');
  const endPoint = points.at(-1), end = endPoint.time, flows = [], seen = new Set();
  for (const event of ledger.events) {
    if (!event || typeof event.id !== 'string' || !event.id || seen.has(event.id)) return unavailable('missing_or_duplicate_event_id');
    seen.add(event.id);
    if (!EXTERNAL.has(event.type) && !INTERNAL.has(event.type)) return unavailable('unknown_event_type');
    if (UNEXECUTED.has(event.status)) continue;
    if (!CONFIRMED.has(event.status)) return unavailable('unconfirmed_event_status');
    if (baselineIncludes(event, baseline)) continue;
    const date = event.date ?? dateOf(event.at), time = timeOf(event.at ?? event.date);
    if (!validDate(date) || !Number.isFinite(time)) return unavailable('unknown_event_date');
    if (event.at && dateOf(event.at) !== date) return unavailable('event_timestamp_date_mismatch');
    if (time < start) continue;
    if (time > end) continue;
    if (event.recorded_at && (!Number.isFinite(timeOf(event.recorded_at)) || timeOf(event.recorded_at) > bound.time)) return unavailable('event_recorded_after_cutoff_or_invalid');
    if (!positive(event.amount_cny)) return unavailable('invalid_event_amount');
    if (event.reconciled === false) return unavailable('event_not_reconciled');
    if (!EXTERNAL.has(event.type)) continue;
    if (time === start) return unavailable('baseline_day_external_flow_needs_explicit_inclusion');
    flows.push({ ...event, date, time });
  }
  const netFlow = flows.reduce((sum, event) => sum + signedFlow(event), 0);
  const duration = (end - start) / DAY;
  const common = { ...empty, days: duration, end_date: endPoint.date, end_total_cny: endPoint.total_cny + (endPoint.flow_after_cny ?? 0), net_external_flow_cny: netFlow, cutoff: bound.cutoff };
  if (duration <= 0) return unavailable('empty_performance_period');
  const exact = exactFlowBoundaries(points, flows);
  if (exact) {
    let wealthAfterFlow = baseline.total_cny, index = 1;
    const indexSeries = [{ date: baseline.date, at: baseline.at ?? null, value: index }];
    for (const point of points) {
      index *= point.total_cny / wealthAfterFlow;
      wealthAfterFlow = point.total_cny + (point.flow_after_cny ?? 0);
      if (!positive(index) || !positive(wealthAfterFlow)) return unavailable('invalid_twr_capital_after_flow');
      indexSeries.push({ date: point.date, at: point.at ?? null, value: index });
    }
    const dd = drawdowns(indexSeries), result = index - 1;
    return { ...common, status: 'ok', method: 'time_weighted_return', return_fraction: result,
      annualized_return: duration >= 365 ? index ** (365 / duration) - 1 : null,
      max_drawdown: Math.max(0, -dd.maximum), current_drawdown: Math.max(0, -dd.current), index_series: indexSeries,
      drawdown_sampling: 'available_reconciled_valuations_only', issues: duration < 365 ? ['annualization_suppressed_under_365_days'] : [] };
  }
  // Inexact boundary metadata must not alter the declared terminal total wealth.
  if (points.some(point => point.flow_after_cny != null && point.flow_after_cny !== 0)) return { ...common, issues: ['flow_boundary_does_not_match_external_events'] };
  const weightedFlows = flows.reduce((sum, event) => sum + signedFlow(event) * (end - event.time) / (end - start), 0);
  const denominator = baseline.total_cny + weightedFlows;
  if (!positive(denominator)) return { ...common, issues: ['nonpositive_modified_dietz_capital'] };
  const result = (endPoint.total_cny - baseline.total_cny - netFlow) / denominator;
  if (!finite(result) || result <= -1) return { ...common, issues: ['invalid_modified_dietz_return'] };
  return { ...common, status: 'approximate', method: 'modified_dietz', return_fraction: result,
    annualized_return: duration >= 365 ? (1 + result) ** (365 / duration) - 1 : null,
    issues: ['date_weighted_cash_flows_not_exact_twr', 'drawdown_unavailable_without_cash_flow_boundary_valuations', ...(duration < 365 ? ['annualization_suppressed_under_365_days'] : [])] };
}

/** Scenario arithmetic only: weights and shocks are fractions; no probability or loss guarantee. */
export function stressPortfolio(rows, weights, shocks) {
  const inputs = rows.map(row => {
    const key = row.key ?? row.asset_class ?? row.code;
    const weight = weights[key], shock = shocks[key];
    if (!finite(weight) || weight < 0 || !finite(shock) || shock < -1) throw new Error(`Invalid stress input: ${key}`);
    return { key, weight, shock, contribution: weight * shock };
  });
  const sum = inputs.reduce((s, row) => s + row.weight, 0);
  if (Math.abs(sum - 1) > 1e-8) throw new Error('Stress weights must sum to one');
  return { return_fraction: inputs.reduce((s, row) => s + row.contribution, 0), rows: inputs, basis: 'hypothetical_scenario_not_maximum_loss' };
}
