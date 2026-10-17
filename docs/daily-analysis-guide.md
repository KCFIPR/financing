# 每日分析与复用

先在持仓页面更新并“保存并校验”，再在项目根目录运行：

```powershell
npm run daily -- --as-of=2026-10-16
```

不指定日期时使用香港当天日期。报告在 `docs/reports/日期-daily.md`，结构化结果在相邻JSON；每次输入和证据冻结归档在日期子目录。输出建议不会操作账户，也不会自动修改定投。

仅使用本地数据：`npm run daily -- --as-of=2026-10-16 --offline`。固定时点加 `--cutoff=2026-10-16T17:30:00+08:00`，此后才取得且没有可靠公开时间的数据不能回填。

精确重放：读取 `docs/reports/日期-latest.json` 的inputs路径，再运行 `npm run daily -- --replay=该路径`。重放要求脚本版本哈希一致，不刷新数据、不覆盖最新日报。代码更改后应新建报告而非宣称原结果完全重现。

## 数据与研究分工

命令自动采集基金净值（货币基金单列万份收益）、FRED利率、汇率、标普500、纳指100和VIX；失败保留缓存并在日报说明。净值所属日不是发布日期。QDII可能比境内净值多滞后一个交易日。

请求Codex使用本仓库Skill时，会另核查当日收盘、上金所、中债、宏观及基金公告，并写入当天研究文件。单独运行命令不会自动生成新的新闻事实；缺少当日研究证据会明确提示。

最新基金持仓穿透来自官方报告，记录报告期和公开时间。指数基金的100%方向敞口是风险代理，并非声称全部资产投资股票。源数据只有少数季度快照时不能据此还原过去每一天的组合持仓。

首次使用没有历史研究文件，可按下列格式新建 `data/research/YYYY-MM-DD.json`，用实际日期、公开时间和来源替换占位。只采集到网页的时刻不能冒充原始公开时间；无法确认公开时间时填实际首次取得时间并说明。

```json
{
  "as_of": "YYYY-MM-DD",
  "market_events": [
    {"date": "YYYY-MM-DD", "published_at": "ISO时间（含时区）", "title": "事件标题", "fact": "核实事实", "interpretation": "解释及失效条件", "source_url": "官方原始来源URL"}
  ],
  "limitations": []
}
```

`config/product-profiles.json` 的 `profiles` 以六位基金代码为键。每个产品至少研究 `bucket`（cash、pure_bond、defensive_mixed、china_broad、us_broad、nasdaq、theme或gold）、`exposure_group`（共同底层风险）、`stock_fraction`、`bond_fraction`、`convertible_fraction`、`lookthrough_basis_date`、`lookthrough_published_at`、`source_url`；未知比例使用null。申购与赎回分别记录 `subscription`、`redemption` 下的状态、费用、额度、核查时间和来源；未经核实不填“正常”或“免费”。字段及约束示例可参考完全合成的 `tests/daily.test.mjs` 与 `tests/portfolio-strategy.test.mjs`。

## 账户账本

`data/account/ledger.json` 是实际出入金、成交、定投与已确认绩效估值的账本。每天输入仍以持仓页面为主，只有发生资金或交易变化时才补充事件。脚本自动保存每日平台总额到 `data/account/valuations/`，默认 `provisional`；这不等于已对账或已产生可计算的真实收益。

事件的必填含义：

|字段|含义|
|---|---|
|id|唯一记录号；同一交易不重复登记|
|type|external_deposit、external_withdrawal、buy、sell、dividend或fee|
|date|实际日期YYYY-MM-DD；基准前已知发生区间可保留null并记录occurred_between|
|amount_cny|正数人民币金额；方向由type确定|
|status|confirmed、completed、settled、executed、reconciled表示实际发生；pending、submitted、cancelled等不算成交|
|code／holding_id|买卖对应基金／独立持仓|
|fees_cny|实际手续费；净值已有管理费不再另扣|
|cash_basis|在途买入填included_in_snapshot_cash或already_deducted，避免重复预留|
|settlement_date|确认到账日；卖出申请不等于现金到账|

外部新增本金按实际到账日期登记，未知日期保留未知，不人为指定到账日。现金包含在本组合，买基金及赎回是内部转移，不是外部现金流。

首次对账后，把 `baseline` 的金额与日期锁定，设置 `reconciled:true`，并将 `external_flows_complete_since` 设为开始完整记录现金流的日期。补入 `valuations` 的确认估值必须有 `date,total_cny,reconciled:true`。如逐次外部现金流前有精确估值，可加 `at,flow_after_cny,flow_event_ids` 供TWR使用；没有流前估值时采用Modified Dietz近似，不能伪称精确TWR。详细边界示例见指标模块测试。

不要只把reconciled改成true来消除警告。先核对持仓金额、现金、未确认买入、赎回到账及期间所有外部入出金。历史缺失时从核实完成日开始，不追造旧流水。用户填报的持有盈亏继续保留，不能作为这一步的替代。

`dca.plans` 可填写 `{id,code,amount_cny,frequency,next_execution_date,status:"active"}`，核实清单后将dca.status改为complete；初始化为unknown；未核实前不假设计划均已停止。`execution_history_complete:true` 或明确的 `trades_complete_since` 表示交易记录完整。`pending_reconciled:true` 仅在所有在途订单与现金口径已核对时设置。

申赎截止时间由产品／平台资料记录在 `dealing:{cutoff_time:"15:00",timezone:"Asia/Hong_Kong",verified_at,source_url}`，可放在基金profile或具体subscription/redemption项下。没有核实受理时间、已过当日截止或QDII专用开放日未知时，报告只保留条件性方案；下一开放日重新检查。

## 运行与策略维护

每位用户分别在本地配置期限、收益目标、回撤预算、配置比例和情景假设；模板中的零值只是待填写占位，不构成投资建议。首次分析前完成核对并设置configured:true。中性假设不一定达到目标，压力情景也可能突破预算；报告必须如实展示。常规调整受配置中的周度额度与成交冷却限制。实际执行后记录成交，再生成下一份报告。

中证A500与美股标普500、纳指100分开；纳指不同份额不带来新的市场分散。需要新增产品完成分散目标时，先由研究流程核查候选基金，并遵守单只产品上限。

完整自检：`npm test`；原始归档校验：`npm run verify`。行情更新不成功不等于账户保存失败。未创建后台定时任务。
