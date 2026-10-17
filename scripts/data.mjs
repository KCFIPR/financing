import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFund, parseFred, validateSnapshot, sha256, sum, staleness, reconcileCorporateActions } from './lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resolve = p => path.join(root, p);
const readJson = async p => JSON.parse((await fs.readFile(resolve(p), 'utf8')).replace(/^\uFEFF/, ''));
async function writeJson(p, data) {
  await fs.mkdir(path.dirname(resolve(p)), { recursive: true });
  const temp = resolve(`${p}.tmp`);
  await fs.writeFile(temp, `${JSON.stringify(data, null, 2)}\n`);
  await fs.rename(temp, resolve(p));
}
async function append(p, data) {
  await fs.mkdir(path.dirname(resolve(p)), { recursive: true });
  await fs.appendFile(resolve(p), `${JSON.stringify(data)}\n`);
}
async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(45000), headers: { 'User-Agent': 'PortfolioDataWorkbench/0.1', 'Accept': '*/*' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw new Error('Empty response');
  return { bytes, content_type: response.headers.get('content-type'), final_url: response.url };
}
async function archive(source, key, result, extension) {
  const hash = sha256(result.bytes);
  const file = `data/raw/${source}/${key}/${hash}.${extension}`;
  await fs.mkdir(path.dirname(resolve(file)), { recursive: true });
  await fs.writeFile(resolve(file), result.bytes);
  return { raw_file: file, sha256: hash, content_type: result.content_type, final_url: result.final_url };
}
async function init() {
  const { initializeWorkspace } = await import('./init.mjs');
  console.log(`已创建${(await initializeWorkspace(root)).length}个本地文件，已有数据未覆盖。`);
}
export async function collect(options = []) {
  const snapshot = await readJson('data/holdings/current.json');
  validateSnapshot(snapshot);
  const codes = [...new Set(snapshot.holdings.map(h => h.code))];
  const requested = options.find(x => x.startsWith('--codes='))?.slice(8).split(',');
  if (requested?.some(c => !codes.includes(c))) throw new Error('Requested code is not in holdings');
  const selected = requested ?? codes;
  const config = (await readJson('config/sources.json')).sources.find(s => s.id === 'eastmoney_nav');
  const failures = [];
  const runId = new Date().toISOString();
  for (const code of selected) {
    const url = config.url_template.replace('{code}', code);
    const record = { run_id: runId, source_id: config.id, code, requested_url: url, attempted_at: new Date().toISOString() };
    try {
      const response = await download(url);
      const raw = await archive(config.id, code, response, 'js');
      Object.assign(record, raw);
      let parsed = parseFund(response.bytes.toString('utf8'), code);
      const versions=await fs.readdir(resolve(`data/normalized/nav/${code}`)).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
      const archives=[];
      for(const file of versions.filter(f=>f.endsWith('.json'))) {
        const archived=await readJson(`data/normalized/nav/${code}/${file}`);
        if(archived.raw_file && sha256(await fs.readFile(resolve(archived.raw_file)))===archived.sha256)archives.push(archived);
      }
      parsed=reconcileCorporateActions(parsed,archives);
      const dataDate = parsed.series.at(-1).date;
      const quality = staleness(dataDate);
      if (quality.state === 'future' || quality.state === 'invalid') throw new Error(`Unexpected NAV date ${dataDate}`);
      const output = { schema_version: 1, ...parsed, source_id: config.id, original_provider: config.origin, requested_url: url, collected_at: new Date().toISOString(), data_date: dataDate, quality, official_crosscheck: 'pending', ...raw };
      const version = `data/normalized/nav/${code}/${raw.sha256}-${sha256(JSON.stringify(output)).slice(0,16)}.json`;
      await writeJson(version, output);
      await writeJson(`data/normalized/nav/${code}.json`, output);
      Object.assign(record, { status: 'success', data_date: dataDate, row_count: parsed.series.length, normalized_file: version, quality });
      console.log(`${code}: ${parsed.series.length}行，截止${dataDate}，${quality.state}`);
    } catch (error) {
      Object.assign(record, { status: 'failed', error: error.message });
      failures.push(code);
      console.error(`${code}: 失败 ${error.message}`);
    }
    record.completed_at = new Date().toISOString();
    await append('data/manifests/collection.jsonl', record);
    await writeJson(`data/status/nav/${code}.json`, record);
  }
  await status();
  return { failures };
}
async function reports() {
  const { documents } = await readJson('config/documents.json');
  const snapshot = await readJson('data/holdings/current.json');
  const includedCodes = new Set(snapshot.holdings.map(h => h.code));
  let failures = 0;
  for (const doc of documents.filter(d => includedCodes.has(d.code))) {
    const record = { ...doc, source_id: 'fund_disclosures', collected_at: new Date().toISOString() };
    try {
      const result = await download(doc.url);
      const raw = await archive('fund_disclosures', doc.id, result, 'pdf');
      Object.assign(record, raw);
      if (result.bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('Response is not a PDF');
      record.status = 'downloaded_content_review_pending';
      console.log(`${doc.id}: 已归档（内容与最新性待核查）`);
    } catch (error) { record.status = 'failed'; record.error = error.message; failures++; console.error(`${doc.id}: ${error.message}`); }
    await append('data/manifests/documents.jsonl', record);
    await writeJson(`data/status/documents/${doc.id}.json`, record);
  }
  await status();
  if (failures) process.exitCode = 1;
}
export async function market() {
  let failures = 0;
  for (const item of (await readJson('config/market-series.json')).series) {
    const record = { ...item, attempted_at: new Date().toISOString() };
    try {
      const response = await download(item.url);
      const raw = await archive(item.source_id, item.id, response, 'csv');
      Object.assign(record, raw);
      const series = parseFred(response.bytes.toString('utf8'), item.id);
      const dataDate = series.findLast(p => p.value !== null).date;
      const quality = staleness(dataDate, new Date(), item.freshness_calendar_days);
      if (quality.state === 'future' || quality.state === 'invalid') throw new Error('Unexpected future/invalid market observation');
      const output = { schema_version: 1, ...item, ...raw, series, collected_at: new Date().toISOString(), data_date: dataDate, quality, publication_date: null, vintage: 'latest_revised_at_collection', historical_point_in_time_safe: false, missing_values: 'null; never forward-filled', limitations: '公开下载序列，非API连接；历史修订值不能直接用于时点回测。DEXCHUS不是中国央行中间价或基金估值汇率。' };
      await writeJson(`data/normalized/market/${item.id}/${raw.sha256}.json`, output);
      await writeJson(`data/normalized/market/${item.id}.json`, output);
      Object.assign(record, { status: 'success', data_date: dataDate, row_count: series.length, quality });
      console.log(`${item.id}: ${series.length}行，截止${dataDate}，${quality.state}`);
    } catch (error) { failures++; record.status = 'failed'; record.error = error.message; console.error(`${item.id}: ${error.message}`); }
    record.completed_at = new Date().toISOString();
    await append('data/manifests/market.jsonl', record);
    await writeJson(`data/status/market/${item.id}.json`, record);
  }
  await status();
  return { failures };
}
async function optionalJson(p) { try { return await readJson(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
export async function verify() {
  const snapshot = await readJson('data/holdings/current.json');
  validateSnapshot(snapshot);
  // Recover the unchanged original prefix for the first import made before
  // source archiving was added. Accept only an exact recorded hash match.
  if (!snapshot.source_archive) {
    const text = (await fs.readFile(resolve(snapshot.source_file), 'utf8')).split(/\r?\n## 十一、/)[0];
    const base = text.replace(/\r\n/g, '\n').replace(/\n+$/, '');
    let original;
    for (const eol of ['\n', '\r\n']) for (let n = 0; n < 4; n++) {
      const candidate = base.replace(/\n/g, eol) + eol.repeat(n);
      if (sha256(candidate) === snapshot.source_sha256) original = candidate;
    }
    if (original === undefined) throw new Error('Imported source version not found');
    snapshot.source_archive = `data/raw/holdings/${snapshot.source_sha256}.md`;
    await fs.mkdir(resolve('data/raw/holdings'), { recursive: true });
    await fs.writeFile(resolve(snapshot.source_archive), original);
    await writeJson('data/holdings/current.json', snapshot);
  }
  if (sha256(await fs.readFile(resolve(snapshot.source_archive))) !== snapshot.source_sha256) throw new Error('Imported source hash mismatch');
  let checked = 0;
  for (const manifest of ['collection', 'documents', 'market']) {
    let text;
    try { text = await fs.readFile(resolve(`data/manifests/${manifest}.jsonl`), 'utf8'); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    for (const line of text.trim().split('\n').filter(Boolean)) {
      const record = JSON.parse(line);
      if (!record.raw_file) continue;
      const rawPath = resolve(record.raw_file);
      if (!rawPath.startsWith(`${resolve('data/raw')}${path.sep}`)) throw new Error('Raw archive path escapes data/raw');
      const bytes = await fs.readFile(rawPath);
      if (sha256(bytes) !== record.sha256) throw new Error(`Hash mismatch ${record.raw_file}`);
      if (record.normalized_file) {
        const normalized = await readJson(record.normalized_file);
        if (normalized.sha256 !== record.sha256 || normalized.code !== record.code || normalized.series.length !== record.row_count) throw new Error('Normalized NAV metadata mismatch');
      }
      checked++;
    }
  }
  console.log(`校验通过：持仓结构、${checked}条原始归档记录及关联净值版本。`);
}
export async function status() {
  const snapshot = await readJson('data/holdings/current.json');
  const check = validateSnapshot(snapshot);
  const sources = (await readJson('config/sources.json')).sources;
  const codes = [...new Set(snapshot.holdings.map(h => h.code))];
  const coverage = [];
  for (const code of codes) {
    const nav = await optionalJson(`data/normalized/nav/${code}.json`);
    const latestAttempt = await optionalJson(`data/status/nav/${code}.json`);
    coverage.push({ code, amount_cny: sum(snapshot.holdings.filter(h => h.code === code).map(h => h.amount_cny)), data_date: nav?.data_date ?? null, collected_at: nav?.collected_at ?? null, rows: nav?.series.length ?? 0, quality: nav ? staleness(nav.data_date) : { state: 'missing', days: null }, latest_attempt_status: latestAttempt?.status ?? 'not_run', error: latestAttempt?.error ?? null, official_crosscheck: nav?.official_crosscheck ?? 'pending' });
  }
  const docs = [];
  for (const doc of (await readJson('config/documents.json')).documents.filter(d => codes.includes(d.code))) docs.push(await optionalJson(`data/status/documents/${doc.id}.json`) ?? { ...doc, status: 'not_run' });
  const marketCoverage = [];
  for (const item of (await readJson('config/market-series.json')).series) {
    const data = await optionalJson(`data/normalized/market/${item.id}.json`);
    const attempt = await optionalJson(`data/status/market/${item.id}.json`);
    marketCoverage.push({ id: item.id, data_date: data?.data_date ?? null, rows: data?.series.length ?? 0, quality: data ? staleness(data.data_date, new Date(), item.freshness_calendar_days) : { state: 'missing', days: null }, latest_attempt_status: attempt?.status ?? 'not_run', error: attempt?.error ?? null });
  }
  const blockers = [
    ...(!snapshot.snapshot_date ? ['持仓快照日期未确认'] : []),
    ...(snapshot.holdings.some(h => h.amount_cny > 0 && (h.units === null || h.units === undefined)) ? ['部分或全部持仓份额未填写'] : []),
    ...(!snapshot.strategy_cash ? ['策略实际可用现金未填写'] : []),
    ...(snapshot.pending_buy_total_cny === null || snapshot.pending_buy_total_cny === undefined || snapshot.pending_redemption_total_cny === null || snapshot.pending_redemption_total_cny === undefined ? ['待确认申购及待到账赎回金额尚未完整核对'] : []),
    '交易流水、买入批次及实际费用未导入',
    '应急金与其他资产是否重叠未确认（仅影响全资产分析）',
    '全资产本金未提供（仅影响全资产分析）',
    '官方净值交叉核对未完成',
    '产品披露及底层风险覆盖以当日日报和product-profiles为准，采集成功不代表研究已完成',
    '总收益指标仅在分红／拆分可识别时计算；接口缺少历史公开时间，不据此声称无前视偏差的择时回测'
  ];
  const sourceStatus = sources.map(s => ({ id: s.id, status: s.id === 'account_records' && snapshot.snapshot_date ? 'snapshot_imported_transactions_pending' : s.status }));
  const report = { generated_at: new Date().toISOString(), holdings: check, snapshot_date: snapshot.snapshot_date, available_strategy_cash_cny: snapshot.strategy_cash?.amount_cny ?? null, fund_plus_available_cash_cny: snapshot.fund_plus_available_cash_cny ?? null, nav_available: coverage.filter(c => c.rows).length, nav_recent: coverage.filter(c => c.quality.state === 'recent').length, coverage, documents: docs, market: marketCoverage, source_status: sourceStatus, blockers };
  await writeJson('data/status/overview.json', report);
  const lines = ['# 数据渠道状态', '', `生成时间：${report.generated_at}`, '', `持仓：${check.count}笔 / ${check.codes}个份额代码 / ${check.total_cny.toFixed(2)}元。`, `持仓快照日期：${snapshot.snapshot_date ?? '未知'}。`, `策略实际可用现金：${report.available_strategy_cash_cny === null ? '待填写' : report.available_strategy_cash_cny.toFixed(2) + '元'}。`, `历史净值：${report.nav_available}/${check.codes}已采集；${report.nav_recent}个在7个自然日提醒阈值内。节假日和QDII时差需人工解释。`, '', '|代码|净值截止日|行数|状态|最近采集|', '|---|---|---:|---|---|', ...coverage.map(c => `|${c.code}|${c.data_date ?? '缺失'}|${c.rows}|${c.quality.state}|${c.latest_attempt_status}${c.error ? `：${c.error.replaceAll('|', '/')}` : ''}|`), '', '## 报告归档', '', ...docs.map(d => `- ${d.id}：${d.status}；最新性未验证。`), '', '## 尚未接入或尚未完整接入的渠道', '', ...sourceStatus.filter(s => /pending|not_connected|awaiting/.test(s.status)).map(s => `- ${s.id}：${s.status}`), '', '## 分析前待补齐', '', ...report.blockers.map(b => `- ${b}`), '', '行情采集不改变用户持仓；持仓CSV导入才更新账户快照。成功采集不表示通过官方复核；失败时保留上一次数据并明确报告最近失败。', ''];
  await fs.mkdir(resolve('data/status'), { recursive: true });
  await fs.writeFile(resolve('data/status/overview.md'), lines.join('\n'));
  await fs.appendFile(resolve('data/status/overview.md'), ['\n## 官方市场序列\n', '|序列|数据截止日|行数|状态|最近采集|', '|---|---|---:|---|---|', ...marketCoverage.map(s => `|${s.id}|${s.data_date ?? '缺失'}|${s.rows}|${s.quality.state}|${s.latest_attempt_status}${s.error ? `：${s.error.replaceAll('|', '/')}` : ''}|`), '', '序列为采集时的最新修订历史，不含逐条公开时间，不能直接用于无前视偏差的历史回测。', ''].join('\n'));
  console.log(`状态：净值${report.nav_available}/${check.codes}，报告${docs.filter(d => d.status.startsWith('downloaded')).length}/${docs.length}`);
}
async function main() {
 const [command = 'status', ...options] = process.argv.slice(2);
  if (command === 'init') { await init(); await status(); }
  else if (command === 'collect') { if ((await collect(options)).failures.length) process.exitCode = 1; }
  else if (command === 'reports') await reports();
  else if (command === 'market') { if ((await market()).failures) process.exitCode = 1; }
  else if (command === 'verify') await verify();
  else if (command === 'status') await status();
  else throw new Error('Usage: node scripts/data.mjs init|collect [--codes=六位基金代码]|reports|market|verify|status');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e.message); process.exitCode = 1; });
