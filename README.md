# 跨点流动学前服务的匿名回执与覆盖复核

县里有 `hill`、`river`、`grove` 三个演练点。点位目录为 `/centers`。点位日期入口例如 `/centers/hill/2026-10-17/seal`，清单列封账代次和每批记录数。批件入口是 `/centers/点位/part/批号`。记录取值 `present`、`absent` 和 `closed`，停课用该批唯一一条 `closed` 表示。更正清单的代次高于原清单，同一日期可保留两套原批件；来源暂缺封账以 425 表示。一次停课批不含儿童编号。

县级链接按日期区间取 `/links/oct` 或 `/links/nov`，同一链接 ID 的较新公告取代此前状态。两个活跃声明若把同一匿名号连到同一点同一发号期不同短号，则均进入冲突待核。授权输入中的 `sites` 是乡镇可见点位。核对记录是有权人员明确认定同日跨点发生事实的来件。

## 本地来源

资料均为合成记录。Node.js 22 环境下执行 `npm ci`，再用 `npm run sources` 启动，默认监听 `127.0.0.1:4180`。可用环境变量 `PORT` 修改端口。在容器中运行时，服务和访问端处于同一网络命名空间。

`data/sources.json` 保存原始报文及站点页面。连续响应由来源按同一进程内的观察次数提供。阶段从 `initial` 启动，本地演练人员可用 `POST /scenario/阶段名` 切换，未覆盖的路由延用初始响应。切换不清空来源的请求记录。重开服务会复位。

执行 `npm test` 核对来源契约。依赖锁仅包含 Node.js 标准库运行所需的项目清单。容器方式可先执行 `docker build -t preschool-coverage-sources .`，再执行 `docker run --rm preschool-coverage-sources`。镜像准备完成后的验证不需要外网。

## 复核交接

乡镇收件台允许按分队只读取该镇回执，`/town/T1/replies` 和 `/town/T2/replies` 分别返回各自答复。复核单按 `case` 和 `version` 区分。 `received` 仅表明收件，`claimed` 表明站点认领；答复所引用的 `part` 属于答复的站点。演练先用 17 日和 18 日记录试行县级复核，后续可逐镇签收。
