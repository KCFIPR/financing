import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEditorDocument } from './editor-core.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Exclusive creation: rerunning setup must never replace an account or its history.
export async function initializeWorkspace(root = defaultRoot) {
  const created = [];
  async function writeMissing(relative, value) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    try {
      await fs.writeFile(target, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
      created.push(relative);
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  for (const name of ['investment-mandate', 'product-profiles', 'documents']) {
    const example = JSON.parse(await fs.readFile(path.join(root, `config/examples/${name}.json`), 'utf8'));
    await writeMissing(`config/${name}.json`, example);
  }
  await writeMissing('data/holdings/current.json', {
    schema_version: 5, snapshot_date: null, currency: 'CNY', holdings: [], excluded_holdings: [],
    strategy_cash: { amount_cny: null, pending_buy_cny: null, pending_redemption_receivable_cny: null },
    fund_total_cny: 0, fund_plus_available_cash_cny: null
  });
  const current = JSON.parse((await fs.readFile(path.join(root, 'data/holdings/current.json'), 'utf8')).replace(/^\uFEFF/, ''));
  await writeMissing('每日持仓.json', createEditorDocument(current));
  await writeMissing('data/account/ledger.json', {
    schema_version: 1, baseline: null, valuations: [], events: [],
    external_flows_complete_since: null, pending_reconciled: false,
    execution_history_complete: false, dca: { status: 'unknown', plans: [] }
  });
  return created;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  initializeWorkspace().then(files => console.log(`初始化完成，新建${files.length}个本地文件；已有数据未覆盖。首次分析前请配置并确认投资目标。`))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
