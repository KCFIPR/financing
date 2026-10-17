import { parseFundIdentity } from './lib.mjs';

const fail = (message, status) => Object.assign(new Error(message), {status});

export function createFundLookup({fetchImpl = fetch, now = Date.now} = {}) {
  const cache = new Map(), pending = new Map();
  return async code => {
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw fail('基金代码须为六位数字',400);
    const cached = cache.get(code);
    if (cached && now() - cached.time < 86400_000) return cached.value;
    if (pending.has(code)) return pending.get(code);
    const task = (async () => {
      const sourceUrl = `https://fund.eastmoney.com/pingzhongdata/${code}.js`;
      let response, raw;
      try {
        response = await fetchImpl(sourceUrl,{signal:AbortSignal.timeout(10000),headers:{'Accept':'*/*','User-Agent':'PortfolioDataWorkbench/0.1'}});
        if (response.ok) raw = await response.text();
      } catch(error) {
        throw fail(error.name === 'TimeoutError' ? '基金名称查询超时，请重试或手动填写' : '暂时无法查询基金名称，请重试或手动填写',502);
      }
      if (!response.ok) throw fail(response.status === 404 ? '未查到对应基金，请核对代码或手动填写名称' : '基金查询服务暂不可用，请重试或手动填写',response.status === 404 ? 404 : 502);
      let identity;
      try { identity = parseFundIdentity(raw,code); }
      catch { throw fail('未获得匹配的基金名称，请核对代码或手动填写',502); }
      const value = {...identity,source:'天天基金（东方财富）',source_url:sourceUrl};
      if (cache.size >= 256) cache.delete(cache.keys().next().value);
      cache.set(code,{time:now(),value});
      return value;
    })();
    pending.set(code,task);
    try { return await task; } finally { pending.delete(code); }
  };
}
