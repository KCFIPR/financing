import { createHash } from 'node:crypto';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const sum = values => Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100;

export function parseFred(text, code) {
  const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  if (!['observation_date', 'DATE'].includes(lines[0]?.split(',')[0]) || lines[0]?.split(',')[1] !== code) throw new Error('Unexpected FRED header');
  let previous = '';
  const series = lines.slice(1).map(line => {
    const cells = line.split(',');
    const [date, raw] = cells;
    if (cells.length !== 2 || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date <= previous) throw new Error('Invalid or unordered FRED date');
    previous = date;
    const value = raw === '' || raw === '.' ? null : Number(raw);
    if (value !== null && !Number.isFinite(value)) throw new Error('Invalid FRED value');
    return { date, value };
  });
  if (!series.some(p => p.value !== null)) throw new Error('Empty FRED observations');
  return series;
}

export function parseHoldings(markdown) {
  const result = [];
  for (const line of markdown.split(/\r?\n/)) {
    const cells = line.split('|').slice(1, -1).map(x => x.trim());
    if (!/^[BEG]\d{2}$/.test(cells[0] ?? '')) continue;
    const code = cells[1].match(/^\d{6}/)?.[0];
    const amount = Number(cells[5].replaceAll(',', ''));
    const pnl = Number(cells[6].replaceAll(',', ''));
    if (!code || !Number.isFinite(amount) || amount <= 0 || !Number.isFinite(pnl)) throw new Error(`Invalid holding ${cells[0]}`);
    result.push({ id: cells[0], code, name: cells[2], share_class: cells[3], category: { B: 'bond', E: 'equity', G: 'gold' }[cells[0][0]], amount_cny: amount, reported_cumulative_pnl_cny: pnl, platform: cells[9], code_confirmed_by_user: !cells[1].includes('按名称补'), snapshot_date: null });
  }
  if (new Set(result.map(x => x.id)).size !== result.length) throw new Error('Duplicate holding ID');
  return result;
}

// Parse JSON literals only. Remote JavaScript is never executed.
function literal(text, variable) {
  const match = text.match(new RegExp(`(?:var|let|const)\\s+${variable}\\s*=\\s*([\\s\\S]*?);`));
  if (!match) throw new Error(`Missing ${variable}`);
  return JSON.parse(match[1]);
}

export function parseFundIdentity(text, expectedCode) {
  const code = literal(text, 'fS_code');
  if (code !== expectedCode) throw new Error(`Fund code mismatch: ${code} != ${expectedCode}`);
  const name = literal(text, 'fS_name');
  if (typeof name !== 'string' || !name.trim() || name.length > 200) throw new Error('Invalid fund name');
  return { code, name: name.trim() };
}

export function parseFund(text, expectedCode) {
  const {code,name} = parseFundIdentity(text,expectedCode);
  if (/var\s+Data_millionCopiesIncome\s*=/.test(text)) {
    const income = literal(text, 'Data_millionCopiesIncome');
    const annual = new Map(literal(text, 'Data_sevenDaysYearIncome'));
    let last = -Infinity;
    const series = income.map(([timestamp, value]) => {
      if (!Number.isSafeInteger(timestamp) || timestamp <= last || !Number.isFinite(Number(value))) throw new Error('Invalid money-market income history');
      last = timestamp;
      return { date: new Date(timestamp + 8 * 3600_000).toISOString().slice(0,10), income_per_10000_cny: Number(value), seven_day_annualized_pct: annual.has(timestamp) ? Number(annual.get(timestamp)) : null };
    });
    if (!series.length) throw new Error('Empty money-market income history');
    return { code, name, series, series_kind: 'money_market_income', currency: 'CNY', adjusted_for_distributions: false, publication_date: null, publication_date_note: '万份收益与七日年化；不能当单位净值或保证收益。' };
  }
  const points = literal(text, 'Data_netWorthTrend');
  if (!Array.isArray(points) || points.length === 0) throw new Error('Empty NAV history');
  let previous = -Infinity;
  const series = points.map(p => {
    if (!Number.isSafeInteger(p.x) || p.x <= previous || !Number.isFinite(p.y) || p.y <= 0) throw new Error('Invalid or unordered NAV history');
    previous = p.x;
    // Provider timestamps correspond to China calendar dates.
    const date = new Date(p.x + 8 * 3600_000).toISOString().slice(0, 10);
    return { date, unit_nav: p.y, provider_daily_change_pct: Number.isFinite(p.equityReturn) ? p.equityReturn : null, corporate_action_note: p.unitMoney || null };
  });
  return { code, name, series, series_kind: 'unit_nav', currency: 'CNY', adjusted_for_distributions: false, publication_date: null, publication_date_note: '接口未提供；日期为净值所属日。不能据此推断历史公开时间。' };
}

// A later provider payload can lose cash amounts from historical action labels.
// Restore only an unambiguous same-code/date/NAV event from immutable local evidence.
export function reconcileCorporateActions(parsed, archives) {
  const valid = note => /(?:每份派现金\s*\d+(?:\.\d+)?元|每\s*\d+(?:\.\d+)?\s*份派现金\s*\d+(?:\.\d+)?元)/.test(note || '');
  const result=structuredClone(parsed);
  result.corporate_action_reconciliation=[];
  for(const point of result.series) {
    if(!point.corporate_action_note || valid(point.corporate_action_note))continue;
    const candidates=archives.filter(a=>a.code===parsed.code).flatMap(a=>a.series.filter(p=>p.date===point.date && p.unit_nav===point.unit_nav && valid(p.corporate_action_note)).map(p=>({note:p.corporate_action_note,source_sha256:a.sha256,raw_file:a.raw_file,collected_at:a.collected_at})));
    const distinct=[...new Set(candidates.map(x=>x.note))];
    if(distinct.length!==1)continue;
    const evidence=candidates[0];
    result.corporate_action_reconciliation.push({date:point.date,original_note:point.corporate_action_note,restored_note:evidence.note,...evidence});
    point.original_corporate_action_note=point.corporate_action_note;
    point.corporate_action_note=evidence.note;
    point.corporate_action_source=evidence;
  }
  return result;
}

export function validateSnapshot(snapshot) {
  if (!Array.isArray(snapshot.holdings)) throw new Error('Missing holdings');
  if (snapshot.snapshot_date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.snapshot_date)) throw new Error('Invalid snapshot date');
  const ids = new Set();
  for (const h of snapshot.holdings) {
    if (ids.has(h.id)) throw new Error('Duplicate holding ID');
    ids.add(h.id);
    if (!/^\d{6}$/.test(h.code) || !Number.isFinite(h.amount_cny) || h.amount_cny < 0) throw new Error('Invalid holding');
  }
  return { count: snapshot.holdings.length, codes: new Set(snapshot.holdings.map(h => h.code)).size, total_cny: sum(snapshot.holdings.map(h => h.amount_cny)) };
}

export function staleness(date, now = new Date(), thresholdDays = 7) {
  const days = Math.floor((now.getTime() - Date.parse(`${date}T00:00:00+08:00`)) / 86400_000);
  if (!Number.isFinite(days)) return { state: 'invalid', days: null };
  return { state: days < -1 ? 'future' : days > thresholdDays ? 'stale' : 'recent', days };
}
