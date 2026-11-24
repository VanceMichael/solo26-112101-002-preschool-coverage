# 跨点流动学前服务的匿名回执与覆盖复核

县里有 `hill`、`river`、`grove` 三个演练点，分属两个乡镇（T1：hill、grove；T2：river）。
本工程在既有**来源服务**之上，实现县级采集、匿名身份解析、覆盖统计、乡镇复核与月份签收的完整流水线。
全程只处理加密编号（站点内短号），不接触儿童姓名。

## 业务规则落点

### 采集与封账（`src/lib/collector.mjs`、`src/lib/day-facts.mjs`）

- 一次回传分批上送 `present`/`absent`/`closed`，以当天**封账清单**列明的批号与记录数为准。
- 没有封账（来源 425）或缺批（503 离线、404 等）时，只登记结构化**缺口**，绝不猜缺席或零人。
- 封账 404 表示该站点日尚未发布，不制造伪缺口，也不进覆盖。
- 停课批（唯一一条 `closed`、无儿童编号）整日标记 `closed`，**不计应到**。
- 封账代次 `generation` 升高即更正：新旧两套原批件都按代次保留；当前代次缺批时整日为
  `correction-pending`，更正未齐不进正式覆盖。
- 已按当前代次取到的批件不重复拉取；离线点重上线后凭站点游标从缺口接续（`backfill`），
  历史补包同样遵守乡镇授权范围。

### 匿名身份与跨点声明（`src/lib/identity.mjs`）

- 短号作用域是「站点 + 发号期 `issueTerm`」：river 批里出现 `H5` 只是短号重用，**不能据此合并**。
- 跨点是否同一人只依据两类证据：
  1. 当月授权服务发布、适用日期覆盖当日、当前仍活跃且未冲突的链接声明；
  2. `county-inbox.json` 中有权人员明确认定同日跨点事实的县级复核记录。
- 同一 `linkId` 的较新公告取代旧状态；撤回后跨点证据立即失效，只有同站点同发号期的单点证据继续可用。
- 一个月的链接不能解释另一个月的短号（发号期隔离）。
- 两个活跃声明把同一短号连到同点同期的不同短号时，双双进入**冲突待核**，相关园点不发布正式覆盖。

### 覆盖统计（`src/lib/coverage.mjs`）

- 只统计已封账服务日与匿名儿童；停课日不计应到，未封账/缺批/更正未齐只进缺口清单。
- 同日多点已到且证据可确定同一人时，县级口径**只计一次**，组件标记 `attributionPending`（归属待核）。
- 存在声明冲突时，受影响园点人数不作为正式覆盖发布（`blocked`），其它园点仍按完整资料出数。
- 输出区分县级临时口径（`presentChildDays`）与可发布口径（`publishablePresentChildDays`）。
- 乡镇视图（`townView`）只含本镇站点回执与匿名汇总，跨点链接证明与对侧儿童号不出县。

### 复核与签收（`src/lib/review.mjs`、`src/lib/signoff.mjs`）

- 复核案件按 `case` + `version` 区分；同一对站点同一天的跨点事实只有一个案件，
  链接、县级认定、撤回等证据合并在案件原因中。
- 每个版本按站点拆下发项：站点只看到本站短号与回执批号，看不到对侧儿童号；
  一个站点不能替另一个站点接受，跨镇操作直接拒绝。
- 站点状态流转 `queued → received → claimed`，已认领不能回退。
- 链接撤回后，只对当日仍有原件回执、确实受影响的短号发新版本重查；
  旧版本答复不能替新版本结案（来源答复导入时判为 `superseded-version`）。
- 县级可先保留一人覆盖签收；有争议、未认领的站点不能各自签收（`REVIEW_OPEN` 阻断）。
- 已签收月份冻结当时统计口径（不可变快照与口径指纹）；晚到的封账、撤回或核实只形成后续可签收的修订，
  `revisions` 可查到受影响的站点与日期，旧快照保持不变。

### 审计与重建（`src/lib/store.mjs`）

- 所有状态变化追加到只增事件日志 `events.jsonl`，再折叠为内存投影；可随时写 `snapshot.json`。
- 重放日志可完整重建状态；原始批件按代次全部保留，任何回执都不会在采集时被悄悄覆盖或丢弃。

## 目录

```
src/
  cli.mjs                    命令行入口（JSON 输出，便于交接）
  lib/
    util.mjs                 日期、短号键、指纹等工具
    reference-data.mjs       乡镇管辖范围与县级权威认定
    source-client.mjs        来源 HTTP 客户端（425/503/404 结构化处理）
    store.mjs                只增事件日志与投影折叠
    collector.mjs            封账/批件/链接采集与缺口管理
    day-facts.mjs            站点日完整性、更正待核、停课、单点事实
    identity.mjs             声明有效性、冲突检测、并查集身份图
    coverage.mjs             县级与乡镇覆盖报告
    review.mjs               复核案件版本、乡镇队列、答复导入
    signoff.mjs              签收快照与修订影响
    app.mjs                  CountyApp 门面，组合全部用例
scripts/demo.mjs             四阶段端到端演练
test/                        node:test 测试（29 个用例）
sources/                     既有演练来源服务
data/                        合成报文、探针、县级收件箱
```

## 本地运行

需要 Node.js 22，依赖锁仅含标准库清单，无需安装第三方包。

```bash
npm ci
npm test          # 29 个测试：来源契约 + 采集/身份/覆盖/复核/签收/存储
npm run sources   # 终端 A：启动来源，默认 127.0.0.1:4180
npm run demo      # 终端 B：四阶段端到端演练（自建临时工作目录，自动清理）
```

## CLI 用法

默认工作目录 `.work/county`，可用 `--workdir` 覆盖；来源地址用 `--source` 或 `SOURCE_URL`。

```bash
# 采集一轮（自动拉封账、批件、当月链接，重算复核案件）
node src/cli.mjs collect
node src/cli.mjs collect --site hill --day 2026-10-17

# 离线点上线后的历史补包（遵守当前授权范围）
node src/cli.mjs backfill hill 2026-10-17

# 有事实依据的补采缺口交接清单
node src/cli.mjs gaps

# 覆盖结果：全县 / 指定期间 / 单乡镇视图
node src/cli.mjs coverage
node src/cli.mjs coverage 2026-10
node src/cli.mjs coverage 2026-10 --town T2

# 复核：县级台（含跨点证明，不出县）、乡镇队列、导入答复、逐项认领
node src/cli.mjs review board
node src/cli.mjs review queue T2
node src/cli.mjs review pull T2
node src/cli.mjs review status T2 R-HR-17/v1/river claimed --note "回执核对无误"

# 签收与修订
node src/cli.mjs signoff COUNTY 2026-10
node src/cli.mjs signoff T2 2026-10
node src/cli.mjs revisions T2 2026-10
node src/cli.mjs signoffs

# 审计
node src/cli.mjs events
node src/cli.mjs snapshot
```

## 来源契约（既有）

- 点位目录 `/centers`；封账 `/centers/<site>/<day>/seal`；批件 `/centers/<site>/part/<part>`。
- 封账清单列代次与每批记录数；更正代次更高，同日可保留两套原批件；暂缺封账返回 425。
- 县级链接 `/links/<term>` 按月发布，同一链接 ID 的较新公告取代此前状态。
- 乡镇收件台 `/town/T1/replies`、`/town/T2/replies` 只返回本镇答复；
  复核单按 `case`、`version` 区分，`received` 表收件、`claimed` 表认领。
- 来源阶段 `initial`、`late`、`conflict`、`withdrawal` 用 `POST /scenario/<阶段>` 切换。
