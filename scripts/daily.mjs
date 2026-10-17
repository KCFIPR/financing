import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, sum } from './lib.mjs';
import { parseEditorJson } from './editor-core.mjs';
import { persistSnapshot } from './snapshot.mjs';
import { collect, market } from './data.mjs';
import { analyzeNav, correlations, calculatePerformance } from './portfolio-metrics.mjs';
import { analyzePortfolio, estimateRedemption } from './portfolio-strategy.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const labels = {cash:'现金／货币',pure_bond:'纯债',defensive_mixed:'固收增强／偏债混合',china_broad:'A股宽基',us_broad:'美股宽基',nasdaq:'纳斯达克100',theme:'行业主题',gold:'黄金'};
const plain = value => Object.entries(labels).reduce((text,[key,label])=>text.replaceAll(key,label),String(value??''));
const pct = value => Number.isFinite(value) ? `${(value*100).toFixed(2)}%` : '未知';
const money = value => Number.isFinite(value) ? value.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2}) : '未知';
const cell = value => String(value ?? '未知').replaceAll('|','／').replaceAll('\n',' ');
const hkDate = at => new Date(at).toLocaleDateString('en-CA',{timeZone:'Asia/Hong_Kong'});
const round = value => Math.round(value*100)/100;
const readJson = async file => JSON.parse((await fs.readFile(file,'utf8')).replace(/^\uFEFF/,''));
async function optional(file, fallback=null) {try{return await readJson(file);}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
function validDate(date) {return /^\d{4}-\d{2}-\d{2}$/.test(date) && new Date(date+'T00:00:00Z').toISOString().slice(0,10)===date;}
function eligible(record, cutoff) {
  const published=record.published_at || record.available_at || record.collected_at;
  return published && Number.isFinite(Date.parse(published)) && Date.parse(published)<=Date.parse(cutoff);
}
function workdayLag(date, asOf, holidays=[]) {
  if (!date) return null;
  let count=0;
  for(let d=new Date(date+'T00:00:00Z');d.toISOString().slice(0,10)<asOf;) {
    d.setUTCDate(d.getUTCDate()+1);
    if(d.getUTCDay()!==0 && d.getUTCDay()!==6 && !holidays.includes(d.toISOString().slice(0,10))) count++;
  }
  return count;
}

export function buildReport(bundle) {
  const {snapshot,mandate,ledger,as_of:asOf,cutoff}=bundle;
  const profiles=bundle.product_profiles.profiles || bundle.product_profiles;
  const metrics={};
  const dataIssues=[...(bundle.collection_issues || [])];
  for(const holding of snapshot.holdings) {
    const nav=bundle.navs[holding.code];
    if(!nav) {dataIssues.push(`${holding.code}没有历史行情，不能计算历史表现。`);continue;}
    if(nav.series_kind==='money_market_income') {
      const rows=eligible(nav,cutoff)?nav.series.filter(p=>p.date<=asOf):[];
      metrics[holding.code]={status:eligible(nav,cutoff)?'income_only':'unavailable',basis:'money_market_income',data_date:rows.at(-1)?.date,observations:rows.length,latest_income:rows.at(-1),series:[],returns:{},issues:['万份收益与七日年化不作为单位净值。']};
    } else metrics[holding.code]=analyzeNav(nav,{asOf,cutoff});
    const m=metrics[holding.code];
    const lag=workdayLag(m.data_date,asOf,bundle.calendar.holidays || []);
    const isQdii=['nasdaq','us_broad'].includes(profiles[holding.code]?.bucket);
    m.freshness={weekday_lag:lag,expected_lag:isQdii?2:1,calendar_basis:'mainland_calendar; QDII individual calendar still checked at execution'};
    if(lag===null || lag>(isQdii?2:1)) dataIssues.push(`${holding.code}历史行情滞后${lag??'未知'}个境内交易日，不用旧净值确认今日信号。`);
    if(m.status==='unavailable' || m.status==='unverified') dataIssues.push(`${holding.code}历史指标不可完整验证：${(m.issues || []).join('；')}`);
    if(nav.official_crosscheck!=='verified') dataIssues.push(`${holding.code}行情来源为公开接口，尚无完整官方逐日复核；总收益只作研究参考。`);
    if(nav.corporate_action_reconciliation?.length) dataIssues.push(`${holding.code}有${nav.corporate_action_reconciliation.length}次分红金额由同代码、同日、同净值的已校验原始归档补全；证据保留在输入文件，不推测缺失金额。`);
  }
  const performance=calculatePerformance(ledger,{asOf,cutoff});
  const total=sum([snapshot.strategy_cash.amount_cny,...snapshot.holdings.map(h=>h.amount_cny)]);
  const currentReconciled=['ok','approximate'].includes(performance.status)&&performance.end_date===asOf&&Number.isFinite(performance.end_total_cny)&&Math.abs(performance.end_total_cny-total)<.01;
  performance.current_risk_drawdown=currentReconciled?performance.current_drawdown:null;
  performance.current_snapshot_reconciled=currentReconciled;
  if(performance.end_date&&!currentReconciled)dataIssues.push('历史账户收益仅截止最后已核对估值；未与本次持仓对账，不能用旧区间末回撤放行当前风险加仓。');
  const strategy=analyzePortfolio({snapshot,mandate,profiles,ledger:{...ledger,performance:{...performance,drawdown:performance.current_risk_drawdown,current_drawdown:performance.current_risk_drawdown}},metrics,asOf,cutoff,calendar:bundle.calendar});
  for(const r of strategy.recommendations.filter(x=>x.direction==='sell'&&x.amount_cny>0&&x.fee_estimate_cny===null)){
    const h=snapshot.holdings.find(h=>h.id===r.holding_id),p=profiles[r.code]||{};
    const assumed=estimateRedemption(h,{...p,redemption:{...p.redemption,order:'fifo'}},r.amount_cny);
    r.cost_comparison={...r.cost_comparison,fifo_only_scenario_fee_cny:assumed.fee_estimate_cny,scenario_condition:'仅当平台确认先进先出、批次及费率全部正确才适用；不代替实际费用核实。'};
  }
  const allocation=Object.entries(mandate.allocation_targets).map(([bucket,target])=>{
    const amount=sum([bucket==='cash'?snapshot.strategy_cash.amount_cny:0,...snapshot.holdings.filter(h=>profiles[h.code]?.bucket===bucket).map(h=>h.amount_cny)]);
    return {bucket,amount_cny:amount,weight:amount/total,target,target_amount_cny:round(target*total),gap_cny:round(target*total-amount)};
  });
  const unknownValue=sum(snapshot.holdings.filter(h=>!profiles[h.code]?.bucket).map(h=>h.amount_cny));
  if(unknownValue>0)allocation.push({bucket:'unknown',amount_cny:unknownValue,weight:unknownValue/total,target:null,target_amount_cny:null,gap_cny:null});
  if(unknownValue>0)dataIssues.push(`未分类资产${money(unknownValue)}元；配置与压力测试覆盖不完整。`);
  const scenarios=(source)=>Object.entries(source).map(([name,rates])=>({name,assumptions:rates,current_return:unknownValue?null:allocation.reduce((s,a)=>s+a.weight*rates[a.bucket],0),target_return:allocation.filter(a=>a.target!==null).reduce((s,a)=>s+a.target*rates[a.bucket],0)}));
  const confirmedSells=(strategy.recommendations || []).filter(r=>r.direction==='sell' && r.status!=='deferred');
  const conditionalAllocation=allocation.map(a=>({...a}));
  for(const r of confirmedSells) {
    const bucket=profiles[r.code]?.bucket;
    const row=conditionalAllocation.find(a=>a.bucket===bucket);
    if(!row)continue;
    row.amount_cny-=r.amount_cny;
    conditionalAllocation.find(a=>a.bucket==='cash').amount_cny+=r.amount_cny-(r.fee_estimate_cny || 0);
  }
  const afterTotal=conditionalAllocation.reduce((s,a)=>s+a.amount_cny,0);
  for(const a of conditionalAllocation)a.weight=a.amount_cny/afterTotal;
  const research=bundle.research;
  const events=(research?.market_events || []).filter(e=>e.date<=asOf && eligible(e,cutoff));
  if(!research || research.as_of!==asOf)dataIssues.push('缺少当日人工核验的市场证据；脚本行情仍可更新，新闻研究不能沿用旧结论冒充今日判断。');
  if(research && events.length<(research.market_events || []).length)dataIssues.push('部分研究证据晚于报告截止时间或缺少公开时间，已排除。');
  const markets=Object.fromEntries(Object.entries(bundle.markets).map(([id,m])=>{
    const available=eligible(m,cutoff);
    const rows=available?m.series.filter(p=>p.date<=asOf && Number.isFinite(p.value)):[];
    const latest=rows.at(-1), previous=rows.at(-2);
    const lag=workdayLag(latest?.date,asOf,bundle.calendar.holidays || []);
    if(!available || lag===null || lag>3)dataIssues.push(`${id}最新可用数据为${latest?.date||'未知'}；不能用来确认当日市场变化。`);
    return [id,{name:m.name,unit:m.unit,source_url:m.reference_url || m.url,data_date:latest?.date??null,value:latest?.value??null,previous_value:previous?.value??null,change:latest&&previous?latest.value-previous.value:null,available,series_kind:m.series_kind || 'economic_series',limitations:m.limitations}];
  }));
  return {schema_version:1,as_of:asOf,cutoff,strategy_version:mandate.strategy_version,input_hash:bundle.input_hash,summary:{total_cny:total,cash_cny:snapshot.strategy_cash.amount_cny,holding_pnl_cny:snapshot.holdings.every(h=>Number.isFinite(h.holding_pnl_cny))?sum(snapshot.holdings.map(h=>h.holding_pnl_cny)):null,holding_pnl_complete:snapshot.holdings.every(h=>Number.isFinite(h.holding_pnl_cny)),holding_count:snapshot.holdings.length,account_reconciled:currentReconciled},allocation,conditional_after_sells:{description:'仅模拟本报告非延后卖出全部确认并到账后的配置；不假定成交，不包含买入。费用未知时总额为上限。',total_cny:round(afterTotal),allocation:conditionalAllocation},metrics,correlations:correlations(metrics),performance,strategy,scenarios:{returns:scenarios(mandate.return_scenarios),stress:scenarios(mandate.stress_scenarios)},market:markets,market_events:events,research_limitations:research?.limitations || [],data_issues:[...new Set(dataIssues)],snapshot,mandate,ledger,profiles,previous_report:bundle.previous_report || null};
}

export function renderReport(r) {
  const out=[];const line=(s='')=>out.push(s);
  const table=(headers,rows)=>{line('|'+headers.join('|')+'|');line('|'+headers.map(()=>'---').join('|')+'|');for(const row of rows)line('|'+row.map(cell).join('|')+'|');line();};
  const actionLabel={increase_conditionally:'有条件增加',pause:'暂停定投',confirm_plan:'核对定投计划',review_before_resume:'复核后再恢复',maintain_within_budget:'预算内保持',buy:'增加',sell:'减少',hold:'持有',reduce:'减少',increase:'增加',pause:'暂停',conditional:'核对后执行',ready:'满足已记录条件',deferred:'延后'};
  line(`# ${r.as_of} 持仓分析与调仓报告`);line();
  line(`分析截止：${r.cutoff}（香港时间 ${new Date(r.cutoff).toLocaleString('zh-CN',{timeZone:'Asia/Hong_Kong',hour12:false})}）。持仓查看日：${r.snapshot.snapshot_date}；各基金估值日分别列示。策略：${r.strategy_version}。`);line();
  line('## 今日结论');line();
  line(`组合账面总额 **${money(r.summary.total_cny)}元**，可用现金填报 **${money(r.summary.cash_cny)}元**，持有收益合计 **${money(r.summary.holding_pnl_cny)}元**。持有收益不是账户历史收益或回撤；外部入金按本金登记，不计作投资收益。`);line();
  const recs=r.strategy.recommendations || [];
  const sells=recs.filter(x=>x.direction==='sell'&&x.status!=='deferred');
  line(sells.length?`本次提出分期降低集中风险的**条件性方案**，首批卖出参考合计 **${money(sum(sells.map(x=>x.amount_cny)))}元**。先核对批次及交易条件；申购配置缺口无需今天一次补齐。`:'当前没有满足条件的卖出方案；保留持仓并先核对数据，新增风险投入按下表约束。');
  line(`配置中的投资期限至少${r.mandate.investment_horizon_years_min ?? '未知'}年，费用后年化目标${pct(r.mandate.target_annual_net_return)}，组合回撤预算${pct(r.mandate.risk_budget_drawdown_fraction)}。${r.performance.current_snapshot_reconciled?'本次账户估值已与绩效账本对账，回撤以现金流调整后的序列为准。':'目前账户尚未完整对账，不能据持有盈亏声称已控制住真实回撤。'}每天检查不等于每天交易。`);line();
  line('## 收盘与市场信号验证');line();
  if(!r.market_events.length)line('没有符合截止时间的当日研究证据。');
  for(const e of r.market_events){line(`- **${e.title}（${e.date}）**：${e.fact} ${e.interpretation || ''} [来源](${e.source_url})`);}
  line();
  table(['自动更新序列','数据日期','数值','较前值变化','来源'],Object.values(r.market).map(m=>[m.name,m.data_date,m.value===null?'未知':`${m.value} ${m.unit}`,m.change===null?'未知':m.change.toFixed(4),`[原始来源](${m.source_url})`]));
  line('指数收盘、境内基金净值、QDII净值的时点不同。当日已完成的收盘表现只验证相应市场，不可替代尚未公布的基金净值或推定自己的成交价格。');line();
  line('## 配置与风险集中');line();
  table(['资产方向','当前金额','当前比例','基准比例','目标差额（正数待增）'],r.allocation.map(a=>[labels[a.bucket]||'未分类',money(a.amount_cny),pct(a.weight),pct(a.target),money(a.gap_cny)]));
  line(`纯债单基金上限${pct(r.mandate.limits.pure_bond_fund)}，单行业主题上限${pct(r.mandate.limits.theme_direction)}。基准为研究和过渡方向；配置需满足集中度约束。尚未完成资料和渠道核验的新基金不直接下达买入建议。`);line();
  const overweight=r.allocation.filter(a=>a.bucket!=='cash'&&Number.isFinite(a.target)&&a.weight>a.target+(r.mandate.limits.drift ?? .03));
  if(overweight.length)line(`本次优先处理${overweight.map(a=>`${labels[a.bucket]}（${pct(a.weight)}，基准${pct(a.target)}）`).join('、')}。先处理超过单行业上限的仓位，再分期调整固收增强；不以亏损大小决定清仓，也不等待涨回成本才管理集中度。`);line();
  line('### 穿透与资料时点');line();
  table(['基金','风险分类','股票占比／风险代理','债券占比','可转债','资料时点／说明'],r.snapshot.holdings.map(h=>{const p=r.profiles[h.code]||{};const future=(p.lookthrough_basis_date&&p.lookthrough_basis_date>r.as_of)||(p.lookthrough_published_at&&Date.parse(p.lookthrough_published_at)>Date.parse(r.cutoff));return [h.code,labels[p.bucket]||'未知',pct(future?null:p.stock_fraction),pct(future?null:p.bond_fraction),pct(future?null:p.convertible_fraction),future?'披露晚于截止时间，已排除':`${p.lookthrough_basis_date||'分类风险代理'}；${(p.notes||[]).join('；')}`];}));
  const exposure=r.strategy.lookthrough;
  if(exposure){table(['穿透项目','已知金额','组合占比','未知覆盖基金金额'],Object.entries(exposure.components).map(([key,x])=>[({stock:'股票',bond:'债券',convertible:'可转债'})[key],money(x.known_amount_cny),pct(x.known_weight),money(x.unknown_fund_amount_cny)]));table(['共同风险方向','基金代码','合计金额','组合占比'],exposure.exposure_groups.map(x=>[x.exposure_group,x.codes.join('、'),money(x.amount_cny),pct(x.weight)]));}
  line('股票指数和黄金的分类代理仅用于风险归类，不冒充最新持仓比例。债券净资产占比可能超过100%，反映融资／杠杆；未知持仓和久期不会被当作零风险。');line();
  line('## 逐只持仓与定投');line();
  table(['代码／基金','金额／占比','持有收益／估算收益率','净值日期','本次方向','定投与依据'],r.snapshot.holdings.map(h=>{const s=(r.strategy.holdings||[]).find(x=>x.id===h.id || x.holding_id===h.id) || (r.strategy.holdings||[]).find(x=>x.code===h.code) || {};return [`${h.code} ${h.name}`,`${money(h.amount_cny)}／${pct(h.amount_cny/r.summary.total_cny)}`,`${money(h.holding_pnl_cny)}／${h.estimated_holding_return_pct==null?'未知':h.estimated_holding_return_pct.toFixed(2)+'%'}`,h.nav_date,actionLabel[s.direction]||s.direction||'观察',`${actionLabel[s.dca_action]||s.dca_action||'定投清单待补'}；${plain(s.reason||'')}`];}));
  line(['complete','confirmed','none','all_stopped'].includes(r.ledger.dca?.status)?`定投清单状态已确认，活动计划${(r.ledger.dca.plans||[]).filter(p=>p.status==='active').length}项；建议不会自动修改平台定投。`:'定投清单尚未核对完整，不能假设扣款均已停止。减持方向优先检查并暂停相应新增定投；建议不会自动修改平台定投。');line();
  line('## 历史走势');line();
  table(['代码','数据截止／样本','20日','60日','120日','252日','年化波动','样本最大回撤','趋势／口径'],r.snapshot.holdings.map(h=>{const m=r.metrics[h.code]||{};return [h.code,`${m.data_date||'未知'}／${m.observations||0}`,pct(m.returns?.['20']),pct(m.returns?.['60']),pct(m.returns?.['120']),pct(m.returns?.['252']),pct(m.volatility_annualized),pct(m.max_drawdown),`${({above_both:'高于20/60日均线',below_both:'低于20/60日均线',mixed:'趋势分化',insufficient_data:'样本不足'})[m.trend]||m.trend||'不适用'}／${({distribution_reinvested_total_return:'分红再投资总收益',unit_nav_no_reported_actions:'无已报告分红的净值',money_market_income:'货币基金收益'})[m.basis]||m.basis||'未知'} (${m.status||'missing'})`];}));
  line('历史数据来自公开净值和分红／拆分注释。识别并调整公司行动的序列可作总收益研究；无法确认的序列仅看价格，不用来宣称年化或历史胜率。基金运作费已包含在净值中，个人申赎费未包含。没有历史公开时间的数据不用于宣称无前视偏差的择时回测。');line();
  const priceOnly=Object.entries(r.metrics).filter(([,m])=>m.price_series?.length);
  if(priceOnly.length)table(['代码','日期','仅未复权单位净值','限制'],priceOnly.map(([code,m])=>[code,m.price_series.at(-1).date,m.price_series.at(-1).unit_nav,'分红／拆分未验证，不输出总收益或趋势结论']));
  const pairs=Array.isArray(r.correlations)?r.correlations:(r.correlations.pairs||[]);
  if(pairs.length){table(['基金组合','相关系数','共同收益观测数'],pairs.map(p=>[`${p.code_a} / ${p.code_b}`,Number.isFinite(p.correlation)?p.correlation.toFixed(3):'未知',p.samples]));}
  line('## 条件性调仓清单');line();
  if(!recs.length)line('今日无具体调仓清单。');
  const shared=recs.length?(recs[0].conditions||[]).filter(c=>recs.every(x=>(x.conditions||[]).includes(c))):[];
  if(shared.length){line('以下条件适用于整份清单：');line();for(const c of shared)line(`- ${c}`);line();}
  table(['优先级／代码','方向','参考金额','估计费用','状态','原因及执行条件'],recs.filter(x=>x.amount_cny>0).map(x=>[`${x.priority??'—'}／${x.code}`,actionLabel[x.direction]||x.direction,money(x.amount_cny),money(x.fee_estimate_cny),actionLabel[x.status]||x.status,plain(`${x.reason||''}；${(x.conditions||[]).filter(c=>!shared.includes(c)).join('；')}`)]));
  const waiting=recs.filter(x=>x.amount_cny===0);
  if(waiting.length){line('下列方向本批不下单；目标差额是过渡参考，不是下一次必须交易的金额：');line();table(['代码','方向','本批金额','过渡参考差额','原因'],waiting.map(x=>[x.code,actionLabel[x.direction]||x.direction,'0.00',money(x.desired_total_cny),r.profiles[x.code]?.subscription?.status==='suspended'?'暂停申购，等待恢复公告及渠道复核':'本批预算、集中度、额度或资金约束；下次按新持仓重新计算']));}
  line(`本批买入资金仅来自当前已填报现金，最多参考${money(r.strategy.transition.proposed_buy_cny)}元；实际可投入还需扣除未核对的在途订单、定投及申购费，未到账赎回款不计入。`);line();
  for(const x of sells){const hypothetical=x.cost_comparison?.fifo_only_scenario_fee_cny;if(Number.isFinite(hypothetical))line(`${x.code}费用尚未核实；若平台确认先进先出且所填批次全部正确，${money(x.amount_cny)}元赎回费情景约${money(hypothetical)}元。等待降费的日期和节省额未知，不能为等待一个未知优惠而忽略净值波动。`);}line();
  line(`单周买入、卖出分别最多${money(r.summary.total_cny*r.mandate.limits.weekly_one_way)}元，扣除已确认交易；已确认同方向成交后冷却${r.mandate.limits.cooldown_trading_days ?? 5}个交易日。高于${r.mandate.limits.max_routine_redemption_fee_pct ?? 0.5}%的常规赎回费优先等待。份额仅能用最新已知净值估算，场外基金申请时成交净值未知；到账前不安排使用赎回款。`);line();
  line('### 首批卖出全部到账后的模拟');line();
  line(r.conditional_after_sells.description);line();
  table(['方向','当前','模拟卖出到账后','长期基准'],r.conditional_after_sells.allocation.map(a=>[labels[a.bucket]||'未分类',pct(r.allocation.find(x=>x.bucket===a.bucket).weight),pct(a.weight),pct(a.target)]));
  line('## 收益目标与压力测试');line();
  table(['假设情景','当前配置结果','目标配置结果'],r.scenarios.returns.map(s=>[s.name,pct(s.current_return),pct(s.target_return)]));
  const mid=r.scenarios.returns.find(s=>s.name==='central');
  const target=r.mandate.target_annual_net_return;
  line(`中性假设下目标配置约${pct(mid?.target_return)}，${Number.isFinite(target)?(mid?.target_return>target?'高于':'尚未超过')+pct(target)+'目标':'尚未设置收益目标'}。情景结果不能证明可稳定达到目标；不为达到目标而提高风险预算。以上是敏感性假设，非未来收益预测。`);line();
  if(Number.isFinite(target)&&mid?.target_return<target)line(`相对${pct(target)}目标仍差${((target-mid.target_return)*100).toFixed(3)}个百分点，按当前资金约${money((target-mid.target_return)*r.summary.total_cny)}元／年。假设按基金净值口径已含管理等运作费用；个人申赎费用尚未完整核实，实际净结果还需扣除这些费用。`);line();
  table(['资产方向','保守年回报假设','中性年回报假设','积极年回报假设'],Object.keys(labels).map(b=>[labels[b],pct(r.mandate.return_scenarios.conservative[b]),pct(r.mandate.return_scenarios.central[b]),pct(r.mandate.return_scenarios.optimistic[b])]));
  table(['压力情景','当前组合损益','目标组合损益'],r.scenarios.stress.map(s=>[s.name,pct(s.current_return),pct(s.target_return)]));
  line('配置调整不能保证每一种压力情景都改善；从现金转入债券和股票也可能增加部分情景下的损失。目标配置只是起点，尚未配置的额度继续留在现金。');line();
  for(const scenario of r.scenarios.stress)line(`${scenario.name}假设：${Object.entries(scenario.assumptions).map(([bucket,rate])=>`${labels[bucket]||bucket}${pct(rate)}`).join('、')}。`);
  line('这些假设包含对应产品类别风险，不再叠加穿透股票重复扣损失。尾部情景可突破回撤预算，预警和场外赎回不能保证硬止损。');line();
  line('## 账户绩效与待核对事项');line();
  line(`绩效状态：${r.performance.status}；方法：${r.performance.method||'未知'}；区间截止：${r.performance.end_date||'未知'}；区间收益：${pct(r.performance.return_fraction)}；区间末回撤：${pct(r.performance.current_drawdown)}；当前已对账回撤：${pct(r.performance.current_risk_drawdown)}。`);
  for(const issue of r.performance.issues||[])line(`- ${typeof issue==='string'?issue:JSON.stringify(issue)}`);
  for(const issue of r.strategy.issues||[])line(`- ${typeof issue==='string'?issue:`${issue.code||''} ${issue.message||JSON.stringify(issue)}`}`);
  for(const issue of r.data_issues)line(`- ${issue}`);
  for(const issue of r.research_limitations)line(`- ${typeof issue==='string'?issue:JSON.stringify(issue)}`);
  line();line('## 与上份报告的变化及复核');line();
  line(r.previous_report?`上一份结构化报告日期：${r.previous_report.as_of}。旧建议不视为已执行，今天重新按实际持仓及成交账本计算。`:'本次为新策略首份结构化日报。历史建议仅供对照，不与本次金额叠加执行。');
  if(r.previous_report){const p=r.previous_report;line(`账面总额变动${money(r.summary.total_cny-p.summary.total_cny)}元，不直接视为投资收益；策略版本${p.strategy_version===r.strategy_version?'未变':`${p.strategy_version} → ${r.strategy_version}`}。`);table(['方向','上份比例','当前比例','变化（百分点）'],r.allocation.map(a=>{const old=(p.allocation||[]).find(x=>x.bucket===a.bucket);return [labels[a.bucket]||'未分类',pct(old?.weight),pct(a.weight),old?((a.weight-old.weight)*100).toFixed(2):'缺少可比数据'];}));const stale=(p.recommendations||[]).filter(old=>!recs.some(now=>now.code===old.code&&now.direction===old.direction&&now.amount_cny===old.amount_cny&&now.status===old.status));line(stale.length?`已失效或需要替换的旧建议：${stale.map(x=>`${x.code}${actionLabel[x.direction]||x.direction}${money(x.amount_cny)}元`).join('；')}。以本次条件及金额重新评估。`:'建议方向和金额未变化时仍需核对实际成交、费用和申赎状态。');}
  line('下次更新持仓后重新采集、核对，并检查未成交建议；若主题集中、底层持仓风险或回撤预警发生变化，提前复核。请补齐定投清单、在途资金以及异常批次，核对完成前只保留条件性交易方案。');line();
  line(`证据标识：${r.input_hash}。本次未执行任何基金交易。`);
  return out.join('\n')+'\n';
}

export async function loadBundle(root,{asOf,cutoff,offline=false}) {
  const read=relative=>readJson(path.join(root,relative));
  const editor=await read('每日持仓.json');
  if(editor.status!=='validated')throw new Error('请先在持仓页面保存并校验，草稿不用于正式日报。');
  if(editor.snapshot_date!==asOf)throw new Error(`持仓日期${editor.snapshot_date}与报告日期${asOf}不一致，请更新后再运行。`);
  const stored=await read('data/holdings/current.json');
  const mandate=await read('config/investment-mandate.json');
  if(mandate.configured===false)throw new Error('请先配置投资目标、风险预算、配置比例与情景假设，再将config/investment-mandate.json中的configured设为true。');
  const snapshot=parseEditorJson(editor,stored,mandate,asOf);
  snapshot.imported_at=stored.imported_at;
  snapshot.source_sha256=sha256(JSON.stringify(editor));
  const collectionIssues=[];
  if(!offline) {
    await persistSnapshot(snapshot,await fs.readFile(path.join(root,'每日持仓.json'),'utf8'),'每日持仓.json',root);
    const result=await collect();
    if(result.failures.length)collectionIssues.push(`净值采集失败：${result.failures.join(',')}，保留缓存。`);
    const mr=await market();if(mr.failures)collectionIssues.push(`${mr.failures}条FRED序列采集失败，保留缓存。`);
  }
  const navs={},markets={};
  for(const code of [...new Set(snapshot.holdings.map(h=>h.code))]){
    const n=await optional(path.join(root,`data/normalized/nav/${code}.json`));if(n)navs[code]=n;
    const s=await optional(path.join(root,`data/status/nav/${code}.json`));if(s?.status==='failed')collectionIssues.push(`${code}最近一次采集失败：${s.error}`);
  }
  for(const m of (await read('config/market-series.json')).series){const value=await optional(path.join(root,`data/normalized/market/${m.id}.json`));if(value)markets[m.id]=value;}
  const productProfiles=await read('config/product-profiles.json');
  const ledger=await read('data/account/ledger.json');
  const research=await optional(path.join(root,`data/research/${asOf}.json`));
  let calendar=await optional(path.join(root,'config/trading-calendar.json'),{complete:false,holidays:[]});
  if(asOf<calendar.start_date || asOf>calendar.end_date)calendar={...calendar,complete:false};
  const reportFiles=await fs.readdir(path.join(root,'docs/reports')).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
  const previousFile=reportFiles.filter(f=>/^\d{4}-\d{2}-\d{2}-daily\.json$/.test(f)&&f.slice(0,10)<asOf).sort().at(-1);
  const previous=previousFile?await read(`docs/reports/${previousFile}`):null;
  const previousReport=previous?{as_of:previous.as_of,input_hash:previous.input_hash,strategy_version:previous.strategy_version,recommendations:previous.strategy?.recommendations||[],summary:previous.summary,allocation:previous.allocation||[]}:null;
  const codeHashes={};
  for(const f of ['scripts/daily.mjs','scripts/portfolio-metrics.mjs','scripts/portfolio-strategy.mjs','scripts/lib.mjs','scripts/editor-core.mjs'])codeHashes[f]=sha256(await fs.readFile(path.join(root,f)));
  const bundle={schema_version:1,as_of:asOf,cutoff,snapshot,mandate,ledger,product_profiles:productProfiles,navs,markets,research,calendar,collection_issues:[...new Set(collectionIssues)],code_hashes:codeHashes,previous_report:previousReport};
  bundle.input_hash=sha256(JSON.stringify(bundle));return bundle;
}

export async function runDaily(options={},root=defaultRoot) {
  let bundle;
  if(options.replay) {
    const replayPath=path.resolve(root,options.replay);
    if(!replayPath.startsWith(root+path.sep))throw new Error('重放文件须位于本仓库。');
    bundle=await readJson(replayPath);
    const {input_hash,...input}=bundle;if(sha256(JSON.stringify(input))!==input_hash)throw new Error('重放输入哈希不匹配。');
    for(const [f,hash] of Object.entries(bundle.code_hashes || {}))if(sha256(await fs.readFile(path.join(root,f)))!==hash)throw new Error('计算脚本版本已变化；请使用原版本重放，或重新生成报告。');
  } else {
    const asOf=options.asOf || hkDate(new Date());
    if(!validDate(asOf))throw new Error('无效报告日期。');
    const cutoff=options.cutoff || (asOf===hkDate(new Date())?new Date().toISOString():`${asOf}T23:59:59.999+08:00`);
    if(!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(cutoff)||!Number.isFinite(Date.parse(cutoff))||hkDate(cutoff)!==asOf||Date.parse(cutoff)>Date.now()+60000)throw new Error('截止时间须有时区、属于报告日期且不能晚于现在。');
    if(!options.offline && asOf<hkDate(new Date()))throw new Error('历史报告须使用--offline或--replay，不能抓取未来数据回填历史。');
    bundle=await loadBundle(root,{asOf,cutoff,offline:options.offline});
    // A run without an explicit cutoff includes all data that actually arrived during collection.
    if(!options.cutoff && !options.offline){delete bundle.input_hash;bundle.cutoff=new Date().toISOString();bundle.input_hash=sha256(JSON.stringify(bundle));}
  }
  const report=buildReport(bundle);const markdown=renderReport(report);
  const relative=`docs/reports/${bundle.as_of}/${bundle.input_hash.slice(0,16)}`;
  await fs.mkdir(path.join(root,relative),{recursive:true});
  const json=JSON.stringify(report,null,2)+'\n';
  await fs.writeFile(path.join(root,relative,'inputs.json'),JSON.stringify(bundle,null,2)+'\n');
  await fs.writeFile(path.join(root,relative,'report.json'),json);
  await fs.writeFile(path.join(root,relative,'report.md'),markdown);
  if(!options.replay) {
  await fs.mkdir(path.join(root,'data/account/valuations'),{recursive:true});
  await fs.writeFile(path.join(root,`data/account/valuations/${bundle.as_of}-${bundle.input_hash.slice(0,16)}.json`),JSON.stringify({date:bundle.as_of,observed_at:bundle.cutoff,total_cny:report.summary.total_cny,reconciled:false,status:'provisional',input_hash:bundle.input_hash,notes:'Automatically archived platform snapshot; reconcile pending amounts and external flows before using for performance.'},null,2)+'\n');
  await fs.writeFile(path.join(root,`docs/reports/${bundle.as_of}-daily.md`),markdown);
  await fs.writeFile(path.join(root,`docs/reports/${bundle.as_of}-daily.json`),json);
  await fs.writeFile(path.join(root,`docs/reports/${bundle.as_of}-latest.json`),JSON.stringify({as_of:bundle.as_of,input_hash:bundle.input_hash,inputs:`${relative}/inputs.json`,report:`${relative}/report.md`},null,2)+'\n');
  }
  console.log(JSON.stringify({report:`docs/reports/${bundle.as_of}-daily.md`,archive:relative,total_cny:report.summary.total_cny,input_hash:bundle.input_hash,issues:report.data_issues.length}));
  return {bundle,report,markdown,relative};
}
async function main(){const options={};for(const arg of process.argv.slice(2)){if(arg==='--offline')options.offline=true;else if(arg.startsWith('--as-of='))options.asOf=arg.slice(8);else if(arg.startsWith('--cutoff='))options.cutoff=arg.slice(9);else if(arg.startsWith('--replay='))options.replay=arg.slice(9);else throw new Error(`未知参数${arg}`);}await runDaily(options);}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.stack);process.exitCode=1;});
