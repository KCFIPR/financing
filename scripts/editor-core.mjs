// Shared by the editor and Node importer. Percentage values use percent units.
export function editorApiVersion() { return 'holdings-editor-pnl-v1'; }
// Exact days remain numbers; ranges remain strings so unknown exact ages are not invented.
export function normalizeHoldingDays(value, label = '持有天数') {
  if (value === '' || value == null) return null;
  const invalid = () => { throw new Error(`${label}：天数须为整数或有效区间，例如7-59、>=60天、<7天`); };
  if (!['string', 'number'].includes(typeof value)) return invalid();
  const input = String(value).trim().replace(/\s+/g, '').replace(/天$/, '')
    .replace(/[≥]/g, '>=').replace(/[≤]/g, '<=').replace(/[－–—~～至]/g, '-');
  if (!input) return invalid();
  const integer = v => { const n = Number(v); if (!Number.isSafeInteger(n) || n < 0) return invalid(); return n; };
  if (/^\d+$/.test(input)) return integer(input);
  const range = input.match(/^(\d+)-(\d+)$/);
  if (range) {
    const lower = integer(range[1]), upper = integer(range[2]);
    if (lower > upper) return invalid();
    return `${lower}-${upper}`;
  }
  const bound = input.match(/^(>=|>|<=|<)(\d+)$/);
  if (bound) {
    const days = integer(bound[2]);
    if (bound[1] === '<' && days === 0 || bound[1] === '>' && days === Number.MAX_SAFE_INTEGER) return invalid();
    return `${bound[1]}${days}`;
  }
  return invalid();
}

// Both endpoints are inclusive whole days. A null endpoint has no bound.
export function normalizeHoldingDayBounds(batch, label = '持有天数') {
  if (Object.hasOwn(batch, 'holding_days_min') || Object.hasOwn(batch, 'holding_days_max')) {
    const endpoint = value => {
      if (value === '' || value == null) return null;
      if (!['number','string'].includes(typeof value) || !/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new Error(`${label}：天数须为整数且非负`);
      return Number(value);
    };
    const min = endpoint(batch.holding_days_min), max = endpoint(batch.holding_days_max);
    if (min !== null && max !== null && min > max) throw new Error(`${label}下限不能大于上限`);
    return { holding_days_min: min, holding_days_max: max };
  }
  const days = normalizeHoldingDays(batch.holding_days, label);
  let min = null, max = null;
  if (typeof days === 'number') min = max = days;
  else if (days !== null) {
    const range = days.match(/^(\d+)-(\d+)$/);
    if (range) { min = Number(range[1]); max = Number(range[2]); }
    else {
      const [,op,value] = days.match(/^(>=|>|<=|<)(\d+)$/);
      if (op.startsWith('>')) min = Number(value) + (op === '>' ? 1 : 0);
      else max = Number(value) - (op === '<' ? 1 : 0);
    }
  }
  return { holding_days_min: min, holding_days_max: max };
}

export function formatHoldingDayBounds(batch) {
  const { holding_days_min: min, holding_days_max: max } = normalizeHoldingDayBounds(batch);
  if (min === null && max === null) return '未知';
  if (min === null) return `<=${max}`;
  if (max === null) return `>=${min}`;
  return min === max ? String(min) : `${min}-${max}`;
}

// Platform-reported current-position P/L; never infer it from cumulative P/L.
export function normalizeHoldingPnl(value, label = '持有收益') {
  if (value === '' || value == null) return null;
  if (typeof value === 'number' ? !Number.isFinite(value) : typeof value !== 'string' || !/^[+-]?\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value))) throw new Error(`${label}须为有效数字，亏损可填负数`);
  return Number(value);
}

export function estimateHoldingReturnPct(amount, pnl) {
  amount = normalizeHoldingPnl(amount, '持有金额');
  pnl = normalizeHoldingPnl(pnl);
  if (amount === null || pnl === null || amount < 0) return null;
  const cost = amount - pnl;
  if (!Number.isFinite(cost) || cost <= 0) return null;
  const pct = pnl / cost * 100;
  return Number.isFinite(pct) ? Number(pct.toFixed(6)) : null;
}

export function validateEditorDocument(doc, registered, allowedCodes, options = {}) {
  const { draft = false, today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' }), earliestDate = null } = options;
  if (doc?.format !== 'financing-holdings-editor-v1' || !Array.isArray(doc.holdings) || !doc.cash || typeof doc.cash !== 'object') throw new Error('不是有效的持仓JSON');
  const num = (v, label, required = false) => {
    if (v === '' || v == null) { if (required && !draft) throw new Error(`${label}不能为空`); return null; }
    if (typeof v === 'number' ? !Number.isFinite(v) || v < 0 : typeof v !== 'string' || !/^\d+(?:\.\d+)?$/.test(v) || !Number.isFinite(Number(v))) throw new Error(`${label}须为非负数字`);
    return Number(v);
  };
  const text = (v, label) => { if (v == null) return ''; if (typeof v !== 'string' || v.length > 10000) throw new Error(`${label}须为文本且不超过10000字`); return v; };
  const date = (v, label, required = false) => {
    if (v === '' || v == null) { if (required && !draft) throw new Error(`${label}不能为空`); return null; }
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number(v.slice(0,4)) < 1900 || !Number.isFinite(Date.parse(v)) || new Date(v + 'T00:00:00Z').toISOString().slice(0,10) !== v) throw new Error(`${label}须填写有效日期YYYY-MM-DD`);
    if (v > today) throw new Error(`${label}不能晚于今天`);
    return v;
  };
  const snapshotDate = date(doc.snapshot_date, '查看日期', true);
  if (snapshotDate && earliestDate && snapshotDate < earliestDate) throw new Error('不能用较早日期覆盖当前持仓快照');
  const known = new Map(registered.map(h => [h.id,h]));
  const seen = new Set();
  const holdings = doc.holdings.map(h => {
    if (!h || typeof h.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(h.id) || h.id === 'CASH01' || seen.has(h.id)) throw new Error('持仓编号无效或重复');
    seen.add(h.id);
    const old = known.get(h.id);
    if (typeof h.code !== 'string' || !/^\d{6}$/.test(h.code)) throw new Error(`${h.id}基金代码须为六位数字`);
    const name = text(h.name,`${h.id}基金名称`).trim();
    const platform = text(h.platform,`${h.id}平台`).trim();
    if (!name || !platform) throw new Error(`${h.id}基金名称和平台不能为空`);
    const analysisEnabled = h.analysis_enabled ?? true;
    if (typeof analysisEnabled !== 'boolean') throw new Error(`${h.id}分析状态须为布尔值`);
    const category = h.category ?? old?.category ?? 'other';
    if (!['bond','equity','gold','money_market','mixed','other'].includes(category)) throw new Error(`${h.id}投资类型无效`);
    if (typeof h.all_redeemable !== 'boolean' || !Array.isArray(h.batches) || h.batches.length > 1000) throw new Error(`${h.id}批次或可赎回状态无效`);
    const amount = num(h.amount_cny, `${h.id}持有金额`, analysisEnabled);
    const pnl = normalizeHoldingPnl(h.holding_pnl_cny,`${h.id}持有收益`);
    const estimatedReturn = estimateHoldingReturnPct(amount,pnl);
    const nav = num(h.unit_nav, `${h.id}单位净值`);
    const navDate = date(h.nav_date, `${h.id}净值日期`);
    if (nav !== null && (nav <= 0 || (!navDate && !draft && analysisEnabled))) throw new Error(`${h.id}填写正式单位净值时，请填写净值日期，且净值须大于0`);
    if (snapshotDate && navDate && navDate > snapshotDate) throw new Error(`${h.id}净值日期不能晚于查看日期`);
    const batches = h.batches.map((b,i) => {
      if (!b || typeof b !== 'object') throw new Error(`${h.id}批次无效`);
      const units = num(b.units, `${h.id}批次${i+1}份额`);
      const bounds = normalizeHoldingDayBounds(b, `${h.id}批次${i+1}持有天数`);
      const fee = num(b.redemption_fee_pct, `${h.id}批次${i+1}赎回费率`);
      if (units !== null && units <= 0 || fee !== null && fee > 100) throw new Error(`${h.id}批次份额须大于0，费率须在0至100之间`);
      if (!draft && analysisEnabled && units === null && (bounds.holding_days_min !== null || bounds.holding_days_max !== null || fee !== null)) throw new Error(`${h.id}批次${i+1}份额不能为空`);
      return { units, ...bounds, redemption_fee_pct: fee };
    });
    const positiveUnits = batches.filter(b => b.units !== null).reduce((s,b) => s+b.units,0);
    const redeemable = h.all_redeemable ? null : num(h.redeemable_units,`${h.id}可赎回份额`);
    if (redeemable !== null && batches.some(b => b.units !== null) && redeemable > positiveUnits + 1e-8) throw new Error(`${h.id}可赎回份额超过总份额`);
    if (amount === 0 && positiveUnits > 0) throw new Error(`${h.id}金额为0但仍有正份额，请核对`);
    return { id:h.id, code:h.code, name, platform, category, analysis_enabled:analysisEnabled, excluded_reason:text(h.excluded_reason,`${h.id}暂不分析原因`), previous_amount_cny: num(h.previous_amount_cny,`${h.id}旧金额`), amount_cny: amount, holding_pnl_cny:pnl, estimated_holding_return_pct:estimatedReturn, holding_return_pct:normalizeHoldingPnl(h.holding_return_pct,`${h.id}持有收益率`), unit_nav: nav, nav_date: navDate, all_redeemable: h.all_redeemable, redeemable_units: redeemable, pending_buy_cny: num(h.pending_buy_cny,`${h.id}待确认申购`), pending_redemption_receivable_cny: num(h.pending_redemption_receivable_cny,`${h.id}待到账赎回`), notes: text(h.notes,`${h.id}备注`), batches };
  });
  return { format: doc.format, status: draft ? 'draft' : 'validated', snapshot_date: snapshotDate, cash: { amount_cny: num(doc.cash.amount_cny,'可用现金',true), pending_buy_cny: num(doc.cash.pending_buy_cny,'现金待确认申购'), pending_redemption_receivable_cny: num(doc.cash.pending_redemption_receivable_cny,'现金待到账赎回'), notes: text(doc.cash.notes,'现金备注') }, holdings };
}

export function createEditorDocument(current) {
  const knownDate = !!current.snapshot_date;
  return { format: 'financing-holdings-editor-v1', status: 'draft', snapshot_date: current.snapshot_date || null,
    cash: { amount_cny: current.strategy_cash?.amount_cny ?? null, pending_buy_cny: current.strategy_cash?.pending_buy_cny ?? null, pending_redemption_receivable_cny: current.strategy_cash?.pending_redemption_receivable_cny ?? null, notes: current.strategy_cash?.notes || '' },
    holdings: [...current.holdings,...(current.excluded_holdings || [])].map(h => ({ id:h.id, code:h.code, name:h.name, platform:h.platform, category:h.category || 'other', analysis_enabled:h.analysis_enabled ?? true, excluded_reason:h.excluded_reason || '', previous_amount_cny:h.amount_cny, amount_cny:knownDate ? h.amount_cny : null, holding_pnl_cny:knownDate ? h.holding_pnl_cny ?? null : null, holding_return_pct:knownDate ? h.holding_return_pct ?? null : null, estimated_holding_return_pct:knownDate ? estimateHoldingReturnPct(h.amount_cny,h.holding_pnl_cny) : null, unit_nav:h.unit_nav ?? null, nav_date:h.nav_date ?? null, all_redeemable:h.redeemability_basis !== 'user_reported_redeemable_units', redeemable_units:h.redeemable_units ?? null, pending_buy_cny:h.pending_buy_cny ?? null, pending_redemption_receivable_cny:h.pending_redemption_receivable_cny ?? null, notes:knownDate ? h.notes || '' : '', batches:h.batches?.length ? h.batches.map(b => ({units:b.units,...normalizeHoldingDayBounds(b),redemption_fee_pct:b.redemption_fee_pct})) : [{units:null,holding_days_min:null,holding_days_max:null,redemption_fee_pct:null}] })) };
}

export function parseEditorJson(doc, previous, mandate, today) {
  const previousRecords = [...previous.holdings,...(previous.excluded_holdings || [])];
  const normalized = validateEditorDocument(doc, previousRecords, mandate.allowed_fund_codes, {today,earliestDate:previous.snapshot_date});
  const old = new Map(previousRecords.map(h => [h.id,h]));
  const records = normalized.holdings.map(h => {
    const candidate = old.get(h.id);
    const former = candidate?.code === h.code && candidate?.platform === h.platform ? candidate : {};
    const batches = h.batches.filter(b => b.units !== null);
    const units = batches.length ? Number(batches.reduce((s,b) => s+b.units,0).toFixed(8)) : null;
    return { ...former, id:h.id, code:h.code, name:h.name, platform:h.platform, category:h.category, analysis_enabled:h.analysis_enabled, excluded_reason:h.excluded_reason, amount_cny:h.amount_cny, holding_pnl_cny:h.holding_pnl_cny, holding_return_pct:h.holding_return_pct, estimated_holding_return_pct:h.estimated_holding_return_pct, snapshot_date:normalized.snapshot_date, units, redeemable_units:h.all_redeemable ? units : h.redeemable_units, unit_nav:h.unit_nav, nav_date:h.nav_date, first_holding_date:null, batches_as_of:normalized.snapshot_date, batches:batches.map((b,i) => ({batch_id:i+1,...b})), redeemability_basis:h.all_redeemable ? 'user_confirmed_all_units_redeemable' : 'user_reported_redeemable_units', pending_buy_cny:h.pending_buy_cny, pending_redemption_receivable_cny:h.pending_redemption_receivable_cny, notes:h.notes, reported_cumulative_pnl_cny:null, previous_reported_cumulative_pnl_cny:former.reported_cumulative_pnl_cny ?? former.previous_reported_cumulative_pnl_cny ?? null };
  });
  const holdings = records.filter(h => h.analysis_enabled);
  const excludedHoldings = records.filter(h => !h.analysis_enabled);
  const cash = {id:'CASH01',name:'策略可用现金',platform:'后备资金',snapshot_date:normalized.snapshot_date,...normalized.cash};
  const total = values => Number(values.reduce((s,v) => s+v,0).toFixed(2));
  const pending = prop => {const values = holdings.map(h => h[prop]).concat(cash[prop]); return values.every(v => v !== null) ? total(values) : null;};
  const fundTotal = total(holdings.map(h => h.amount_cny));
  return { ...previous, schema_version:5, snapshot_date:normalized.snapshot_date, imported_at:new Date().toISOString(), amount_basis:'user_updated_platform_holding_value', holdings, excluded_holdings:excludedHoldings, removed_holding_ids:previousRecords.filter(h => !records.some(r => r.id === h.id)).map(h => h.id), analysis_fund_codes:[...new Set(holdings.map(h => h.code))], strategy_cash:cash, fund_total_cny:fundTotal, fund_plus_available_cash_cny:total([fundTotal,cash.amount_cny]), pending_buy_total_cny:pending('pending_buy_cny'), pending_redemption_total_cny:pending('pending_redemption_receivable_cny'), pending_amounts_added_to_total:false, pending_amount_basis:'not_reconciled_with_platform_totals; never_add_automatically', missing_execution_fields:holdings.filter(h => h.amount_cny > 0 && (h.units === null || h.redeemable_units === null || !h.batches.length || h.batches.some(b => (b.holding_days_min === null && b.holding_days_max === null) || b.redemption_fee_pct === null))).map(h => h.id) };
}

export function editorRows(doc, headers) {
  if (doc?.format !== 'financing-holdings-editor-v1' || !Array.isArray(doc.holdings) || !doc.cash) throw new Error('不是持仓填写页面导出的JSON');
  const num = (v, label, optional = true) => {
    if (v === '' || v === null || v === undefined) {
      if (optional) return null;
      throw new Error(`${label}不能为空`);
    }
    if (!['string', 'number'].includes(typeof v) || !/^\d+(?:\.\d+)?$/.test(String(v)) || !Number.isFinite(Number(v))) throw new Error(`${label}须为非负数字`);
    return Number(v);
  };
  const rows = [headers];
  for (const h of doc.holdings) {
    if (!Array.isArray(h.batches) || typeof h.all_redeemable !== 'boolean') throw new Error(`${h.id}批次或可赎回状态无效`);
    const amount = num(h.amount_cny, `${h.id}持有金额`, false);
    const pnl = normalizeHoldingPnl(h.holding_pnl_cny,`${h.id}持有收益`);
    const returnPct = normalizeHoldingPnl(h.holding_return_pct,`${h.id}持有收益率`);
    const estimatedReturn = estimateHoldingReturnPct(amount,pnl);
    const batches = h.batches.filter(b => [b.units, b.holding_days, b.holding_days_min, b.holding_days_max, b.redemption_fee_pct].some(v => v !== '' && v != null));
    for (const b of batches) {
      const units = num(b.units, `${h.id}批次份额`, false);
      normalizeHoldingDayBounds(b, `${h.id}持有天数`);
      const fee = num(b.redemption_fee_pct, `${h.id}赎回费率`);
      if (units <= 0 || (fee !== null && fee > 100)) throw new Error(`${h.id}批次份额须大于0，费率须在0至100之间`);
    }
    const total = batches.length ? Number(batches.reduce((s, b) => s + Number(b.units), 0).toFixed(8)) : null;
    const redeemable = h.all_redeemable ? total : num(h.redeemable_units, `${h.id}可赎回份额`);
    if (redeemable !== null && total !== null && redeemable > total + 1e-8) throw new Error(`${h.id}可赎回份额超过总份额`);
    const nav = num(h.unit_nav, `${h.id}单位净值`);
    if (nav !== null && (nav <= 0 || !h.nav_date)) throw new Error(`${h.id}填写正式单位净值时，请填写净值日期，且净值须大于0`);
    const details = batches.map((b, i) => `批次${i + 1}：${b.units}份，持有${formatHoldingDayBounds(b)}天，赎回费率${b.redemption_fee_pct === '' || b.redemption_fee_pct == null ? '未知' : b.redemption_fee_pct + '%'}`).join('；');
    rows.push([doc.snapshot_date, h.id, h.code, h.name, h.platform, amount, total, redeemable, h.nav_date || '', '', num(h.pending_buy_cny, `${h.id}待确认申购`), num(h.pending_redemption_receivable_cny, `${h.id}待到账赎回`), [h.notes, pnl === null ? '' : `持有收益${pnl}元`, returnPct === null ? '' : `平台持有收益率${returnPct}%`, estimatedReturn === null ? '' : `估算持有收益率${estimatedReturn}%`, nav === null ? '' : `正式单位净值${nav}元`, details ? `批次信息截至${doc.snapshot_date}；${details}` : ''].filter(Boolean).join('；')]);
  }
  rows.push([doc.snapshot_date, 'CASH01', '', '策略可用现金', '后备资金', num(doc.cash.amount_cny, '可用现金', false), '', '', '', '', num(doc.cash.pending_buy_cny, '现金待确认申购'), num(doc.cash.pending_redemption_receivable_cny, '现金待到账赎回'), doc.cash.notes || '']);
  return rows;
}

export function attachEditorDetails(snapshot, doc) {
  const input = new Map(doc.holdings.map(h => [h.id, h]));
  const optional = v => v === '' || v == null ? null : Number(v);
  snapshot.schema_version = 5;
  for (const h of snapshot.holdings) {
    const source = input.get(h.id);
    h.holding_pnl_cny = normalizeHoldingPnl(source.holding_pnl_cny,`${h.id}持有收益`);
    h.holding_return_pct = normalizeHoldingPnl(source.holding_return_pct,`${h.id}持有收益率`);
    h.estimated_holding_return_pct = estimateHoldingReturnPct(h.amount_cny,h.holding_pnl_cny);
    h.reported_cumulative_pnl_cny = null;
    h.unit_nav = optional(source.unit_nav);
    h.batches_as_of = snapshot.snapshot_date;
    h.batches = source.batches.filter(b => b.units !== '' && b.units != null).map((b, i) => ({ batch_id: i + 1, units: Number(b.units), ...normalizeHoldingDayBounds(b), redemption_fee_pct: optional(b.redemption_fee_pct) }));
    h.redeemability_basis = source.all_redeemable ? 'user_confirmed_all_units_redeemable' : 'user_reported_redeemable_units';
  }
  snapshot.missing_execution_fields = snapshot.holdings.filter(h => h.amount_cny > 0 && (h.units === null || h.redeemable_units === null || !h.batches.length || h.batches.some(b => (b.holding_days_min === null && b.holding_days_max === null) || b.redemption_fee_pct === null))).map(h => h.id);
  return snapshot;
}
