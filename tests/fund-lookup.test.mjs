import test from 'node:test';
import assert from 'node:assert/strict';
import { createFundLookup } from '../scripts/fund-lookup.mjs';

test('fund lookup matches codes, keeps A/C names, caches and refreshes names', async () => {
  let calls=0,time=0;
  const lookup=createFundLookup({now:()=>time,fetchImpl:async url=>{
    calls++;
    assert.equal(url,'https://fund.eastmoney.com/pingzhongdata/000032.js');
    return new Response('var fS_code="000032"; var fS_name="易方达信用债债券A";');
  }});
  const [first,second]=await Promise.all([lookup('000032'),lookup('000032')]);
  assert.equal(first.name,'易方达信用债债券A');
  assert.deepEqual(first,second);
  assert.equal(calls,1);
  await lookup('000032');assert.equal(calls,1);
  time=86400_001;await lookup('000032');assert.equal(calls,2);
  await assert.rejects(()=>lookup('../000032'),error=>error.status===400);
  assert.equal(calls,2);
});

test('lookup rejects missing, mismatched, malformed and unavailable data without executing scripts', async () => {
  for (const response of [
    new Response('var fS_code="000033"; var fS_name="另一基金C";'),
    new Response('<html>not found</html>'),
    new Response('var fS_code="000032"; var fS_name=process.exit(1);'),
    new Response('var fS_code="000032"; var fS_name="";'),
    new Response('',{status:500})
  ]) {
    const lookup=createFundLookup({fetchImpl:async()=>response});
    await assert.rejects(()=>lookup('000032'),error=>error.status===502);
  }
  await assert.rejects(()=>createFundLookup({fetchImpl:async()=>new Response('',{status:404})})('000032'),error=>error.status===404);
  let calls=0;
  const retry=createFundLookup({fetchImpl:async()=>{calls++;throw new Error('offline');}});
  await assert.rejects(()=>retry('000032'),/手动填写/);
  await assert.rejects(()=>retry('000032'),/手动填写/);
  assert.equal(calls,2);
});
