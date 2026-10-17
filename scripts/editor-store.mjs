import fs from 'node:fs/promises';
import path from 'node:path';
import { createEditorDocument, validateEditorDocument, parseEditorJson, editorApiVersion } from './editor-core.mjs';
import { atomicJson, persistSnapshot } from './snapshot.mjs';
import { sha256 } from './lib.mjs';

export const inputFile = '每日持仓.json';
export function createEditorStore(root) {
  const read = async file => JSON.parse((await fs.readFile(path.join(root,file),'utf8')).replace(/^\uFEFF/,''));
  const context = async () => ({current:await read('data/holdings/current.json'),mandate:await read('config/investment-mandate.json')});
  let busy = false;
  return {
    async initialize() {
      try { await fs.access(path.join(root,inputFile)); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const {current} = await context();
        await fs.writeFile(path.join(root,inputFile),JSON.stringify(createEditorDocument(current),null,2)+'\n',{flag:'wx'});
      }
    },
    async load() {
      const raw = await fs.readFile(path.join(root,inputFile),'utf8');
      const {current,mandate} = await context();
      const document = JSON.parse(raw.replace(/^\uFEFF/,''));
      const registered = [...current.holdings,...(current.excluded_holdings || [])];
      const normalized = validateEditorDocument(document,registered,mandate.allowed_fund_codes,{draft:true});
      normalized.status = document.status === 'validated' ? 'validated' : 'draft';
      return {api_version:editorApiVersion(),document:normalized,revision:sha256(raw),registered:registered.map(({id,code,name,platform,category}) => ({id,code,name,platform,category})),allowed_codes:mandate.allowed_fund_codes,last_validated_date:current.snapshot_date};
    },
    async save(document,revision,mode) {
      if (!['draft','commit'].includes(mode)) throw new Error('无效保存方式');
      if (busy) {const error = new Error('另一个保存正在进行，请稍后重试');error.status = 409;throw error;}
      busy = true;
      try {
        const raw = await fs.readFile(path.join(root,inputFile),'utf8');
        if (typeof revision !== 'string' || revision !== sha256(raw)) {const error = new Error('JSON已被其他窗口或编辑器修改，请重新读取后再保存');error.status=409;throw error;}
        const {current,mandate} = await context();
        const next = validateEditorDocument(document,[...current.holdings,...(current.excluded_holdings || [])],mandate.allowed_fund_codes,{draft:mode === 'draft',earliestDate:mode === 'commit' ? current.snapshot_date : null});
        const serialized = JSON.stringify(next,null,2)+'\n';
        const snapshot = mode === 'commit' ? parseEditorJson(next,current,mandate) : null;
        // Keep the last editable JSON, including incomplete drafts, before replacement.
        const priorFile = `data/holdings/input-history/${sha256(raw)}.json`;
        await fs.mkdir(path.dirname(path.join(root,priorFile)),{recursive:true});
        await fs.writeFile(path.join(root,priorFile),raw);
        if (snapshot) await persistSnapshot(snapshot,serialized,inputFile,root);
        await atomicJson(inputFile,next,root);
        return {api_version:editorApiVersion(),document:next,revision:sha256(serialized),last_validated_date:snapshot?.snapshot_date ?? current.snapshot_date,mode,missing_execution_fields:snapshot?.missing_execution_fields ?? null};
      } finally {busy=false;}
    }
  };
}
