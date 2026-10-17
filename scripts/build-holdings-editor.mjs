import fs from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const core = (await fs.readFile(new URL('scripts/editor-core.mjs', root), 'utf8')).split('export function createEditorDocument')[0].replaceAll('export function', 'function');
const template = await fs.readFile(new URL('scripts/holdings-editor.template.html', root), 'utf8');
const output = template.replace('/* CORE */', () => core);
await fs.writeFile(new URL('持仓填写.html', root), output);
console.log('已生成填写页面；数据在打开时从每日持仓.json读取，HTML不嵌入持仓。');
