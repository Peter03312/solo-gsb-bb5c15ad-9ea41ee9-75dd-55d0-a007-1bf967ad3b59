# 小型铁路站场培训 —— Web 进路联锁推演台

一个用于教学/培训的铁路站场进路联锁推演系统：管理员绘制轨道区段、道岔、信号机并
定义起终点进路；值班员选择进路与道岔位置，系统依据联锁规则判定能否开放、给出阻断
原因，开放时原子锁定沿途资源，并按带序号的占用/清空事件模拟列车走行、逐段解锁。
当资源暂不具备时，值班员也可提交**等待申请**（不预锁资源），系统在条件具备时
按提交顺序自动兑现为进路实例。

对**已开放且尚无走行占用记录**的进路，值班员还可申请**延时取消**：申请立即令入口
信号回红、区段与道岔锁继续保留，等待申请不提前兑现；管理员设置的保护期满后，系统在
同一事务内重查"进路仍开放、无走行占用、沿途区段均空闲"才解除进路并触发等待兑现，
条件不符则终止取消、保留锁闭并说明原因。

管理员还可按区段发起**临时封锁**：申请提交后立即阻止该区段参与新的进路预检、直接
开放与等待兑现（等待申请保留顺位并显示封锁原因）；已开放进路的锁闭、走行与延时取消
规则不受影响。区段空闲且无进路锁时申请自动由"待生效"转为"已生效"，否则持续复核；
管理员可随时结束封锁，结束后按现有联锁规则重试等待兑现。

值班员交班时还可生成**交接班交接单**：对当时的区段占用、道岔位置、开放进路的信号
与走行进度、等待申请、延时取消申请及未结束封锁做同一时刻的原子快照，并记录生成时间
与交班人。接班值班员在页面查看并签收（姓名须与交班人不同）；生成后任一快照状态发生
变化，签收即被拒绝、列出变化类别并将该单标记过期，由交班人重新生成。交接单只读快照、
不阻塞任何既有操作；站场重置使未签收单过期，已签收单保留供复盘。

管理员还可从**原站场**创建**命名演练副本**：创建时在同一事务内复制站场定义、
区段与道岔状态、开放进路的锁和事件进度、未兑现等待申请、未完结延时取消及临时封锁，
返回副本编号与状态（同名拒绝）。每个登录会话可选择当前站场，未选择时仍使用原站场；
副本与原站场独立运行，编辑、预检、开放、走行、调整、等待/延时取消、封锁、交接单与
重置都只作用于当前站场，锁闭与等待顺位不串用，历史交接单留在原站场。复制的延时取消
沿用原到期时刻，服务重启后按各站场分别复核（不重新计时、不重复兑现）；未知副本与
越权操作一律拒绝。

## 功能概览

- **管理员页面**：在 SVG 站场图上绘制轨道区段、道岔、信号机，定义起终点进路
  （依次点选沿途区段和道岔位置），可一键清空推演状态恢复到初始空场。
- **值班员页面**：选择进路及道岔位置 → 系统预检可否开放（信号状态、阻断原因）→
  开放进路（原子锁定区段/道岔）→ 按区段提交带**递增序号**的占用/清空事件 →
  列车进入首段信号自动回红 → 已清空区段逐段解锁 → 末段清空后整条进路解除。
  也可对所选进路提交**等待申请**：
  - 申请只校验进路与道岔选择是否符合定义（未知进路、缺失/不符定义的道岔选择直接
    拒绝），**不预锁任何资源**，可查看申请编号、当前顺位、阻断原因与兑现后的进路实例。
  - 提交时，以及区段状态变化、道岔扳动、进路解除、服务重启后，系统自动尝试兑现；
    兑现时在**同一事务内重新执行现有开放校验与锁闭**——未知/占用区段、道岔实际
    位置不符、他路锁闭则继续等待并刷新阻断原因；重复触发**不会产生多个实例**。
  - 共享区段或道岔的等待申请严格按提交顺序排队，仍有效的前项未兑现时后项不得越过；
    资源互不相交的申请可以先兑现。
  - 本人可撤销自己尚未兑现的申请（非本人撤销拒绝）；申请人退出登录、管理员重置
    推演会撤销未兑现申请；进路定义被修改/删除会使相关申请失效并写明原因。
  - 等待状态与结果全部持久化在 SQLite，页面刷新、服务重启后仍可见。
- **延时取消（保护期后取消）**
  - 值班员可对**已开放且尚无走行占用记录**的进路申请延时取消，返回申请状态与最早
    解除时间；申请立即令**入口信号回红**，原区段锁与道岔锁继续保留；保护期内
    等待申请**不得提前兑现**。
  - 保护时长由管理员设置为**正整数秒**；申请落库即快照时长与最早解除时刻，之后
    修改设置**不追改**已有申请。
  - 到期后在**同一事务内重查**：实例仍开放、无走行占用记录、沿途区段均空闲，才
    解除进路并触发等待兑现；条件不符则**终止取消申请、保留锁闭并说明原因**。
  - 保护期内收到该实例的**首段占用事件**：按现有走行规则照常受理，并终止取消申请；
    **重复申请**返回原申请，不缩短期限、不产生第二笔申请。
  - 服务重启后继续处理未到期/已到期申请；管理员重置推演时申请与进路实例一并清除。
  - 现有人工解除、走行事件接口约定保持不变；值班台显示取消状态与实时剩余时间。
- **临时封锁（管理员按区段发起）**
  - 管理员按**区段编号 + 封锁原因**发起，返回申请编号、状态（待生效/已生效）与原因；
    未知区段、空白原因一律拒绝；同一区段已有未结束封锁时重复申请返回原申请，
    不产生第二笔。
  - 申请提交后**立即**阻止该区段参与新的进路预检、直接开放与等待兑现；等待申请
    保留顺位并显示封锁原因。**已开放进路保持原锁闭、走行与延时取消规则**，不因
    封锁申请强制解除。
  - 区段**空闲且无进路锁**时待生效申请自动转为已生效；占用、未知或仍锁闭时维持
    待生效。走行出清、独立区段状态变化、延时取消到期、进路解除及服务重启后持续
    复核，状态转换与开放校验读取同一份区段占用/锁闭状态。
  - 管理员可结束待生效或已生效封锁；结束后按现有联锁规则重试等待兑现，**不改写
    区段占用状态**。管理员与值班员页面均显示封锁状态；管理员重置推演时清除封锁
    记录。
- **交接班交接单**
  - 交班值班员一键生成：在**同一时刻、同一事务**内快照六类状态——区段占用、
    道岔位置、开放进路的信号与走行进度（锁闭、事件序号/头尾步）、等待申请、
    延时取消申请、未结束封锁，并记录**生成时间与交班人**。
  - 接班值班员在值班台"交接班交接单"面板查看完整快照并**签收**；接班人姓名
    **必须与交班人不同**（本人签收自己的单直接拒绝）。
  - 签收时在**同一时刻的状态上原子判定**：若生成后上述任一状态发生变化，签收
    **拒绝**、列出**变化类别与明细**，并把该单标记为**已过期**，由交班人重新
    生成；即使状态事后复原，旧单也不再有效。生成与签收均经单连接同步事务串行
    执行，并发操作不可能使过时交接单签收成功。
  - **同一接班人重复签收**幂等返回原结果（HTTP 200，`repeated:true`）；**其他
    人**对已签收单重复签收拒绝（409）。同一交班人生成新单时，其此前未签收单
    自动标记过期（被新单替换）。
  - 交接单只写自身快照、**不阻塞**任何现有进路/事件/等待/取消/封锁操作；
    **站场重置**（清空推演状态/培训重开）使全部未签收单过期，**已签收单保留**
    供复盘。记录全部持久化，刷新页面或服务重启后仍可查询；未签收单重启后仍可
    签收。
- **联锁规则**
  - 开放时在单个 SQLite 事务内检查并锁定资源：区段被占用（含**未知状态按占用处理**）、
    道岔实际位置与要求不符、资源已被其他开放进路锁定时一律拒绝，**回滚且不留下
    部分锁定**。
  - 两名值班员同时申请冲突进路，借助数据库唯一约束 + 事务，只可能成功一条。
  - 事件序号必须严格递增：同号同内容重传幂等不重复生效；同号异内容、跳号一律拒绝，
    并指出涉及区段。
  - 已开放进路锁定的道岔不得扳动；错误操作均返回涉及的区段/道岔/信号编号与原因。
  - 所有状态保存在本地 SQLite，刷新页面后完全恢复。
- **角色**：管理员（口令登录，默认 `admin` / `admin123`，可通过环境变量修改）；
  值班员输入姓名即可登录，支持两名及以上值班员同时操作，冲突在服务端仲裁。

## 技术栈

- Node.js + Express（REST API）
- SQLite（[`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3)，同步事务）
- 原生 HTML/CSS/JavaScript + SVG 站场图，无前端构建步骤
- Docker / Docker Compose 一键启动

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 服务端口 |
| `DB_PATH` | `/data/interlock.db`（容器内） | SQLite 数据库文件路径，父目录不存在会自动创建 |
| `ADMIN_PASSWORD` | `admin123` | 管理员登录口令 |
| `SEED_DEMO` | `1` | 首次启动且库为空时是否写入示例站场（1 写入 / 0 不写入） |

## 一键启动（推荐 Docker Compose）

```bash
docker compose up -d --build
```

容器启动时会自动完成：npm 依赖安装（已构建进镜像）、建表、以及（首次）写入一套
示例站场数据。数据通过命名卷 `interlock-data` 持久化到宿主机。

停止并保留数据：

```bash
docker compose down
```

清除全部本地数据重新开始：

```bash
docker compose down -v
docker compose up -d --build
```

## 本地直接运行（需要 Node.js ≥ 18）

```bash
npm install
DB_PATH=./data/interlock.db npm run init-db   # 建表 + 初始化示例数据（可选，start 也会自动建表）
DB_PATH=./data/interlock.db npm start
```

## 网页地址与端口

启动后浏览器访问：

| 页面 | 地址 |
| --- | --- |
| 登录入口 | http://localhost:3000/ |
| 管理员工作台 | http://localhost:3000/admin.html |
| 值班员工作台 | http://localhost:3000/dispatcher.html |

如修改了 `PORT`（例如 `PORT=8080`），请相应改为 `http://localhost:8080/`。

## 示例站场

首次启动写入的示例站场（见 `src/seed.js`）：

```
  X1 ●──── S1 ──[ 1 ]─[ 3 ]──[ 5 ]────● X3   正线（直股）
                    ╲       ╱
                   [2]─[4]╱         侧线（弯股）
                    SW7    SW8
```

- 区段：`1`～`5`；道岔：`SW7`（位置 N 直股 / R 弯股）、`SW8`（N 直股 / R 弯股）
- 信号机：`S1`（下行入口，防护进路 R1/R3）、`S3`（上行出口）、`S2`（侧线入口，
  防护进路 R2）、`S4`（侧线出口）
- 进路：
  - **R1 正线通过** X1→X3：区段 1,3,5，道岔 SW7=N、SW8=N
  - **R2 正线至侧线** X1→X4：区段 1,3,4,2，道岔 SW7=R、SW8=R
  - **R3 侧线至正线** X2→X3：区段 2,4,3,5，道岔 SW7=R、SW8=R
  - R1 与 R2/R3 争用区段 1/3 与道岔；R2 与 R3 争用 2/3/4 与道岔 —— 可用于验证
    "两人同时申请冲突进路只成功一条"。

> 示例区段初始状态为"空闲"，便于开箱即用。**管理员之后新建的区段初始状态为
> "未知（按占用处理）"**，需要由值班员先提交"清空"事件（序号 1）后才可用于进路。
> 道岔初始位置一律为 N（定位/直股）。

## 典型操作流程（值班员）

1. 登录后选择进路（如 R1），核对道岔要求位置（与实际不符时先在"道岔操作"区扳动，
   未锁定的道岔才允许扳动）。
2. 点击"预检"查看能否开放及阻断原因；点击"开放进路"，沿途区段与道岔被原子锁定，
   信号机转绿（允许）。
3. 在"事件提交"区按列车走行顺序逐段提交事件，序号从 1 开始递增：
   `1 占用 区段1` → 信号立即回红；`2 清空 区段1`（区段1自动解锁）→
   `3 占用 区段3` → `4 清空 区段3` → …… 末段（区段5）清空后整条进路自动解除。
4. 已清空的经过区段会逐段解锁；**末段未清空前，整条进路保持锁闭、信号保持红灯**。
5. 同号同内容重传返回成功但不会重复生效（幂等）；同号异内容、跳号会被拒绝并提示
   涉及区段与正确序号。
6. 若进路已开放但列车尚未进入（无走行占用事件），需要延时取消：在进路卡片点
   "申请延时取消"，入口信号立即回红、锁闭保留，保护期满且沿途区段均空闲才解除；
   保护期内一旦收到首段占用事件即自动终止取消，继续按走行处理。

## 等待申请（排路等待）用法

当进路暂时不能开放（区段占用/未知、道岔实际位置不符、他路锁闭），值班员不必反复
手工重试：在值班台选择进路并核对道岔选择后，点**"提交等待申请（不预锁）"**即可。

- 等待期间不会锁定任何资源，直接开放与正常走行不受影响；申请面板中可看到每条申请的
  **编号、顺位、当前阻断原因**，已兑现的会显示对应的**进路实例编号**。
- 下列任一事件发生时系统自动重新尝试兑现：提交申请时、区段状态变化（占用/清空）、
  道岔扳动、进路逐段解锁或整条解除、管理员变更定义（可能导致失效）、**临时封锁结束**、
  服务重启。
- 排队规则：与仍在等待的前项申请**共享区段或道岔**时按提交顺序等待，不得越过；
  与前项**资源互不相交**的申请可以先行兑现（顺位只统计共享资源的前项数）。
- 本人申请在未兑现前可随时撤销；前项撤销后后项顺位自动前移。
- 进路定义被修改或删除时，相关未兑现申请标记为"已失效"并说明原因；退出登录或
  管理员"清空推演状态/恢复示例初始状态"会撤销全部未兑现申请。

### 等待申请 HTTP API（含调用示例）

所有接口均需值班员 Bearer 令牌（登录接口见下）；令牌也可通过登录时下发的
`sid` Cookie 传递。

先登录获取令牌：

```bash
curl -s -X POST http://localhost:3000/api/auth/login/dispatcher \
  -H 'Content-Type: application/json' \
  -d '{"name":"值班员甲"}'
# -> {"ok":true,"token":"abcd1234…","role":"dispatcher","name":"值班员甲"}
TOKEN=abcd1234…
```

**1) 提交等待申请**（按进路编号 + 所选道岔位置；不预锁资源，提交后立即尝试兑现）

```bash
curl -s -X POST http://localhost:3000/api/routes/R1/waiting \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"switchPositions":{"SW7":"N","SW8":"N"}}'
```

立即兑现成功：

```json
{"ok":true,"waiting":{"id":7,"seq":7,"routeId":"R1","applicant":"值班员甲",
 "switchPositions":{"SW7":"N","SW8":"N"},"status":"fulfilled","instanceId":12,
 "instance":{"id":12,"routeId":"R1","status":"open","signalState":"green"},
 "blockReasons":[],"position":null}}
```

暂不具备条件时进入等待（HTTP 201，`status:"waiting"`），字段含义：

| 字段 | 说明 |
| --- | --- |
| `id` / `seq` | 申请编号（自增，即提交顺序号） |
| `position` | 当前顺位：提交更早且共享区段/道岔、仍在等待的申请数 + 1 |
| `blockReasons` | 最近一次兑现尝试的阻断原因（占用/未知区段、临时封锁、道岔实际位置不符、他路锁闭、前项未兑现等） |
| `blockedBy` | 因"前项未兑现"被拦截时，挡在前面的申请编号列表 |
| `instanceId` / `instance` | 兑现后产生的进路实例编号与摘要（等待中为 `null`） |
| `status` | `waiting` 等待中 / `fulfilled` 已兑现 / `cancelled` 已撤销 / `invalid` 已失效 |
| `endReason` | 撤销或失效说明 |

提交被拒的情形：未知进路 `404 ROUTE_NOT_FOUND`；缺少道岔选择
`400 SWITCH_NOT_CHOSEN`；选择与进路定义不符 `409 SWITCH_POSITION_MISMATCH`；
选择了进路不要求的道岔 `400 SWITCH_NOT_IN_ROUTE`；位置非 N/R `400 BAD_POSITION`。

**2) 查看等待申请**（默认只返回本人的；加 `scope=all` 可查看全员用于仲裁展示；
等待与结果随 `/api/state` 一并下发，页面刷新/重启后同样可见）

```bash
curl -s "http://localhost:3000/api/waiting" -H "Authorization: Bearer $TOKEN"          # 本人
curl -s "http://localhost:3000/api/waiting?scope=all" -H "Authorization: Bearer $TOKEN" # 全员
curl -s "http://localhost:3000/api/waiting?status=waiting" -H "Authorization: Bearer $TOKEN"
```

**3) 撤销本人未兑现申请**（非本人 403 `NOT_OWNER`；已结束 409 `WAITING_NOT_ACTIVE`；
不存在 404 `WAITING_NOT_FOUND`；撤销后系统立即尝试兑现后续申请）

```bash
curl -s -X POST http://localhost:3000/api/waiting/7/cancel \
  -H "Authorization: Bearer $TOKEN"
```

兑现成功的进路实例与普通开放完全一致：可通过
`POST /api/instances/:id/events` 提交带序号的走行事件，末段清空后自动解除，
解除瞬间会自动触发其他等待申请兑现。

## 延时取消（保护期后取消）用法

当一条已开放进路暂无列车进入（**无任何走行占用事件**），值班员希望在给现场留出一段
防护时间后自动取消它，可在值班台该进路卡片上点**"申请延时取消"**（或调用下面的
HTTP API）。

- 申请**立即令入口信号回红**，原区段锁与道岔锁**继续保留**；保护期内已排队的等待
  申请因锁仍在**不会提前兑现**。值班台显示"延时取消中"徽标与实时倒计时（剩余时间 +
  最早解除时刻）。
- 保护时长由管理员在"推演管理 → 延时取消保护时长"中设置（**正整数秒**，默认 60 秒）；
  申请时把时长快照入库，**之后修改设置不追改已有申请**，只对新申请生效。
- 保护期内收到该实例**首段占用事件**：走行事件照常受理，取消申请立即终止（信号红、
  锁闭保留，按正常走行逐段解锁）。
- 到期时系统在**同一事务内重查**：① 实例仍开放；② 无走行占用记录；③ 沿途区段均
  空闲。三者满足才解除进路（删全部锁、信号红）并触发等待申请兑现；任一不满足则
  **终止取消申请、保留锁闭并写明原因**（如"沿途区段 5 当前被占用"），值班员可继续
  走行处理，条件恢复后重新申请。
- **重复申请**：同一实例已有待处理申请时，接口返回原申请（`created:false`），不缩短
  期限、不产生第二笔。
- 服务重启后定时器继续运行：未到期申请继续等待，重启期间已到期的启动即处理；
  管理员"清空推演状态/培训重开"会把申请与进路实例一并清除。

### 延时取消 HTTP API（含调用示例）

需值班员 Bearer 令牌（登录方式同上一节）。

**1) 申请延时取消**（仅已开放且无走行占用记录的实例）

```bash
curl -s -X POST http://localhost:3000/api/instances/12/cancel-delayed \
  -H "Authorization: Bearer $TOKEN"
```

新申请返回 **201**（重复申请命中同一条 pending 时返回 **200** 且 `created:false`）：

```json
{"ok":true,"created":true,
 "cancellation":{"id":3,"instanceId":12,"applicant":"值班员甲","status":"pending",
  "durationSeconds":60,"requestedAt":1790820000000,"releaseAt":1790820060000,
  "processedAt":null,"remainingMs":59982,"overDue":false,"endReason":null}}
```

| 字段 | 说明 |
| --- | --- |
| `status` | `pending` 保护期等待中 / `released` 到期核验通过已解除 / `aborted` 条件不符或已走行，终止（锁闭保留） |
| `durationSeconds` | 申请时的保护时长快照（秒）；管理员之后改设置不影响它 |
| `requestedAt` / `releaseAt` | 申请时刻 / 最早解除时刻（epoch 毫秒） |
| `remainingMs` | 剩余毫秒（pending 时有效，到期为 0；前端按服务器时钟校准倒计时） |
| `endReason` | 解除说明，或终止原因（首段占用、区段占用/未知等） |

被拒情形：实例不存在或已解除 `404 INSTANCE_NOT_FOUND`；已有走行占用记录
`409 CANCEL_OCCUPANCY_EXISTS`；未登录 `401`；管理员身份 `403`。

**2) 查看延时取消申请**（默认本人全部；`scope=all` 全员；可加
`?status=pending|released|aborted`；待处理申请也随 `/api/state` 的
`pendingCancellations`、`cancellationRequests`、`cancelProtectionSeconds` 下发）

```bash
curl -s "http://localhost:3000/api/cancellations" -H "Authorization: Bearer $TOKEN"
curl -s "http://localhost:3000/api/cancellations?scope=all&status=pending" \
  -H "Authorization: Bearer $TOKEN"
```

**3) 管理员设置保护时长**（需管理员令牌；正整数秒，1~604800；只影响之后新申请）

```bash
# 查询
curl -s http://localhost:3000/api/admin/settings/cancel-protection \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# -> {"ok":true,"protectionSeconds":60,"defaultSeconds":60,"maxSeconds":604800}

# 修改
curl -s -X PUT http://localhost:3000/api/admin/settings/cancel-protection \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"protectionSeconds":120}'
# -> {"ok":true,"protectionSeconds":120,"note":"已更新；仅对之后提交的延时取消申请生效…"}
```

非法值（0、负数、小数、非数字）返回 `400 BAD_PROTECTION_SECONDS`。

## 临时封锁用法

管理员因施工、抢修等原因需要临时禁止某区段排进新路时，在管理员页面"临时封锁"区
选择区段、填写原因后点**"发起封锁"**（或调用下面的 HTTP API）。值班员在值班台
"临时封锁"面板、区段选择列表与站场图（区段下方红色 `⊘封锁中/⊘封锁待生效` 标记）
都能看到封锁状态。

- 发起即生效于"新排路"：该区段参与的新**预检**会在阻断原因中列出封锁，**直接开放**
  返回 `409 SECTION_BLOCKADED`，**等待申请**保持等待、顺位不变并把阻断原因刷新为
  封锁原因。**已开放进路不受任何影响**：锁闭、走行事件、延时取消规则原样。
- 状态转换：区段空闲且无进路锁 → 自动**已生效**；占用/未知/仍锁闭 → 保持**待生效**，
  系统在走行出清、独立区段状态变化、延时取消到期、进路解除、服务重启后自动复核。
- 结束：管理员结束待生效/已生效封锁后，系统按现有联锁规则重试等待兑现；区段占用
  状态保持原样（封锁与结束都不改写占用状态）。

### 临时封锁 HTTP API（含调用示例）

先登录获取管理员令牌：

```bash
curl -s -X POST http://localhost:3000/api/auth/login/admin \
  -H 'Content-Type: application/json' \
  -d '{"password":"admin123"}'
# -> {"ok":true,"token":"cafe1234…","role":"admin","name":"管理员"}
ADMIN_TOKEN=cafe1234…
```

**1) 发起临时封锁**（按区段编号 + 封锁原因）

```bash
curl -s -X POST http://localhost:3000/api/admin/blockades \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"sectionId":"3","reason":"道岔检修施工"}'
```

新申请返回 **201**；同一区段已有未结束（待生效/已生效）封锁时返回 **200** 且
`created:false`，内容为原申请（不因为重复申请产生第二笔）：

```json
{"ok":true,"created":true,
 "blockade":{"id":2,"sectionId":"3","applicant":"管理员","reason":"道岔检修施工",
  "status":"pending","createdAt":"2026-10-01 06:30:00",
  "activatedAt":null,"endedAt":null,"endReason":null}}
```

| 字段 | 说明 |
| --- | --- |
| `id` | 封锁申请编号（自增） |
| `status` | `pending` 待生效 / `active` 已生效 / `ended` 已结束 |
| `reason` | 封锁原因（首尾空白自动去除，空白原因拒绝） |
| `activatedAt` | 转为已生效的时刻（区段空闲且无进路锁时） |

被拒情形：未知区段 `404 SECTION_NOT_FOUND`；空白/缺失原因
`400 BLOCKADE_REASON_REQUIRED`；未登录 `401`；值班员身份 `403`。

**2) 查看封锁列表**（管理员；未结束在前，可加 `?status=pending|active|ended`）

```bash
curl -s "http://localhost:3000/api/admin/blockades" -H "Authorization: Bearer $ADMIN_TOKEN"
curl -s "http://localhost:3000/api/admin/blockades?status=active" -H "Authorization: Bearer $ADMIN_TOKEN"
```

值班员只读查看（未结束封锁也随 `/api/state` 的 `blockades` 与
`blockadesBySection` 一并下发，页面据此显示）：

```bash
curl -s "http://localhost:3000/api/blockades" -H "Authorization: Bearer $TOKEN"
```

**3) 结束封锁**（待生效/已生效均可结束；结束后自动按现有联锁规则重试等待兑现）

```bash
curl -s -X POST http://localhost:3000/api/admin/blockades/2/end \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# -> {"ok":true,"blockade":{"id":2,"status":"ended","endedAt":"2026-10-01 06:41:12",…}}
```

被拒情形：申请不存在 `404 BLOCKADE_NOT_FOUND`；已结束 `409 BLOCKADE_NOT_ACTIVE`。

封锁期间值班员既有接口行为：预检 `POST /api/routes/:id/check` 的 `reasons` 会包含
"区段 X 已被临时封锁（申请 #N，…，原因：…）"；直接开放
`POST /api/routes/:id/open` 返回 `409 SECTION_BLOCKADED`；走行事件
`POST /api/instances/:id/events`、延时取消等既有接口约定不变。

## 交接班交接单用法

值班员交班时，在值班台右侧"交接班交接单"面板点**"生成交接单（交班）"**（或调用
下面的 HTTP API）。系统在**同一时刻、同一事务**内快照六类盘面状态并记录交班人与
生成时间，不锁定任何业务资源，排路、走行、等待、取消、封锁等操作**一切照常**。

接班人（须用**与交班人不同的姓名**登录）在面板查看交接单内容并点**"签收（接班）"**，
系统按签收时刻的状态原子比对：

- 六类快照均无变化 → 签收成功（HTTP 201），写入接班人与签收时间；
- 任一类别变化 → 签收拒绝（HTTP 409 `HANDOVER_STALE`），返回**变化类别
  `changedCategories` 与逐条明细 `changes`**，该单同时被标记为**已过期**；
  交班人核对现场后**重新生成**，接班人再签收。即使状态后来复原，旧过期单也不再有效；
- 交班人本人签收拒绝（`HANDOVER_SAME_PERSON`）；
- 同一接班人对已签收单重复签收 → 幂等返回原结果（HTTP 200，`repeated:true`）；
  其他人重复签收 → 409 `HANDOVER_ALREADY_SIGNED`；
- 同一交班人再次生成 → 本人此前未签收单自动标记过期（被新单替换）；
- 管理员"清空推演状态/培训重开"→ 全部未签收单过期，**已签收单保留供复盘**；
- 刷新页面、服务重启后交接单记录仍在；未签收单重启后仍可签收。

被快照与比对的六类状态（变化类别 `changedCategories` 取值）：

| 类别 code | 含义 | 典型变化明细 |
| --- | --- | --- |
| `sections` | 区段占用 | `区段 2：占用状态由 空闲 变为 占用` |
| `switches` | 道岔位置 | `道岔 SW7：位置由 N 变为 R` |
| `openInstances` | 开放进路的信号与走行进度 | 新开放/已解除、信号绿↔红、下一序号与头尾步、走行事件、区段逐段解锁 |
| `waiting` | 等待申请 | 新提交；等待中→已兑现/已撤销/已失效 |
| `cancellations` | 延时取消申请 | 新提交；待处理→到期已解除/已终止 |
| `blockades` | 未结束封锁 | 新发起封锁；封锁已结束 |

### 交接班 HTTP API（含调用示例）

需值班员 Bearer 令牌（管理员令牌不可用，返回 403；登录方式见"等待申请"一节）。

**1) 交班人生成交接单**（同一事务快照六类状态；本人此前未签收单被新单替换过期）

```bash
curl -s -X POST http://localhost:3000/api/handovers \
  -H "Authorization: Bearer $TOKEN"
```

返回 **201**：

```json
{"ok":true,"handover":{"id":12,"fromName":"值班员甲","toName":null,
 "status":"active","generatedAt":1790853565744,"generatedAtText":"2026/10/1 11:19:25",
 "signedAt":null,"signedAtText":null,
 "snapshot":{"sections":{"1":"free","2":"free","3":"occupied","4":"unknown","5":"free"},
  "switches":{"SW7":"N","SW8":"R"},
  "openInstances":{"11":{"routeId":"R1","status":"open","signalState":"red",
    "nextSeq":3,"headStep":2,"tailStep":1,
    "lockedSections":["1","3","5"],"lockedSwitches":["SW7","SW8"],
    "events":[{"seq":1,"sectionId":"1","action":"occupy"}]}},
  "waiting":{"7":{"routeId":"R1","applicant":"值班员乙","status":"waiting","instanceId":null,"switchPositions":{"SW7":"N","SW8":"N"}}},
  "cancellations":{"3":{"instanceId":11,"applicant":"值班员甲","status":"pending",
    "durationSeconds":60,"requestedAt":1790853500000,"releaseAt":1790853560000}},
  "blockades":{"2":{"sectionId":"3","applicant":"管理员","reason":"道岔检修施工","status":"active"}},
 "changedCategories":[],"changes":[],"expireReason":null}}
```

**2) 接班人签收**（姓名须与交班人不同；状态无变化才成功）

```bash
curl -s -X POST http://localhost:3000/api/handovers/12/sign \
  -H "Authorization: Bearer $TOKEN_B"
```

成功返回 **201**；同一接班人重复签收返回 **200** 且 `repeated:true`（内容为原签收结果）。
生成后状态变化返回 **409 `HANDOVER_STALE`**（该单已同事务标记过期）：

```json
{"ok":false,
 "error":"签收拒绝：生成交接单后以下状态已发生变化：区段占用、道岔位置；交接单标记过期，请重新生成",
 "code":"HANDOVER_STALE",
 "changedCategories":["sections","switches"],
 "changes":[
   {"category":"sections","label":"区段占用","details":["区段 2：占用状态由 空闲 变为 占用"]},
   {"category":"switches","label":"道岔位置","details":["道岔 SW7：位置由 N 变为 R"]}],
 "reason":"…"}
```

签收相关错误码：

| HTTP | code | 情形 |
| --- | --- | --- |
| 409 | `HANDOVER_SAME_PERSON` | 接班人姓名与交班人相同（本人签收自己的单） |
| 409 | `HANDOVER_STALE` | 生成后快照状态发生变化（响应含 `changedCategories`/`changes`，单已标记过期） |
| 409 | `HANDOVER_EXPIRED` | 单子已过期（被新单替换/站场重置/此前签收已检出变化），须重新生成 |
| 409 | `HANDOVER_ALREADY_SIGNED` | 已被他人签收；同一人重复签收则为幂等 200 |
| 404 | `HANDOVER_NOT_FOUND` | 交接单不存在 |

**3) 查看列表 / 查看单张**（列表也随 `GET /api/state` 的 `handovers` 一并下发）

```bash
# 全员（默认）；?status=active|signed|expired 可按状态过滤
curl -s "http://localhost:3000/api/handovers" -H "Authorization: Bearer $TOKEN"
# 只看与本人相关（本人交班或接班）
curl -s "http://localhost:3000/api/handovers?scope=mine" -H "Authorization: Bearer $TOKEN"
# 单张完整内容（含六类快照与过期变化明细）
curl -s "http://localhost:3000/api/handovers/12" -H "Authorization: Bearer $TOKEN"
```

列表顺序：待签收在前，其次已签收、已过期；同组内新单在前。交接单**不改变任何既有
接口契约**：进路预检/开放、走行事件、等待、延时取消、临时封锁接口的请求与响应均与
此前一致。

## 命名演练副本用法（多站场演练）

管理员可以把**原站场当前盘面**复制成一个独立的命名**演练副本**，用于在不影响原站场
（或其他演练）的前提下并行推演、复盘或反复训练。副本是一个**独立的 SQLite 数据库文件**
（与原站场库同目录，文件名 `yard-<副本编号>.db`），因此：

- **复制内容（同一事务内一致快照）**：站场定义（区段/道岔/信号机/进路定义）、
  区段占用与道岔当前位置、**开放进路的锁与走行事件进度**、**未兑现等待申请**、
  **未完结延时取消申请**（pending）、**未完结临时封锁**（待生效/已生效），以及
  延时取消保护时长设置。
- **不复制**：历史交接班交接单（留在原站场）、已解除进路实例与其事件、已兑现/已撤销/
  已失效等待、已解除/已终止延时取消、已结束封锁、会话记录。
- 副本与原站场（以及各副本之间）**独立运行**：站场编辑、预检、开放、走行、区段与道岔
  调整、等待及延时取消、临时封锁、交接单和重置**都只作用于当前站场**；**锁闭和申请顺位
  不串用**（同样编号的进路实例/锁/申请在各站场各自独立）。
- 复制的延时取消**沿用原到期时刻**（`releaseAt` 不变）：在副本里到期才按副本数据重查，
  **不重新计时**；服务重启后定时器按**各站场分别**复核，已处理的不会重复兑现。
- **选择是会话级的**：每个登录会话（管理员/值班员）各自记住当前站场；未选择时一律使用
  **原站场**，因此既有接口请求与响应约定完全兼容。
- 未知副本（切换到不存在的编号）返回 `404 YARD_NOT_FOUND`；只有管理员能创建副本，
  值班员调用返回 `403`。

页面上：顶栏有**当前站场下拉框**（原站场 / 各演练副本），值班台与管理台顶部显示当前
站场横幅，全部数据与操作即当前站场；管理台"演练站场"面板可从原站场一键创建副本。

### 演练副本 HTTP API（含调用示例）

**1) 管理员创建命名副本**（仅能从原站场创建；同名 409 `YARD_NAME_EXISTS`）

```bash
curl -s -X POST http://localhost:3000/api/admin/yards \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"10月应急演练"}'
```

返回 **201**：

```json
{"ok":true,
 "yard":{"id":1,"name":"10月应急演练","sourceId":0,"status":"ready",
         "isOriginal":false,"createdBy":"管理员","createdAt":"2026-10-02 00:18:08"},
 "status":"ready",
 "copied":{"sections":5,"switches":2,"signals":4,"routes":3,
           "routeInstances":1,"routeLocks":5,"sectionEvents":0,
           "waitingApplications":1,"cancellationApplications":1,
           "blockadeApplications":1,"handovers":0}}
```

| 字段 | 说明 |
| --- | --- |
| `yard.id` / `status` | **副本编号**（正整数，后续切换用）与状态（创建后即可用，恒为 `ready`） |
| `yard.sourceId` | 来源站场，固定 `0`（原站场） |
| `copied` | 各类复制行数：开放实例/锁/事件、未兑现等待、未完结取消/封锁；`handovers` 恒为 0 |

创建被拒情形：名称为空 `400 YARD_NAME_REQUIRED`；超过 30 字 `400 YARD_NAME_TOO_LONG`；
名为"原站场" `400 YARD_NAME_RESERVED`；同名 `409 YARD_NAME_EXISTS`；未登录 `401`；
值班员 `403`。

**2) 查询站场列表**（管理员）

```bash
curl -s http://localhost:3000/api/admin/yards -H "Authorization: Bearer $ADMIN_TOKEN"
# -> {"ok":true,"yards":[
#   {"id":0,"name":"原站场","isOriginal":true,...},
#   {"id":1,"name":"10月应急演练","sourceId":0,"isOriginal":false,...}]}
```

**3) 会话选择当前站场**（管理员、值班员通用；`yardId:0` 回到原站场）

```bash
# 切到副本 1
curl -s -X PUT http://localhost:3000/api/session/yard \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"yardId":1}'
# -> {"ok":true,"yard":{"id":1,"name":"10月应急演练",...},"yards":[...]}

# 回到原站场
curl -s -X PUT http://localhost:3000/api/session/yard \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"yardId":0}'

# 查看当前会话站场
curl -s http://localhost:3000/api/session -H "Authorization: Bearer $TOKEN"
# -> {"ok":true,"me":{...},"yard":{"id":1,...},"yards":[...]}
```

未知副本返回 `404 YARD_NOT_FOUND`（会话保持原选择不变）；非法编号 `400 BAD_YARD_ID`；
未登录 `401`。

**4) 切换后，既有一切接口都只作用于当前站场，且请求/响应结构不变**：

```bash
# 以下都在副本 1 上执行（实例/等待/取消/封锁/交接单编号均为该副本内编号）
curl -s http://localhost:3000/api/state -H "Authorization: Bearer $TOKEN"
curl -s -X POST http://localhost:3000/api/routes/R1/open \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"switchPositions":{"SW7":"N","SW8":"N"}}'
```

`GET /api/state`（值班员）与 `GET /api/admin/state`（管理员）的响应在保持原有全部字段的
基础上，**新增一个 `yard` 字段**表示当前站场；其余字段语义与此前完全一致。

> 多会话并行示例：值班员甲 `PUT /api/session/yard {"yardId":1}` 后在副本里开放/走行，
> 值班员乙不切换（仍为原站场）同时操作同一进路——两边各自持锁、各自的等待顺位独立，
> 互不可见、互不阻断；历史交接单只在原站场可查。

## 数据持久化与重置

- 全部拓扑、状态、事件、进路实例、会话、**等待申请、延时取消申请与保护时长设置、
  临时封锁申请、交接班交接单**均在本地 SQLite（默认卷 `interlock-data`）。
  **原站场**使用主库（默认 `/data/interlock.db`）；**每个演练副本**是同目录下的独立文件
  `yard-<编号>.db`，`yards` 副本登记表与 `sessions` 会话表只保存在主库；备份演练数据时
  请一并备份主库与全部 `yard-*.db`。
- **重置/编辑只作用于当前站场**：在副本页面执行"清空推演状态/培训重开"或修改站场图，
  不会影响原站场或其他副本；副本的历史交接单为空（交接单从建副本后才开始累计）。
- 管理员页面"推演管理"提供：**清空推演状态**（删除进路实例/事件，区段恢复为未知、
  道岔回 N，保留站场图；同时撤销全部未兑现等待申请、**清除全部延时取消申请与临时
  封锁记录、使未签收交接单过期（已签收单保留供复盘）**）；**恢复示例初始状态**
  （额外把示例区段置为空闲；同样撤销/清除/过期）。
  "推演管理"中还可设置延时取消保护时长（正整数秒，仅影响之后新申请；副本的设置随复制
  独立保存，之后各站场分别修改互不影响）。
- 存在已开放进路期间，站场图（拓扑/进路定义）不可编辑，防止改变正在使用的线路。
- 值班员退出登录会在**每个站场**分别撤销其本人未兑现等待申请；进路定义被修改/删除时，
  相关未兑现申请保留记录并标记失效、写明原因（已兑现产生的进路实例记录不受影响）。
- 服务重启后对**原站场与每个副本分别**执行：等待申请兑现扫描、待生效封锁复核、延时取消
  到期处理。满足等待条件即兑现、不满足继续等待，任何情况下一条申请至多对应一个进路实例。
- 延时取消的到期处理随服务启动：对各站场启动即扫描一次（处理重启期间已到期的申请），
  之后每 0.5 秒逐站场扫描；未到期申请继续倒计时，到期按同一事务重查结果解除或终止。
  **复制到副本的申请沿用原 `releaseAt`，不会因复制/重启重新计时，已处理的不重复兑现**。
- 临时封锁随服务持久化：重启后各站场未结束封锁继续有效，并在启动时复核一次（区段空闲且
  无进路锁的待生效申请转为已生效）；区段被删除时其未结束封锁自动标记结束并保留记录。

## 目录结构

```
├── Dockerfile
├── docker-compose.yml
├── package.json
├── scripts/init-db.js         # 显式建表/初始化脚本
├── src/
│   ├── server.js              # Express 入口与静态资源（逐站场启动复核与定时扫描）
│   ├── db.js                  # SQLite：目录库(原站场)/副本库连接 + 站场上下文(AsyncLocalStorage)
│   ├── yards.js               # 演练副本（登记/命名校验/VACUUM INTO 一致快照+事务裁剪/会话选择）
│   ├── schema.sql             # 表结构（含 yards 副本登记、sessions.current_yard_id）
│   ├── seed.js                # 示例站场
│   ├── auth.js                # 会话与鉴权（按会话所选站场建立请求上下文）
│   ├── interlocking.js        # 核心联锁逻辑（开放/事件/解锁/扳岔，含封锁校验）
│   ├── waiting.js             # 等待申请（提交/撤销/顺位/事务内自动兑现）
│   ├── cancellation.js        # 延时取消（申请/保护期/到期同事务核验/重启续处理）
│   ├── blockade.js            # 临时封锁（发起/结束/待生效复核/重置清除）
│   ├── handover.js            # 交接班交接单（生成原子快照/签收同事务比对/过期/重置与重启）
│   └── routes/
│       ├── auth.js
│       ├── session.js         # 当前会话站场查询/选择（GET /api/session、PUT /api/session/yard）
│       ├── admin.js           # 含副本创建/列表、保护时长、封锁、重置（均只作用于当前站场）
│       └── api.js             # 值班员接口（等待/延时取消/封锁只读/交接单，均只作用于当前站场）
├── public/                    # 前端页面（登录/管理员/值班员，顶栏站场切换 + 副本创建面板）
└── test/
    ├── smoke.cjs              # 无需鉴权的联锁冒烟/并发测试脚本
    ├── waiting-http.cjs       # 等待申请 HTTP 端到端测试（含重启场景）
    ├── cancellation-http.cjs  # 延时取消 HTTP 端到端测试（含到期/终止/重启/重置）
    ├── blockade-http.cjs      # 临时封锁 HTTP 端到端测试（含阻断/复核/结束/重启/重置）
    ├── handover-http.cjs      # 交接单 HTTP 端到端测试（含六类变化/重复签收/并发/重置/重启）
    └── yards-http.cjs         # 命名演练副本端到端（事务复制/同名拒绝/越权/独立运行/重启分别复核）
```

## 测试

```bash
npm test             # 冒烟 + 等待 + 延时取消 + 封锁 + 交接班 + 演练副本端到端（共 519 项断言）
npm run smoke        # 联锁核心规则
npm run test:waiting# 等待申请提交/撤销/顺位/自动兑现/失效/重启
npm run test:cancel  # 延时取消申请/重复幂等/到期解除/首段占用终止/区段占用终止/重启/重置
npm run test:blockade# 临时封锁发起/校验/阻断/状态复核/结束/重启/重置
npm run test:handover# 交接单生成/六类快照/签收原子判定/变化过期/重复幂等/并发/站场重置/重启
npm run test:yards  # 副本创建/同事务复制/同名拒绝/越权/会话选站/锁与顺位不串用/重置隔离/重启复核
```
