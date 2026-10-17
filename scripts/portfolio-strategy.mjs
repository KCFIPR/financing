// Pure analysis: recommendations never mutate holdings or become ledger events.
const DEFAULT_TARGETS = { cash: .15, pure_bond: .50, defensive_mixed: .10, china_broad: .06, us_broad: .07, nasdaq: .03, theme: .04, gold: .05 };
const DEFAULT_LIMITS = { pure_bond_fund: .20, theme_direction: .02, weekly_one_way: .05, drift: .03, gold_drift: .01, cooldown_trading_days: 5, max_routine_redemption_fee_pct: .5 };
const RISK_BUCKETS = new Set(['defensive_mixed', 'china_broad', 'us_broad', 'nasdaq', 'theme', 'gold']);
const ACTUAL_TRADE_STATES = new Set(['confirmed', 'completed', 'settled', 'executed', 'reconciled']);
const finite = x => typeof x === 'number' && Number.isFinite(x);
const round = (x, places = 2) => Number(x.toFixed(places));
const sum = xs => xs.reduce((a, b) => a + b, 0);
const dateOf = x => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}/.test(x) ? x.slice(0, 10) : null;
const dayMs = 86400000;
const utc = d => Date.parse(`${d}T00:00:00Z`);
const addDays = (d, n) => new Date(utc(d) + n * dayMs).toISOString().slice(0, 10);
const isWeekday = d => ![0, 6].includes(new Date(utc(d)).getUTCDay());
const monday = d => addDays(d, -((new Date(utc(d)).getUTCDay() + 6) % 7));
const directionOf = e => ['buy', 'sell'].includes(e.direction) ? e.direction : ['buy', 'sell'].includes(e.type) ? e.type : null;
const eventDate = e => {
  const value = e.trade_date ?? e.date ?? e.at ?? e.executed_at ?? e.confirmed_at ?? e.settled_at;
  return typeof value === 'string' && value.includes('T') && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' }) : dateOf(value);
};
const exposureOf = (h, p) => p.exposure_group || p.fund_group || h.code;
const issue = (code, message, severity = 'warning', extra = {}) => ({ code, severity, message, ...extra });

function calendarFor(calendar, profile, code) {
  const own = calendar.by_code?.[code] ?? calendar.calendars?.[profile.calendar_key];
  if (own) return own;
  // A complete mainland exchange calendar cannot certify a QDII fund's dealing days.
  if (['nasdaq', 'us_broad'].includes(profile.bucket) || profile.kind?.startsWith('qdii')) return { ...calendar, complete: false, verification_basis: 'mainland_proxy_only' };
  return calendar;
}

function openDayStatus(day, calendar) {
  const dates = calendar.trading_dates ?? calendar.open_dates;
  const verified = calendar.complete === true && (!calendar.start_date || calendar.start_date <= day) && (!calendar.end_date || calendar.end_date >= day);
  const open = Array.isArray(dates) ? dates.includes(day) : isWeekday(day) && !(calendar.holidays ?? calendar.closed_dates ?? []).includes(day);
  return { open, verified };
}

// Explicit open days are preferred; weekday estimates are never advertised as verified.
export function countTradingDays(after, through, calendar = {}) {
  if (!dateOf(after) || !dateOf(through) || after > through) return { count: 0, verified: false };
  const dates = calendar.trading_dates ?? calendar.open_dates;
  if (Array.isArray(dates)) {
    const coverageStart = calendar.start_date ?? calendar.coverage_start ?? [...dates].sort()[0];
    const coverageEnd = calendar.end_date ?? calendar.coverage_end ?? [...dates].sort().at(-1);
    return { count: new Set(dates.filter(d => d > after && d <= through)).size, verified: coverageStart <= after && coverageEnd >= through && calendar.complete !== false };
  }
  const holidays = new Set(calendar.holidays ?? calendar.closed_dates ?? []);
  let count = 0;
  for (let d = addDays(after, 1); d <= through; d = addDays(d, 1)) if (isWeekday(d) && !holidays.has(d)) count++;
  return { count, verified: calendar.complete === true && (!calendar.start_date || calendar.start_date <= after) && (!calendar.end_date || calendar.end_date >= through) };
}

function range(batch) {
  const min = batch.holding_days_min ?? batch.holding_days ?? 0;
  const max = batch.holding_days_max ?? (batch.holding_days != null ? batch.holding_days : Infinity);
  return { min, max, valid: finite(min) && min >= 0 && (finite(max) || max === Infinity) && min <= max };
}

export function inspectBatches(holding) {
  const batches = holding.batches ?? [];
  const issues = [];
  for (const b of batches) {
    if (!range(b).valid) issues.push(issue('invalid_holding_interval', `批次 ${b.batch_id} 的持有期区间无效。`));
    if (!finite(b.redemption_fee_pct)) issues.push(issue('unknown_redemption_fee', `批次 ${b.batch_id} 的赎回费率未填写，不能视为零。`));
  }
  for (let i = 0; i < batches.length; i++) for (let j = i + 1; j < batches.length; j++) {
    const a = range(batches[i]), b = range(batches[j]);
    if (a.valid && b.valid && Math.max(a.min, b.min) <= Math.min(a.max, b.max)) issues.push(issue('overlapping_holding_intervals', `批次 ${batches[i].batch_id} 与 ${batches[j].batch_id} 的持有期区间重叠（上下限均包含），无法确定先进先出顺序。`));
  }
  const units = sum(batches.map(b => finite(b.units) ? b.units : 0));
  if (finite(holding.units) && Math.abs(units - holding.units) > .02) issues.push(issue('batch_units_mismatch', '批次份额合计与持仓份额不一致。'));
  if (!batches.length) issues.push(issue('missing_batches', '未记录批次，不能计算赎回费用。'));
  return issues;
}

export function estimateRedemption(holding, profile, amount) {
  const conditions = [];
  const nav = profile.kind === 'money_market' || profile.kind === 'money' ? null : holding.unit_nav;
  if (!finite(nav) || nav <= 0) return { units_estimate: null, fee_estimate_cny: null, fee_max_pct: null, batches: [], conditions: ['需核实适用于赎回的最新净值／货币基金赎回金额，不能使用错填的价格。'] };
  const units = amount / nav;
  const batchIssues = inspectBatches(holding);
  const uncertainOrder = profile.redemption?.order !== 'fifo' || batchIssues.some(i => ['overlapping_holding_intervals', 'invalid_holding_interval', 'missing_batches', 'batch_units_mismatch'].includes(i.code));
  if (profile.redemption?.order !== 'fifo') conditions.push('需核实销售平台是否执行先进先出赎回。');
  if (batchIssues.some(i => ['overlapping_holding_intervals', 'invalid_holding_interval', 'batch_units_mismatch'].includes(i.code))) conditions.push('需先核对批次区间及份额，不能指定零费批次或推定赎回顺序。');
  if (!finite(holding.redeemable_units)) conditions.push('需确认可赎回份额。');
  else if (units > holding.redeemable_units + .001) conditions.push('拟赎回份额超过当前可赎回份额。');
  const batches = [...(holding.batches ?? [])].sort((a, b) => range(b).min - range(a).min);
  const homogeneousFee = batches.length > 0 && batches.every(b => finite(b.redemption_fee_pct) && b.redemption_fee_pct >= 0 && b.redemption_fee_pct === batches[0].redemption_fee_pct);
  const selected = [];
  let remaining = units, fee = 0, maxFee = 0, feeKnown = true;
  for (const b of batches) {
    if (remaining <= .000001) break;
    const take = Math.min(remaining, Math.max(0, b.units ?? 0));
    if (take === 0) continue;
    if (!finite(b.redemption_fee_pct) || b.redemption_fee_pct < 0) feeKnown = false;
    else { fee += take * nav * b.redemption_fee_pct / 100; maxFee = Math.max(maxFee, b.redemption_fee_pct); }
    selected.push({ batch_id: b.batch_id, units: round(take, 6), fee_pct: finite(b.redemption_fee_pct) ? b.redemption_fee_pct : null });
    remaining -= take;
  }
  if (remaining > .02) { feeKnown = false; conditions.push('已知批次份额不足以覆盖本次赎回。'); }
  if (!feeKnown) conditions.push('本次涉及的赎回费率未知，需下单前核实。');
  const reliable = feeKnown && !uncertainOrder;
  const orderIndependentFee = homogeneousFee && remaining <= .02 && !batchIssues.some(i => ['invalid_holding_interval', 'batch_units_mismatch'].includes(i.code));
  return { units_estimate: round(units, 6), fee_estimate_cny: reliable ? round(fee) : orderIndependentFee ? round(amount * batches[0].redemption_fee_pct / 100) : null, fee_max_pct: reliable ? maxFee : orderIndependentFee ? batches[0].redemption_fee_pct : null, batches: reliable ? selected : [], conditions };
}

function cashState(snapshot, ledger, asOf) {
  const cash = snapshot.strategy_cash?.amount_cny ?? 0;
  const rows = [...snapshot.holdings, snapshot.strategy_cash ?? {}];
  const snapshotKnown = finite(snapshot.pending_buy_total_cny) ? snapshot.pending_buy_total_cny : sum(rows.map(h => finite(h.pending_buy_cny) ? h.pending_buy_cny : 0));
  const pendingEvents = (ledger.events ?? []).filter(e => ['pending', 'submitted'].includes(e.status) && directionOf(e) === 'buy');
  const uniquePending = [...new Map(pendingEvents.map((e, i) => [e.id ?? `unidentified-${i}`, e])).values()];
  const ledgerReserve = sum(uniquePending.filter(e => e.cash_basis === 'included_in_snapshot_cash').map(e => finite(e.cash_reserved_cny) ? e.cash_reserved_cny : e.amount_cny ?? 0));
  const pendingUnknown = ledger.pending_reconciled === true
    ? uniquePending.some(e => !['included_in_snapshot_cash', 'already_deducted'].includes(e.cash_basis) || !finite(e.amount_cny))
    : (!finite(snapshot.pending_buy_total_cny) && rows.some(h => !finite(h.pending_buy_cny))) || uniquePending.some(e => !['included_in_snapshot_cash', 'already_deducted'].includes(e.cash_basis));
  // Ledger and snapshot can describe the same orders: never add the two sources.
  const reserve = ledger.pending_reconciled === true ? ledgerReserve : Math.max(snapshotKnown, ledgerReserve);
  const dca = ledger.dca ?? { status: 'unknown', plans: [] };
  const dcaUnknown = !['complete', 'confirmed', 'none', 'all_stopped'].includes(dca.status);
  const futureDca = (dca.plans ?? []).filter(p => p.status === 'active' && dateOf(p.next_execution_date) >= asOf && dateOf(p.next_execution_date) < addDays(monday(asOf), 7));
  const dcaReserve = sum(futureDca.filter(p => !uniquePending.some(e => e.dca_plan_id === p.id)).map(p => finite(p.amount_cny) ? p.amount_cny : 0));
  return { gross_cash_cny: cash, pending_reserved_cny: round(reserve), dca_reserved_cny: round(dcaReserve), pending_unknown: pendingUnknown, dca_unknown: dcaUnknown, available_cash_upper_bound_cny: round(Math.max(0, cash - reserve - dcaReserve)), basis: 'available_cash_only; receivables_and_proposed_sales_not_added' };
}

function evidenceBefore(item, cutoff) {
  const t = item?.verified_at ?? item?.published_at;
  if (!t) return false;
  return Number.isFinite(Date.parse(t)) && Date.parse(t) <= Date.parse(cutoff);
}

function buildLookthrough(holdings, profiles, total, asOf, cutoff) {
  const components = {};
  for (const key of ['stock', 'bond', 'convertible']) {
    let known = 0, covered = 0;
    for (const h of holdings) {
      const p = profiles[h.code] ?? {};
      const afterCutoff = (p.lookthrough_basis_date && p.lookthrough_basis_date > asOf) || (p.lookthrough_published_at && Date.parse(p.lookthrough_published_at) > Date.parse(cutoff));
      if (!afterCutoff && finite(p[`${key}_fraction`])) { known += h.amount_cny * p[`${key}_fraction`]; covered += h.amount_cny; }
    }
    components[key] = { known_amount_cny: round(known), known_weight: total ? known / total : 0, covered_fund_amount_cny: round(covered), unknown_fund_amount_cny: round(sum(holdings.map(h => h.amount_cny)) - covered), complete: Math.abs(sum(holdings.map(h => h.amount_cny)) - covered) < .01 };
  }
  const groups = new Map();
  for (const h of holdings) {
    const p = profiles[h.code] ?? {}, group = exposureOf(h, p);
    if (!groups.has(group)) groups.set(group, { exposure_group: group, amount_cny: 0, codes: [], holding_ids: [] });
    const g = groups.get(group); g.amount_cny += h.amount_cny; g.codes.push(h.code); g.holding_ids.push(h.id);
  }
  return { components, exposure_groups: [...groups.values()].map(g => ({ ...g, amount_cny: round(g.amount_cny), weight: total ? g.amount_cny / total : 0, codes: [...new Set(g.codes)] })), disclosure: holdings.map(h => ({ code: h.code, basis_date: profiles[h.code]?.lookthrough_basis_date ?? null, source_url: profiles[h.code]?.source_url ?? null })), note: '最新已披露比例不是实时持仓；未知覆盖不按零计。股票、债券和可转债可能存在包含关系，不能机械相加。' };
}

/** All rates are fractions except fields explicitly named *_pct (percent points). */
export function analyzePortfolio({ snapshot, mandate = {}, profiles = {}, ledger = {}, metrics = {}, asOf, cutoff, calendar = {} }) {
  asOf ??= snapshot.snapshot_date;
  cutoff ??= `${asOf}T23:59:59+08:00`;
  if (!dateOf(asOf) || !Number.isFinite(Date.parse(cutoff))) throw new Error('asOf and cutoff must be valid dates');
  if (!Array.isArray(snapshot.holdings)) throw new Error('snapshot.holdings is required');
  if (snapshot.snapshot_date > asOf) throw new Error('Snapshot is later than the requested analysis date');
  if (snapshot.holdings.some(h => !finite(h.amount_cny) || h.amount_cny < 0)) throw new Error('Holding values must be finite and non-negative');
  const target = { ...DEFAULT_TARGETS, ...mandate.allocation_targets };
  if (Math.abs(sum(Object.values(target)) - 1) > .000001) throw new Error('allocation_targets must sum to one');
  const limits = { ...DEFAULT_LIMITS, ...mandate.limits };
  const thresholds = { warning: .06, freeze_risk_buys: .08, breach: .10, ...mandate.drawdown_thresholds };
  const issues = [], recommendations = [];
  const rows = snapshot.holdings.filter(h => h.amount_cny > 0);
  if (rows.some(h => !finite(h.amount_cny)) || (snapshot.strategy_cash && !finite(snapshot.strategy_cash.amount_cny))) throw new Error('Holding and cash values must be finite');
  const fundTotal = sum(rows.map(h => h.amount_cny)), cashAmount = snapshot.strategy_cash?.amount_cny ?? 0, total = round(fundTotal + cashAmount);
  if (total <= 0) throw new Error('Portfolio total must be positive');
  const amounts = Object.fromEntries(Object.keys(target).map(k => [k, k === 'cash' ? cashAmount : 0]));
  const holdings = rows.map(h => {
    const p = profiles[h.code] ?? {}, bucket = p.bucket ?? 'unknown';
    amounts[bucket] = (amounts[bucket] ?? 0) + h.amount_cny;
    const hIssues = inspectBatches(h);
    if (!p.bucket) hIssues.push(issue('unknown_asset_bucket', '资产类别尚未核实，暂不提出该基金的自动调仓金额。'));
    if (h.analysis_enabled === false) hIssues.push(issue('analysis_disabled', '用户关闭了该持仓分析；仍计入总资产和已知风险敞口，不生成交易建议。'));
    if (p.kind === 'money_market' || p.kind === 'money') {
      if (h.category !== 'money_market' && h.category !== 'money') hIssues.push(issue('money_market_category_corrected', '按货币基金处理；不使用录入净值计算价格涨跌或金额差额。', 'info'));
    } else if (finite(h.units) && finite(h.unit_nav)) {
      const difference = round(h.amount_cny - h.units * h.unit_nav);
      if (Math.abs(difference) > 1) hIssues.push(issue('holding_value_unreconciled', `持仓金额与份额×净值相差 ${difference.toFixed(2)} 元，原因待核对，不能自动归为在途申购。`, 'warning', { difference_cny: difference }));
    }
    if (dateOf(h.nav_date) > asOf) hIssues.push(issue('future_nav', '净值日期晚于分析日期，不能用于本次建议。', 'error'));
    for (const i of hIssues) issues.push({ ...i, fund_code: h.code, holding_id: h.id });
    return { holding_id: h.id, code: h.code, name: h.name, platform: h.platform, bucket, exposure_group: exposureOf(h, p), amount_cny: h.amount_cny, weight: h.amount_cny / total, holding_pnl_cny: finite(h.holding_pnl_cny) ? h.holding_pnl_cny : null, holding_return_pct: finite(h.estimated_holding_return_pct) ? h.estimated_holding_return_pct : null, issues: hIssues, direction: 'hold', dca_action: 'review', reason: '维持现有持仓，按目标仓位、费用和资金约束复核。', metrics: metrics[h.code] ?? null };
  });
  const allocation = Object.entries(amounts).map(([bucket, amount]) => ({ bucket, amount_cny: round(amount), weight: amount / total, target: target[bucket] ?? null, target_amount_cny: finite(target[bucket]) ? round(total * target[bucket]) : null, gap_cny: finite(target[bucket]) ? round(total * target[bucket] - amount) : null }));
  const cash = cashState(snapshot, ledger, asOf);
  if (cash.pending_unknown) issues.push(issue('pending_cash_unknown', '在途申购及其是否已从现金扣除尚未全部核对，买入建议仅为条件式，不把未知视为零。'));
  if (cash.dca_unknown) issues.push(issue('dca_list_incomplete', '仍有定投但清单不完整；需补充扣款金额与日期，不能假设全部停止。'));
  const pnlKnown = rows.every(h => finite(h.holding_pnl_cny));
  const performance = ledger.performance ?? {};
  const drawdown = finite(performance.drawdown) ? Math.max(0, performance.drawdown) : finite(performance.current_drawdown) ? Math.max(0, performance.current_drawdown) : null;
  const emergency = drawdown !== null && drawdown >= thresholds.breach;
  const freezeRisk = drawdown !== null && drawdown >= thresholds.freeze_risk_buys;
  const riskState = drawdown === null ? 'unknown' : emergency ? 'breach' : freezeRisk ? 'freeze_risk_buys' : drawdown >= thresholds.warning ? 'warning' : 'normal';
  if (drawdown === null) issues.push(issue('drawdown_unknown', '缺少完整的现金流调整净值，当前组合回撤未知；持有盈亏不替代回撤。'));
  if (riskState !== 'normal' && riskState !== 'unknown') issues.push(issue(`drawdown_${riskState}`, `现金流调整净值回撤 ${(drawdown * 100).toFixed(2)}%，已触发${emergency ? '风险预算突破' : freezeRisk ? '暂停新增风险资产' : '预警'}。`, emergency ? 'error' : 'warning'));

  const validEvents = [];
  let executionHistoryUnknown = ledger.trades_complete_since == null && ledger.execution_history_complete !== true;
  if (ledger.trades_complete_since && dateOf(ledger.trades_complete_since) > addDays(monday(asOf), -14)) executionHistoryUnknown = true;
  const seenIds = new Set();
  for (const e of ledger.events ?? []) {
    if (e.id && seenIds.has(e.id)) { issues.push(issue('duplicate_ledger_event', `重复账本事件 ${e.id} 未重复计数。`)); continue; }
    if (e.id) seenIds.add(e.id);
    if (!ACTUAL_TRADE_STATES.has(e.status) || !directionOf(e)) continue;
    const date = eventDate(e);
    if (!date || !finite(e.amount_cny)) { executionHistoryUnknown = true; continue; }
    const preciseTimes = [e.at, e.executed_at, e.confirmed_at, e.recorded_at].filter(Boolean);
    if (date > asOf || preciseTimes.some(t => !Number.isFinite(Date.parse(t)) || Date.parse(t) > Date.parse(cutoff))) continue;
    validEvents.push(e);
  }
  if (executionHistoryUnknown) issues.push(issue('trade_history_incomplete', '实际成交记录尚未确认完整；周度成交预算与冷却期需人工核对，建议不能标为可直接执行。'));
  const weekStart = monday(asOf), weeklyLimit = round(total * limits.weekly_one_way);
  const used = Object.fromEntries(['buy', 'sell'].map(dir => [dir, round(sum(validEvents.filter(e => directionOf(e) === dir && eventDate(e) >= weekStart).map(e => Math.abs(e.amount_cny))))]));
  const budget = { buy: Math.max(0, weeklyLimit - used.buy), sell: Math.max(0, weeklyLimit - used.sell) };
  const initialBudget = { ...budget };
  const lastReview = dateOf(ledger.last_monthly_rebalance_date ?? ledger.last_rebalance_date);
  const monthlyDue = !lastReview || lastReview.slice(0, 7) !== asOf.slice(0, 7);
  const driftBuckets = allocation.filter(a => a.target !== null && Math.abs(a.weight - a.target) >= (a.bucket === 'gold' ? limits.gold_drift : limits.drift)).map(a => a.bucket);

  const pendingSales = new Map();
  for (const e of ledger.events ?? []) if (['pending', 'submitted'].includes(e.status) && directionOf(e) === 'sell') pendingSales.set(e.holding_id ?? e.code, (pendingSales.get(e.holding_id ?? e.code) ?? 0) + (e.amount_cny ?? 0));
  const sellNeeds = new Map();
  function addSell(h, amount, priority, reason) {
    if (h.analysis_enabled === false || amount < 1) return;
    const existing = sellNeeds.get(h.id);
    if (!existing) sellNeeds.set(h.id, { h, amount, priority, reasons: [reason] });
    else { existing.amount = Math.max(existing.amount, amount); existing.priority = Math.min(existing.priority, priority); existing.reasons.push(reason); }
  }
  const categoryGroups = new Map();
  for (const h of rows) {
    const p = profiles[h.code] ?? {};
    const group = p.bucket === 'theme' ? p.theme_direction ?? exposureOf(h, p) : exposureOf(h, p);
    const key = `${p.bucket}:${group}`;
    if (!categoryGroups.has(key)) categoryGroups.set(key, []);
    categoryGroups.get(key).push(h);
  }
  for (const groupRows of categoryGroups.values()) {
    const p = profiles[groupRows[0].code] ?? {}, cap = p.bucket === 'theme' ? limits.theme_direction : p.bucket === 'pure_bond' ? limits.pure_bond_fund : null;
    if (!finite(cap)) continue;
    const groupAmount = sum(groupRows.map(h => h.amount_cny));
    const excess = groupAmount - total * cap;
    if (excess > 1) {
      issues.push(issue('concentration_limit', `${p.theme_direction ?? exposureOf(groupRows[0], p)}合计占比 ${(groupAmount / total * 100).toFixed(2)}%，超过 ${(cap * 100).toFixed(0)}% 上限。`));
      for (const h of groupRows) addSell(h, excess * h.amount_cny / groupAmount, 1, '合并同方向／同基金不同份额后，集中度超过上限。');
    }
  }
  for (const a of allocation) {
    if (a.bucket === 'cash' || a.gap_cny === null || a.gap_cny >= -1 || !(monthlyDue || driftBuckets.includes(a.bucket) || emergency)) continue;
    const relevant = rows.filter(h => profiles[h.code]?.bucket === a.bucket);
    for (const h of relevant) addSell(h, -a.gap_cny * h.amount_cny / a.amount_cny, a.bucket === 'theme' ? 2 : a.bucket === 'defensive_mixed' ? 3 : 4, `${a.bucket} 高于目标配置，分阶段减少。`);
  }
  if (freezeRisk) for (const h of rows.filter(h => RISK_BUCKETS.has(profiles[h.code]?.bucket) && profiles[h.code]?.bucket !== 'gold')) {
    addSell(h, h.amount_cny * (emergency ? .20 : .10), 1, '组合回撤触发风险复核，提出降低风险仓位的条件式方案。');
  }

  function commonConditions(h, direction) {
    const p = profiles[h.code] ?? {}, out = [];
    if (executionHistoryUnknown) out.push('核对实际成交账本完整性及本周已成交金额。');
    if (ledger.baseline?.reconciled === false) out.push('核对当前账户估值、外部本金与在途资金后再执行。');
    if (h.nav_date > asOf) out.push('移除截止时间之后的净值数据。');
    if (direction === 'sell' && h.batches_as_of !== asOf) out.push('需更新或确认本次批次份额、持有期和赎回费率仍适用。');
    const channelRules = direction === 'buy' ? p.subscription : p.redemption;
    const dealingRules = channelRules?.dealing ?? (channelRules?.cutoff_time ? channelRules : p.dealing);
    const timeVerified = /^([01]\d|2[0-3]):[0-5]\d$/.test(dealingRules?.cutoff_time ?? '') && dealingRules?.source_url && evidenceBefore(dealingRules, cutoff);
    if (!timeVerified) out.push('销售渠道当日申赎受理截止时间尚未核验，不能标为当日可执行；下单前核对截止时间，已过截止须在下一个基金开放日重核份额、费用、额度与资金。');
    else {
      try {
        const localTime = new Intl.DateTimeFormat('en-GB', { timeZone: dealingRules.timezone ?? 'Asia/Hong_Kong', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(cutoff));
        if (localTime >= dealingRules.cutoff_time) out.push(`已到或超过销售渠道当日 ${dealingRules.cutoff_time} 受理截止时间；本建议仅供下一个基金开放日重新核对份额、费用、额度及资金后参考。`);
      } catch { out.push('申赎截止时间的时区无效，需核实渠道受理时间后再执行。'); }
    }
    const fundCalendar = calendarFor(calendar, p, h.code);
    const dealing = openDayStatus(asOf, fundCalendar);
    if (!dealing.verified) out.push('需核实本日为基金开放申赎日，当前日历未完整验证。');
    if (dealing.verified && !dealing.open) out.push('本日不是已核验日历中的交易日，申请需等待下一个开放日。');
    if ((['nasdaq', 'us_broad'].includes(p.bucket) || p.kind?.startsWith('qdii')) && !calendar.by_code?.[h.code] && !calendar.calendars?.[p.calendar_key]) out.push('QDII 还需核实基金自身开放日及境外休市，不能仅凭境内交易日历。');
    const sameGroup = validEvents.filter(e => directionOf(e) === direction && (e.holding_id === h.id || e.code === h.code || (e.exposure_group ?? profiles[e.code]?.exposure_group) === exposureOf(h, p)));
    const latest = sameGroup.map(eventDate).sort().at(-1);
    let cooling = false;
    if (latest) {
      const days = countTradingDays(latest, asOf, calendarFor(calendar, p, h.code));
      cooling = days.count < limits.cooldown_trading_days;
      if (cooling) out.push(`同方向最近实际成交为 ${latest}，仅经过 ${days.count} 个${days.verified ? '交易日' : '估算工作日'}，需满 ${limits.cooldown_trading_days} 个交易日。`);
      if (!days.verified) out.push('冷却期使用工作日近似，需核实该基金开放日历（QDII包含境外休市）。');
    }
    const pendingSame = (ledger.events ?? []).some(e => ['pending', 'submitted'].includes(e.status) && directionOf(e) === direction && (e.holding_id === h.id || e.code === h.code));
    if (pendingSame) out.push('已有同方向在途订单，先确认其成交与剩余额度，避免重复提交。');
    return { conditions: out, cooling, pendingSame, closed: dealing.verified && !dealing.open };
  }

  for (const candidate of [...sellNeeds.values()].sort((a, b) => a.priority - b.priority || b.amount - a.amount || a.h.code.localeCompare(b.h.code))) {
    const { h } = candidate, p = profiles[h.code] ?? {};
    const pending = pendingSales.get(h.id) ?? pendingSales.get(h.code) ?? 0;
    const desired = Math.max(0, candidate.amount - pending);
    const maximumFromUnits = finite(h.redeemable_units) && finite(h.unit_nav) ? h.redeemable_units * h.unit_nav : h.amount_cny;
    let amount = round(Math.min(desired, maximumFromUnits, h.amount_cny, emergency ? h.amount_cny : budget.sell));
    const common = commonConditions(h, 'sell');
    const estimate = estimateRedemption(h, p, amount);
    const conditions = [...common.conditions, ...estimate.conditions];
    const hRow = holdings.find(x => x.holding_id === h.id);
    if (hRow.issues.some(i => i.code === 'holding_value_unreconciled')) conditions.push('核对持仓金额与份额×净值的差额。');
    if (!evidenceBefore(p.redemption, cutoff)) conditions.push('需补充截止时间前核验的赎回规则来源。');
    else if (!p.redemption?.source_url) conditions.push('需补充可追溯的赎回规则来源，核验时间本身不能证明先进先出规则。');
    const redemptionSuspended = p.redemption?.status === 'suspended';
    if (redemptionSuspended) conditions.push('当前记录为暂停赎回，需等待基金或渠道正式恢复受理后重新核对。');
    else if (p.redemption?.status !== 'open') conditions.push('需核实基金及销售渠道当前开放赎回；先进先出规则不代表当日一定受理。');
    let deferred = common.cooling || common.pendingSame || common.closed || redemptionSuspended || amount < 1;
    if (amount < 1) conditions.push('本周卖出额度已用尽，或无足够可赎回份额；等待下一次复核。');
    if (finite(estimate.fee_max_pct) && estimate.fee_max_pct > limits.max_routine_redemption_fee_pct && !emergency) {
      deferred = true;
      conditions.push(`涉及 ${estimate.fee_max_pct}% 赎回费，超过常规 ${limits.max_routine_redemption_fee_pct}% 阈值；优先等持有期满足低费档，并比较等待期间的价格风险。`);
    }
    if (emergency) conditions.push('组合风险预算已突破，允许超出常规周度及费率限制；须人工核实成本与风险后执行。');
    if (!deferred) budget.sell = Math.max(0, budget.sell - amount);
    recommendations.push({ id: `${asOf}:${h.id}:sell`, code: h.code, holding_id: h.id, name: h.name, bucket: p.bucket, direction: 'sell', amount_cny: amount, desired_total_cny: round(desired), remaining_after_proposal_cny: round(Math.max(0, desired - (deferred ? 0 : amount))), ...estimate, status: deferred ? 'deferred' : conditions.length ? 'conditional' : 'ready', conditions: [...new Set(conditions)], reason: [...new Set(candidate.reasons)].join(' '), priority: candidate.priority, emergency_override: emergency, funding: '赎回所得到账后才能用于后续买入，未计入本次可用现金。', cost_comparison: { redeem_now_fee_cny: estimate.fee_estimate_cny, wait_fee_cny: null, waiting_market_risk: '等待期间净值可能继续波动；未掌握精确购买日，无法计算降费日期。' } });
    hRow.direction = 'reduce'; hRow.dca_action = 'pause'; hRow.reason = candidate.reasons.join(' ');
  }

  const cashFloor = Math.max(0, total * target.cash - (amounts.cash - cashAmount));
  let buyCash = Math.max(0, cash.available_cash_upper_bound_cny - cashFloor);
  const buyPriority = ['pure_bond', 'us_broad', 'nasdaq', 'china_broad', 'gold', 'defensive_mixed', 'theme'];
  const proposedByGroup = new Map();
  const proposedByCode = new Map();
  for (const bucket of buyPriority) {
    const a = allocation.find(x => x.bucket === bucket);
    if (!a || a.gap_cny < 1 || !(monthlyDue || driftBuckets.includes(bucket))) continue;
    let gap = a.gap_cny;
    const candidates = rows.filter(h => profiles[h.code]?.bucket === bucket && h.analysis_enabled !== false && !sellNeeds.has(h.id)).sort((a, b) => {
      const score = h => ({ open: 0, limited: 1, unknown: 2, suspended: 3 })[profiles[h.code]?.subscription?.status ?? 'unknown'] ?? 2;
      return score(a) - score(b) || b.amount_cny - a.amount_cny || a.code.localeCompare(b.code);
    });
    for (const h of candidates) {
      if (gap < 1) break;
      const p = profiles[h.code], sub = p.subscription ?? {}, group = exposureOf(h, p);
      const common = commonConditions(h, 'buy'), conditions = [...common.conditions];
      if (cash.pending_unknown) conditions.push('核对在途买入及现金是否已经扣除，确认实际可用余额。');
      if (cash.dca_unknown) conditions.push('补全仍在运行的定投及扣款计划，预留其资金。');
      if (!evidenceBefore(sub, cutoff)) conditions.push('核实当前渠道申购状态、限额及公告生效日期。');
      else if (dateOf(sub.verified_at) < asOf) conditions.push('限购核验日期早于本次报告，需在当日下单页面复核是否变化。');
      if (!sub.source_url) conditions.push('补充当前渠道申购状态与限额的可追溯来源。');
      if (!['open', 'limited'].includes(sub.status)) conditions.push(sub.status === 'suspended' ? '当前记录为暂停申购，等待正式恢复公告。' : '当前可购买状态未知，不假设无限额。');
      if (sub.status === 'limited' && !finite(sub.daily_limit_cny)) conditions.push('限购金额未知，需核对每日额度。');
      if (freezeRisk && RISK_BUCKETS.has(bucket)) conditions.push('组合回撤已触发暂停新增风险资产。');
      const riskGroup = bucket === 'theme' ? `theme:${p.theme_direction ?? group}` : group;
      const holdingGroup = sum(rows.filter(x => bucket === 'theme'
        ? profiles[x.code]?.bucket === 'theme' && (profiles[x.code]?.theme_direction ?? exposureOf(x, profiles[x.code] ?? {})) === (p.theme_direction ?? group)
        : exposureOf(x, profiles[x.code] ?? {}) === group).map(x => x.amount_cny));
      const groupLimit = bucket === 'pure_bond' ? total * limits.pure_bond_fund : bucket === 'theme' ? total * limits.theme_direction : Infinity;
      const groupRemaining = Math.max(0, groupLimit - holdingGroup - (proposedByGroup.get(riskGroup) ?? 0));
      const dailyUsed = sum(validEvents.filter(e => directionOf(e) === 'buy' && e.code === h.code && eventDate(e) === asOf).map(e => e.amount_cny));
      const dailyLimit = finite(sub.daily_limit_cny) ? Math.max(0, sub.daily_limit_cny - dailyUsed - (proposedByCode.get(h.code) ?? 0)) : Infinity;
      const feePct = sub.fee_pct ?? p.purchase_fee_pct;
      if (!finite(feePct)) conditions.push('核实本渠道实际申购费率（包括优惠），费用不能默认零。');
      const amount = sub.status === 'suspended' ? 0 : round(Math.min(gap, budget.buy, buyCash, groupRemaining, dailyLimit));
      const deferred = amount < 1 || common.cooling || common.pendingSame || common.closed || sub.status === 'suspended' || (freezeRisk && RISK_BUCKETS.has(bucket));
      if (amount < 1) conditions.push('暂受现金、周度预算、单基金集中度或当日申购额度限制；不足部分保留现金并研究合适产品。');
      recommendations.push({ id: `${asOf}:${h.id}:buy`, code: h.code, holding_id: h.id, name: h.name, bucket, direction: 'buy', amount_cny: amount, desired_total_cny: round(gap), units_estimate: null, fee_estimate_cny: finite(feePct) ? round(amount - amount / (1 + feePct / 100)) : null, fee_max_pct: finite(feePct) ? feePct : null, status: deferred ? 'deferred' : conditions.length ? 'conditional' : 'ready', conditions: [...new Set(conditions)], reason: `${bucket} 低于长期目标，使用已到账新增资金分阶段补足；趋势指标仅作背景解释。`, priority: 5 + buyPriority.indexOf(bucket), funding: '仅使用已到账可用现金，扣除现金目标底仓、已知在途和已知近期定投预留。' });
      if (!deferred) { gap -= amount; budget.buy -= amount; buyCash -= amount; proposedByGroup.set(riskGroup, (proposedByGroup.get(riskGroup) ?? 0) + amount); proposedByCode.set(h.code, (proposedByCode.get(h.code) ?? 0) + amount); }
      const hRow = holdings.find(x => x.holding_id === h.id);
      hRow.direction = sub.status === 'suspended' || amount < 1 ? 'hold' : 'increase_conditionally';
      hRow.dca_action = sub.status === 'suspended' || (freezeRisk && RISK_BUCKETS.has(bucket)) ? 'pause' : 'review_before_resume';
      hRow.reason = sub.status === 'suspended' ? '申购暂停，保留已有份额并等待正式恢复公告；当前不安排买入或新增定投。' : '低于长期配置目标，但买入须满足额度、费用及资金核对条件。';
    }
    if (gap > 1) issues.push(issue('allocation_gap_unfilled', `${bucket} 仍有 ${gap.toFixed(2)} 元目标缺口；现有产品、限额或预算不能覆盖时继续留现金，不强行买满。`, 'info', { bucket, gap_cny: round(gap) }));
  }
  for (const h of holdings) {
    if (profiles[h.code]?.subscription?.status === 'suspended') h.dca_action = 'pause';
    else if (freezeRisk && RISK_BUCKETS.has(h.bucket)) h.dca_action = 'pause';
    else if (['theme', 'defensive_mixed'].includes(h.bucket) && amounts[h.bucket] > total * target[h.bucket]) h.dca_action = 'pause';
    else if (h.direction === 'hold') h.dca_action = cash.dca_unknown ? 'confirm_plan' : 'maintain_within_budget';
  }
  const proposed = recommendations.filter(r => r.status !== 'deferred');
  const proposedSell = sum(proposed.filter(r => r.direction === 'sell').map(r => r.amount_cny));
  const proposedBuy = sum(proposed.filter(r => r.direction === 'buy').map(r => r.amount_cny));
  const after = Object.fromEntries(allocation.map(a => [a.bucket, a.amount_cny]));
  for (const r of proposed) { after[r.bucket] += (r.direction === 'buy' ? 1 : -1) * r.amount_cny; after.cash += (r.direction === 'sell' ? 1 : -1) * r.amount_cny; }
  const summary = { as_of: asOf, cutoff, total_cny: total, fund_total_cny: round(fundTotal), cash_cny: cashAmount, holding_pnl_cny: pnlKnown ? round(sum(rows.map(h => h.holding_pnl_cny))) : null, known_holding_pnl_cny: round(sum(rows.map(h => finite(h.holding_pnl_cny) ? h.holding_pnl_cny : 0))), holding_pnl_complete: pnlKnown, performance_drawdown: drawdown, risk_state: riskState, external_flows_are_not_profit: true, recommendation_count: recommendations.length, ready_count: recommendations.filter(r => r.status === 'ready').length, conditional_count: recommendations.filter(r => r.status === 'conditional').length, deferred_count: recommendations.filter(r => r.status === 'deferred').length };
  return { summary, allocation, holdings, issues, recommendations, transition: { monthly_review_due: monthlyDue, drift_triggered_buckets: driftBuckets, weekly_start: weekStart, weekly_one_way_limit_cny: weeklyLimit, weekly_confirmed_buy_cny: used.buy, weekly_confirmed_sell_cny: used.sell, buy_budget_before_proposals_cny: round(initialBudget.buy), sell_budget_before_proposals_cny: round(initialBudget.sell), proposed_buy_cny: round(proposedBuy), proposed_sell_cny: round(proposedSell), cash, retained_cash_floor_cny: round(cashFloor), after_proposals_before_fees: Object.entries(after).map(([bucket, amount]) => ({ bucket, amount_cny: round(amount), weight: amount / total })), after_proposals_note: '仅为所有非延后建议在条件满足后执行并完成结算的情景，不是实际持仓；费用与净值波动另计，卖出在途未用于本次买入资金。', history_complete: !executionHistoryUnknown }, lookthrough: buildLookthrough(rows, profiles, total, asOf, cutoff) };
}
