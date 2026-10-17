import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initializeWorkspace } from '../scripts/init.mjs';
import { createEditorStore } from '../scripts/editor-store.mjs';
import { loadBundle } from '../scripts/daily.mjs';

test('fresh setup has no holdings; setup is repeatable and never overwrites private input or configs', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'financing-init-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.cp(new URL('../config/examples', import.meta.url), path.join(root, 'config/examples'), { recursive: true });
  assert.equal((await initializeWorkspace(root)).length, 6);
  const store = createEditorStore(root);
  let loaded = await store.load();
  assert.equal(loaded.document.holdings.length, 0);
  assert.equal(loaded.document.cash.amount_cny, null);
  loaded.document.snapshot_date = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
  loaded.document.cash.amount_cny = 500;
  await store.save(loaded.document, loaded.revision, 'commit');
  const privateFiles = ['每日持仓.json', 'data/holdings/current.json', 'data/account/ledger.json', 'config/investment-mandate.json'];
  const before = await Promise.all(privateFiles.map(file => fs.readFile(path.join(root, file), 'utf8')));
  assert.deepEqual(await initializeWorkspace(root), []);
  assert.deepEqual(await Promise.all(privateFiles.map(file => fs.readFile(path.join(root, file), 'utf8'))), before);
  await assert.rejects(loadBundle(root, { asOf: loaded.document.snapshot_date, cutoff: new Date().toISOString(), offline: true }), /请先配置投资目标/);
});
