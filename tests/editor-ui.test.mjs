import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const html = await fs.readFile(new URL('../持仓填写.html',import.meta.url),'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function page(fetchImpl) {
  const elements=new Map(),timers=new Map();let timerId=0;
  const element=id=>{
    if (!elements.has(id)) elements.set(id,{value:'',textContent:'',listeners:{},addEventListener(type,handler){this.listeners[type]=handler;}});
    return elements.get(id);
  };
  const context=vm.createContext({
    document:{getElementById:element,querySelectorAll:()=>[]},
    window:{addEventListener(){}},location:{protocol:'file:'},
    AbortController,fetch:fetchImpl,
    setTimeout:callback=>{timers.set(++timerId,callback);return timerId;},clearTimeout:id=>timers.delete(id)
  });
  vm.runInContext(script,context);
  return {element,context,runTimer:()=>{const [id,callback]=timers.entries().next().value;timers.delete(id);return callback();},timers};
}

test('generated page contains current shared validation and renders two numeric day inputs', async () => {
  const core=(await fs.readFile(new URL('../scripts/editor-core.mjs',import.meta.url),'utf8')).split('export function createEditorDocument')[0].replaceAll('export function','function');
  assert.ok(html.includes(core),'Rebuild the editor HTML after editing the core');
  const {context}=page();
  const cells=vm.runInContext("batchInputs({name:'Fund A'},{units:1,holding_days_min:60,holding_days_max:null,redemption_fee_pct:0},0)",context);
  assert.match(cells,/data-prop="holding_days_min" type="number" min="0" step="1"[^>]*value="60"/);
  assert.match(cells,/data-prop="holding_days_max" type="number" min="0" step="1"[^>]*value=""/);
  assert.doesNotMatch(cells,/data-prop="holding_days"/);
  for (const prop of ['holding_pnl_cny','holding_return_pct']) {
    const input=vm.runInContext(`field({${prop}:-1.25},'${prop}','P/L')`,context);
    assert.match(input,/type="number" value="-1.25" step="any"/);
    assert.doesNotMatch(input,/min="0"/);
    assert.ok(html.includes(`field(h,'${prop}'`));
  }
  assert.match(vm.runInContext("field({amount_cny:0},'amount_cny','Amount')",context),/min="0"/);
  assert.ok(!html.includes("field(h,'reported_cumulative_pnl_cny'"));
});

test('old service is detected before PUT and unsaved holding P/L stays on the page', async () => {
  const calls=[];
  const ui=page(async (url,options)=>{calls.push(options.method);return {ok:true,json:async()=>({document:{holdings:[]},revision:'r'})};});
  vm.runInContext("doc={format:'financing-holdings-editor-v1',snapshot_date:'2026-10-08',cash:{amount_cny:0},holdings:[{id:'A',code:'000032',name:'Fund A',platform:'Test',amount_cny:900,holding_pnl_cny:-100,all_redeemable:true,batches:[]}]};revision='r';dirty=true;",ui.context);
  await vm.runInContext("save('draft')",ui.context);
  assert.deepEqual(calls,['GET']);
  assert.equal(vm.runInContext('doc.holdings[0].holding_pnl_cny',ui.context),-100);
  assert.equal(vm.runInContext('dirty',ui.context),true);
  assert.match(ui.element('message').textContent,/旧版本/);
});

test('automatic estimated rate is readonly and updates when amount or holding P/L changes', () => {
  const {context}=page();
  assert.match(vm.runInContext('estimatedReturnField({amount_cny:1100,holding_pnl_cny:100})',context),/readonly value="10.00%"/);
  assert.match(vm.runInContext('estimatedReturnField({amount_cny:100,holding_pnl_cny:100})',context),/readonly value=""/);
  const rate={value:''},batch={textContent:''};
  context.document.querySelectorAll=selector=>selector==='.fund'?[{dataset:{id:'A'},querySelector:selector=>selector==='[data-estimated-return]'?rate:batch}]:[];
  vm.runInContext("doc={holdings:[{id:'A',amount_cny:900,holding_pnl_cny:-100,batches:[]}]};totals();",context);
  assert.equal(rate.value,'-10.00%');
  vm.runInContext('doc.holdings[0].amount_cny=1900;totals();',context);
  assert.equal(rate.value,'-5.00%');
  vm.runInContext("doc.holdings[0].holding_pnl_cny='';totals();",context);
  assert.equal(rate.value,'');
});

test('code lookup fills names and preserves edits made while a request is pending', async () => {
  let complete;
  const ui=page(()=>new Promise(resolve=>{complete=resolve;}));
  ui.element('newCode').value='000032';ui.element('newCode').listeners.input();
  const first=ui.runTimer();
  complete({ok:true,json:async()=>({code:'000032',name:'Fund A',source:'Provider'})});
  await first;assert.equal(ui.element('newName').value,'Fund A');
  ui.element('retryFundLookup').onclick();const second=ui.runTimer();
  ui.element('newName').value='Manual A';
  complete({ok:true,json:async()=>({code:'000032',name:'Updated A',source:'Provider'})});
  await second;assert.equal(ui.element('newName').value,'Manual A');
});

test('changed or incomplete codes cannot receive an earlier query result, errors permit retry', async () => {
  const requests=[];
  const ui=page(()=>new Promise(resolve=>requests.push(resolve)));
  ui.element('newCode').value='000032';ui.element('newCode').listeners.input();const first=ui.runTimer();
  ui.element('newCode').value='000033';ui.element('newCode').listeners.input();const second=ui.runTimer();
  requests[1]({ok:true,json:async()=>({code:'000033',name:'Fund C',source:'Provider'})});await second;
  requests[0]({ok:true,json:async()=>({code:'000032',name:'Old A',source:'Provider'})});await first;
  assert.equal(ui.element('newName').value,'Fund C');
  ui.element('newCode').value='000';ui.element('newCode').listeners.input();
  assert.equal(ui.element('newName').value,'');assert.equal(ui.timers.size,0);
  ui.element('newCode').value='000032';ui.element('newCode').listeners.input();const failed=ui.runTimer();
  requests[2]({ok:false,json:async()=>({error:'offline'})});await failed;
  assert.match(ui.element('fundLookupStatus').textContent,/offline/);
  ui.element('retryFundLookup').onclick();const retried=ui.runTimer();
  requests[3]({ok:true,json:async()=>({code:'000032',name:'Recovered A',source:'Provider'})});await retried;
  assert.equal(ui.element('newName').value,'Recovered A');
});
