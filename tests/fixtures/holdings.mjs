import { parseHoldings } from '../../scripts/lib.mjs';

// Entirely synthetic identities and amounts; never read a developer's account.
export const markdown = Array.from({ length: 25 }, (_, i) => {
  const code = String(100 + (i < 21 ? i : [20, 20, 19, 18][i - 21])).padStart(6, '0');
  return `| B${String(i + 1).padStart(2, '0')} | ${code}${i === 0 ? '（按名称补）' : ''} | 测试基金${i + 1} | A | 债券 | 1000 | 0 | - | - | 测试平台${i % 3} |`;
}).join('\n');
export const previous = { snapshot_date: null, holdings: parseHoldings(markdown) };
export const mandate = { allowed_fund_codes: [...new Set(previous.holdings.map(h => h.code))], new_fund_codes_allowed: true };
