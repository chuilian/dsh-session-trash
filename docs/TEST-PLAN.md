# 测试计划与执行结果

> 运行方式：见文末「如何运行」。**当前结果：137 必测项全部通过；另有 3 项真实 React 渲染检查（可选安装 React，本机已验证），合计 140 / 140。**

本插件涉及不可逆的数据操作，测试策略的核心不是覆盖率数字，而是**把每一条安全承诺都变成本可以失败的可执行断言**。

---

## 1. 测试策略

### 1.1 测试金字塔的取舍

| 层 | 内容 | 数量 | 为什么在这一层测 |
|---|---|---|---|
| 单元（纯函数） | `encodeSegment` / `projectKey` / `isInside` / `isSafeSessionId` / `isSafeTrashId` | 14 | 零 IO、确定性、可穷举边界（穿越、代理对、NUL、超长） |
| 单元（真实文件系统） | `TrashStore` 全生命周期、崩溃窗口、包含性、符号链接 | 18 | 回收站的正确性**就是**文件系统的正确性，必须用真实文件而不是 mock |
| 单元（服务守卫） | `SessionTrashService` 的同意门槛、释放/强制、记账清理、批次语义、审计 | 20 | 这是「允不允许删」的决策层，最重要 |
| 集成（宿主链路） | 定位器三层 + 包含性校验 + 降级，与服务/回收站联合 | 16 | 单层都对但拼起来错，是这类插件的典型事故 |
| 契约 + 纯逻辑（客户端产物） | 直接加载 `lib/client.js`，按浏览器的方式 | 33 | 验证「平台模块表」「空 inject」「服务门禁」这类会让整页挂掉的契约，以及删除前的视图释放 |
| HTTP 端到端 | 真实 `node:http` 服务器 + 真实请求，覆盖路由/方法/状态码/访问控制 | 20 | 路由层是客户端与宿主之间的全部契约 |
| **回归（复核缺陷 + 用户实测）** | 每个缺陷一条，且必须能对旧实现失败 | 25 | 见 §2.7 |
| **合计（必测）** | | **137** | |
| 可选：真实 React 渲染 | 用真实 `react` + `react-dom/server` 渲染全部注册项与各种状态 | 3 | 桩件抓不到条件调用 Hook、非法元素类型、非法 props；无 React 时自动跳过 |

不做的：端到端浏览器自动化（需要真实 GUI 与人工判断视觉一致性，见 §4 人工清单）。

### 1.2 为什么用真实文件系统而不是 mock fs

回收站的风险集中在**顺序**与**原子性**（`rename` 语义、fsync 屏障、跨设备回退、崩溃窗口）。mock 掉 `fs` 就会把要验证的东西一起 mock 掉。因此 `TrashStore` 的测试全部在 `fs.mkdtemp` 出来的真实临时目录里跑，并在 `t.after` 中清理。

### 1.3 假上下文必须复刻 Cordis 的服务门禁

客户端测试最初用一个「把服务挂在 `ctx` 上」的普通对象当假上下文。它**没能**发现一个致命缺陷：
`exports.inject = []` 却读取 `ctx.locale`，在真实 Cordis 里会抛
`cannot get property "locale" without inject`，进而让该 entry FAILED、DSH 启动审计失败、**整页不可用**。

根因是假上下文比真实实现宽松。现在两个客户端测试的假上下文都是 **Proxy**：

- 根上下文只允许 `get` / `effect` / `inject`，任何 `ctx.<service>` 都抛与 Cordis 相同的错误；
- `ctx.inject(deps, cb)` 交给回调的作用域**只允许 `deps` 里的服务属性**，越界同样抛错。

已用变异测试确认这条防线有效：把字典注册改回顶层 `ctx.locale.register(...)`，客户端测试立即失败并给出
`cannot get property "locale" without inject`。

### 1.4 为什么客户端要有契约测试

客户端 bundle 有两类「错一次就整页不可用」的错误：

1. `require` 了平台冻结模块表以外的 specifier → 模块加载抛错 → entry import failed；
2. 导出了非空 `inject` 且某个服务名不存在 → fiber pending → **DSH 启动审计失败，整页显示 "Failed to load plugins"**。

这两条都不能靠人工点几下发现（第 2 条在缺服务的组合里才会出现）。所以测试用 stub 的 `window.__ModuleLoader__` + stub `require`（**只**识别平台表里那 9 个 specifier）直接加载真实产物，并断言 `inject` 为空数组、`require` 集合恰为 3 个平台模块。

---

## 2. 用例清单

### 2.1 `tests/host/encode.test.js`（14）

| # | 用例 | 断言要点 |
|---|---|---|
| 1 | 复刻 ASCII+CJK 工作区目录名 | 与真实后端同形的样例 `--Users-example-Desktop-work-~7814~7A76--` 逐字符相等 |
| 2 | 复刻第二个目录名（纯 CJK 尾段） | `--Users-example-Desktop-work-~63D2~4EF6--` |
| 3 | 分隔符连续折叠、去前导 `-` | `/a//b///c` → `--a-b-c--`；`/` → `--root--` |
| 4 | 驱动器分隔符同路径分隔符 | `C:\Users\x` → `--C-Users-x--` |
| 5 | 不安全字符转义 | 空格 → `~0020`；`~` → `~007E` |
| 6 | 可读部分截断 | `--` + 251 + `--` = 255 字符 |
| 7 | 空路径拒绝 | 抛错 |
| 8 | 安全 id 保持字面量 | `session-<uuid>` 原样 |
| 9 | 穿越被中和 | `.`→`~002E`；`..`→`~002E~002E`；`../etc/passwd`→`..~002Fetc~002Fpasswd`（点号是安全码元，故保留；分隔符被转义） |
| 10 | 转义字符自身 | `a~b` → `a~007Eb` |
| 11 | 空段拒绝 | 抛错 |
| 12 | 非 BMP 字符按码元处理 | `\u{1F600}` → `~D83D~DE00` |
| 13 | 编码可逆 | 按 `~XXXX` 解码还原原文 |
| 13b | **任意恶意 id 都无法逃出目录** | 结果不含 `/` 或 `\`，且不等于 `.` / `..` |

> 用例 1、2 是本套测试中最重要的两个：它们是防止「复刻函数悄悄偏离上游」的唯一回归锚点。

### 2.2 `tests/host/trash-store.test.js`（18）

| # | 用例 | 断言要点 |
|---|---|---|
| 1 | 移入回收站 | 源目录消失；payload 内含原 2 个文件；manifest 记录 sessionId/title/字节数/文件数 |
| 2 | 不安全 sessionId 拒绝 | 5 种恶意输入全部 `invalid-session-id`，且**源目录仍在** |
| 3 | 符号链接目录拒绝 | `symlink-refused`，链接目标不受影响 |
| 4 | 目录不存在 | `not-found`，不臆造 |
| 5 | 空回收站列表为空；多条按时间倒序 | 注入时钟控制 `deletedAt` |
| 6 | 恢复字节一致 + 条目移除 | 内容逐字节相等；条目目录消失；列表为空 |
| 7 | 原路径被占用时拒绝恢复 | `occupied`；**新目录内容未被覆盖**；回收站条目保留 |
| 8 | `keepItem` 留下审计记录 | state `restored`，不计入可恢复数、不计入损坏数 |
| 9 | 彻底删除 | 条目消失；返回释放字节数；重复删除 → `unknown-item` |
| 10 | 恶意 trashId 拒绝 | `../../etc` → `invalid-id` |
| 11 | **崩溃窗口自愈（payload 完整）** | manifest 改回 `moving` 后 `list()` 自动修复为 `trashed` 且补齐文件数，并落盘 |
| 12 | **崩溃窗口无 payload** | 报 `failed`；`restore()` 报 `payload-missing`；`brokenCount = 1` |
| 13 | **`restore()` 也能自愈同一窗口** | 与 `list()` 行为一致，恢复成功 |
| 14 | manifest 损坏 | 报 `corrupt`，不影响同目录其他条目的列举 |
| 15 | 统计与超期只报告不删除 | `expired()` 有结果但 `list()` 条数不变 |
| 16 | 超期标记 | 40 天后 `expired(30)` = 1，条目仍在，state 仍 `trashed` |
| 17 | 审计日志 NDJSON | trash/restore/purge/自定义记录齐全；每行含 ts/tsIso；最新在前 |
| 18 | 容器校验 | 正则与 `isInside` 的前缀邻居、自身、父子、`..` 行为 |

### 2.3 `tests/host/service.test.js`（20）

| # | 用例 | 断言要点 |
|---|---|---|
| 1 | status 能力位 | root / canDelete / hasWorkspaceRegistry / retentionDays |
| 2 | plan 对安静会话可删并给出大小 | `bytes` 等于实际内容长度；`via: "locate"` |
| 3 | plan 报告运行中会话的阻塞原因 | `blockers = ["session-live","session-active"]`，活动清单透传 |
| 4 | plan 对不安全 id / 不存在会话不抛错 | 分别 `invalid-session-id` / `not-found` |
| 5 | **无同意时拒绝运行中会话** | `session-active`；**回收站仍为空**（拒绝无副作用） |
| 6 | **无同意时拒绝驻留会话** | `session-live`；回收站仍为空 |
| 7 | **有同意时：停止 → 等待释放 → 移动** | 经 `workspaceRegistry.stopSessionActivity` 停止（记录 op=stop）；模拟客户端释放后成功；manifest 标题来自请求 |
| 8 | **始终不释放则拒绝** | `session-live`；回收站仍为空 |
| 9 | 成功后清理归档/置顶/工作区记账 | 记录 unarchive + unpin + detach；两个集合清空；工作区只剩另一会话；发出 `api-session/removed` |
| 10 | 记账本就干净时不产生多余调用 | 无任何 registry 调用 |
| 11 | **清理失败不把删除报成失败** | `ok: true`、`deleted: 1`、`cleanup: ["unarchive"]` |
| 12 | 批次逐项结果 | 1 成功 / 1 `session-active` / 1 `invalid-session-id`；仅 1 条 emit |
| 13 | **拒绝也写审计** | 两条 refused，原因码正确，含 ts/tsIso/pid |
| 14 | 恢复并广播 | `api-session/added` 发出（summary 来自列表构造器） |
| 15 | 恢复遇到占用 | 该项 `occupied`，条目保留 |
| 16 | **彻底删除需显式确认** | 未确认 → `not-acknowledged` 且**未删任何东西**；确认后成功并返回释放字节 |
| 17 | `["*"]` 哨兵同样需要确认 | 确认后清空 2 条 |
| 18 | 列表区分可恢复与损坏 | 损坏项进 `broken`，`brokenCount = 1` |
| 19 | 删除不存在的会话 | `not-found`，registry 无调用，回收站为空 |
| 20 | 无持久化服务时的降级 | `canDelete: false`；删除请求 `not-found` |

### 2.3b `tests/host/restore-revive.test.js`（6）

恢复把文件搬回来之后必须把会话**挂回运行时**（§5.6）。这 6 例都带自己的假 `sessionController`，
并用 `reviveTimeoutMs` 把超时压到毫秒级：

| # | 用例 | 断言要点 |
|---|---|---|
| 1 | **恢复会请求 resume** | `resolveAgent` 恰被以恢复的 `sessionId` 调用一次；结果行 `revived: true`、`reviveCode: "resumed"` |
| 2 | **resume 失败仍算恢复成功** | `ok: true` 加 `revived: false`、`reviveCode: "resume-failed"`、`reviveMessage` 带原因；文件已回位 |
| 3 | **resume 永不 settle 不拖住恢复** | `reviveTimeoutMs: 10`；恢复在预算内返回，`resume-failed`，且超时后的拒绝不会变成未处理拒绝 |
| 4 | **仍驻留的会话不重复 resume** | 注册表命中 → `resolveAgent` 调用 0 次；`reviveCode: "already-live"` |
| 5 | **宿主没有 resume 接口时降级** | `reviveCode: "no-resume-api"`；文件照常恢复、`ok: true` |
| 6 | **复活的成败写审计** | 一条 `op: "restore-revive"`，`outcome` 与原因码正确，含 `trashId`/`sessionId`/`actor` |

### 2.4 `tests/host/locate.test.js`（16）

| # | 用例 | 断言要点 |
|---|---|---|
| 1 | `dshHome` 优先级 | `DSH_HOME` 优先，否则 `~/.dsh` |
| 2 | 候选根去重且后端优先 | 首项为 `persistence.root` |
| 3 | 第 1 层 `locate()` | `via: "locate"`，路径等于 realpath 后的真实目录 |
| 4 | 第 2 层无 `locate` 时按公式 | `via: "root+encode"`；末两段分别等于 `encodeSegment(id)` 与 `projectKey(cwd)` |
| 5 | 第 3 层无 header 时扫描 | `via: "scan"` |
| 6 | 目录不存在 | `not-found` |
| 7 | 不安全 id 在任何文件访问前拒绝 | 5 种输入 → `invalid-session-id` |
| 8 | **恶意 `locate()` 越界答案被拒** | 返回 `unsafe-location`（专门的包含性失败码），绝不返回根外路径 |
| 8b | 根内但尚未落盘的会话 | `not-found`（与包含性失败区分开） |
| 9 | **符号链接目录不被接受** | 指向根外 → `unsafe-location`；指向根内 → `not-found`；两种都拒绝 |
| 10 | `stat()` 抛错可容忍 | 降级到扫描并成功 |
| 11 | `isResident` 语义 | 命中/未命中/无服务/服务抛错 → `true/false/false/false` |
| 12 | `waitForRelease` 无需等待即返回 | `true` |
| 13 | `waitForRelease` 超时 | `false`，且确实等待了 ≥ 阈值 |
| 14 | `waitForRelease` 观察到中途释放 | `true` |

### 2.5 `tests/host/routes.test.js`（20）

真实 HTTP 服务器 + 真实 `fetch`，验证路由层的可观测行为。

| # | 用例 | 断言要点 |
|---|---|---|
| 1–3 | status / 根路径 / list 的读取模型 | 200 与 `{ok,value}` 信封；`plan` 只读（回收站里不会冒出任何东西） |
| 4 | **删除 → 列出 → 恢复 全链路** | 目录真的从会话仓库消失、恢复后内容逐字节一致 |
| 5 | 彻底删除先 428 后 200 | 未确认时**什么都没删** |
| 6–7 | `maxBatch` 作用于 delete/restore/purge；`["*"]` 豁免 | 400 `batch-too-large`；哨兵仍然放行 |
| 8–11 | 空选择 / 非数组或嵌套载荷 / 畸形 JSON / 超大体积 | 400 `empty-selection`；非字符串被丢弃后只处理真实 id；413 `body-too-large`（且是**活连接上的**可解释拒绝） |
| 12–13 | `GET` 变更动作、未知动作、非法方法 | 405 / 404 |
| 14–16 | 跨站、跨源、同源 `Origin` | 403 / 403 / 200 |
| 17 | **非回环 authority 的信任判定** | `127.0.0.1` 与 `127.9.9.9` 放行；未声明的域名 403；`trustedHosts` 里的域名 200；受信主机仍受跨站闸门约束 |
| 18 | 运行中会话被拒绝且未移动 | 200 但 `deleted:0`、`session-active`，源目录仍在 |
| 19 | 审计日志接口 | 含 `trash:ok` 与 `delete:refused` |
| 20 | `enabled: false` | 每个动作 404 `disabled`，且什么都没搬 |

### 2.6 `tests/client/bundle.test.js`（38）

| # | 用例 | 断言要点 |
|---|---|---|
| 1 | **加载产物：id、require 集合、inject** | id = `dsh-session-trash`；require 恰为 3 个平台模块；`inject` 为 `[]` |
| 2 | 会话菜单两项的 id/order/locale | 500 与 600，locale = `sessionTrash`，组件是函数 |
| 3 | overlay / 更多菜单行 / keyed main 注册 | `session-trash.overlays`；`sidebar.panellist` 缺席；`sidebar.panellist.actions` id `session-trash.more`（order −20、无 priority）；main 的 `key` = `session-trash` |
| 4 | **所有注册共享同一 store 实例** | 两个声明 store 的注册项 `.create()` 返回同一对象 |
| 5 | **缺 layout 服务时破坏性入口仍在** | 菜单、会话 overlay 与「更多」菜单行仍注册；`main` 缺席（降级而非崩） |
| 6 | 大小与时间文案 | B/KB/MB；刚刚/分钟/小时/天 |
| 7 | 同意判定与活动扁平化 | `isDeletable` / `needsConsent` / `activityRows`（turn、job items） |
| 8 | 选择汇总含真实字节数 | `bytes` 求和；`canAdvance` 对全阻塞/空选择为 false |
| 9 | **删除载荷过滤** | 只含可删且选中项；含驻留项则 `stopActivity: true` |
| 10 | 响应信封 | `{ok,value}` / `{ok,code,message}` / 非 JSON → 带状态码的兜底消息 |
| 11 | **批量候选排除空白与子代理** | 只留普通会话；空快照 → `[]` |
| 12 | **删除主流程（单步）** | plan/root/标题落库；未选时主按钮禁用；对话框**没有 step**；单击即提交并关闭；撤销只针对成功项；载荷 `stopActivity: true` 且 `force: true` |
| 12b | **删除前释放视图** | 目标是当前打开的会话且存在幸存者 → 先 `openSession(幸存者)`；没有幸存者 → `clearMain()`；目标与当前会话无关时**不**触碰视图 |
| 13 | **彻底删除在未勾选前不发请求** | 无 fetch 调用；勾选后才发出并清空 purge 状态 |
| 14 | 宿主报错表现为可见错误而非抛异常 | `dialog.error` 为宿主消息，plans 为空 |
| 15 | **样式注入一次且归属正确** | 1 个 style 标签；`data-plugin` = 包名；CSS 含 `.dsh-trash-panel` 与 `--dsw-*` 令牌；二次物化不重复注入 |
| 16 | 无 document 时导入无副作用 | 不抛错，`apply` 可用 |
| 17 | **删除前释放视图** | 目标是当前打开的会话且有幸存者 → `openSession(幸存者)`；无幸存者 → `clearMain()`；目标与当前会话无关时**不**触碰视图 |
| 18 | **按钮文案是「删除」而不是「移入回收站」** | 中英文都断言；同时断言文案里不存在残留的「下一步」/ `dialog.step2` 键 |
| 19 | 渲染后的对话框只有一个破坏性动作 | 一致性按钮与强制删除变体的文案 |
| 20 | **列表里无文件的会话显示为「已删除」** | `isGone` 的三种判据；`goneCount` 与 `blockedCount` 的区分；中英文文案 |
| 21 | 强制删除与残留的提示条各说各的 | 强制删除的文案含「运行时」「列表」；残留的文案含「归档」与「重启」 |
| 22 | **批量列表排除已删除/已归档的行** | `batchVisiblePlans` 保留普通行与「仅被阻塞」的行，剔除 `archived` 与 `gone`（两种判据）；`isGone` 三种判据；空输入 → `[]` |
| 23 | **批量对话框不再列出已删除/已归档会话** | 宿主预检返回三者时，`plans` 与 `sessionIds` 只剩可删的那一个 |
| 24 | **单会话对话框仍显示被点名的残留行** | 批量规则不得吞掉单会话入口 |
| 25 | **对话框说明「删除当前会话会结束这段对话」** | `dialog.current`（中英文）与 `dialog.currentTag` |
| 26 | **恢复丢弃删除留下的 tombstone 实例并重开原页** | 删除时开着的会话留下的实例（`removed === true`）在恢复时被 `retireScope`/`drop` 掉；恢复结果包含它时 `uiWorkspace.openSession` 被调用 |
| 27 | **复活失败时提示条降级成警告并说明原因** | `revived === false` → `tone: "warning"`，文案含 `notice.restoreNotLive` 与原因 |
| 28 | **批量行按工作区分区** | `partitionPlans` 按 `cwd` 分组、尾部斜杠不另起分区、无工作区的行归入同一个分区、分组保持原顺序；`workspaceKey` / `workspaceName` |
| 29 | **分区可折叠** | `toggleCollapsed` 只影响那一个键；`groupSelection` 报出总数/已选数/是否全选（空分区不算全选） |
| 30 | **分区文案中英文都有** | `dialog.groupCount` / `groupSelected` / `expandAll` / `collapseAll` / `groupExpand` / `groupCollapse` 在 zh 与 en 都存在 |
| 31 | **分区真的渲染成可折叠的分区** | 用替身 React 渲染 `DeletePickStep`：两个分区、两个折叠按钮、`aria-expanded` 为真；点折叠后该分区的行不再渲染，展开后回来 |
| 32 | **同意标签说出真正适用的那一个理由** | `consentTag`：有工作 → `dialog.activity`；有 schedule 家族 → `dialog.scheduled`（带任务数）；安静 → `null`；状态未知 → `dialog.activityUnknown`；**仅被运行时持有 → `null`**（不再是一个标签） |
| 33 | **选择汇总按事实分开计数** | `liveWorkCount` / `scheduledSessionCount` / `scheduledDeliveryCount` / `unknownActivityCount` 各自独立；`consentCount` 数「要弹框」的三类（工作 + 未知 + 定时任务）；`forceCount` 只数「可能被打断」的两类 |
| 34 | **文案中英文都有，且不再编造不存在的原因** | `dialog.consentWork` / `consentScheduled` / `consentUnknown` / `dialog.scheduled` / `notice.scheduledGone` 在 zh 与 en 均存在；`dialog.consentResident` 与 `dialog.resident` **已删除**；旧单原因键 `dialog.consent` 已删除；`notice.forced` 不得出现「工作已停止」 |
| 35 | **渲染出的行标签就是真正适用的那一个** | 替身 React 渲染 `DeletePickStep`：忙的会话出「仍有进行中的工作」，有定时任务的会话出「N 个定时任务会投递到此会话」，被运行时持有的**不出任何标签**且三行都仍列出 |
| 35b | **有定时任务时按钮不改名** | 只带 schedule 家族的单会话：`consentCount` 1、`forceCount` 0、`needsForce` false；渲染出的说明含「定时任务」「不会自动恢复」，且**不含**「强制删除」 |
| 36 | **该问的才问，该释放的照样释放** | `needsConsent`：`resident` 不算、`running === true` 算、状态未知算、**`schedule` 家族算**；`needsForce`：schedule 家族不算；`needsRelease`：`resident` / 任意 activity / 未知全为真；`isQuickDelete`：仅被运行时持有的为 true、被定时任务指向的为 **false** |

### 2.6b `tools/render-partitions.mjs`（开发工具，不进 `npm test`）

插件的测试用替身 React 渲染（平台的 React 不在插件仓里）。这个工具借一台机器上碰巧存在的
React（`DSH_REACT_MODULES`，或 `~/.dsh/plugin-test-deps/*` 里任意一个装齐 react + react-dom 的仓）
用**真 React** 把批量列表渲染成静态 HTML：真实会话量（多个工作区、几十个会话）、插件自带的样式表、
折叠前后的两份输出。它验证的是渲染路径本身——hooks、事件处理、状态更新——而不只是纯函数。

```
node tools/render-partitions.mjs        # 写出 /tmp/partitions.html 与 /tmp/partitions-folded.html
```

### 2.6c `tools/render-consent-tags.mjs`（开发工具，不进 `npm test`）

这一次的缺陷是**措辞**的：聊完的会话仍被标成「仍有进行中的工作」。措辞的缺陷光靠断言看不出来——
所以这个工具把**真实宿主预检结果**（`/session-trash/plan` 的实际返回，或一份保存下来的响应）用真 React
渲染成静态 HTML：每一行带上它自己的原因标签，对话框说明区列出逐类分开的几行。肉眼看一眼就知道标签
说对了没有。

```
node tools/render-consent-tags.mjs /tmp/plan.json     # 渲染保存下来的预检响应
DSH_WEB_URL=http://127.0.0.1:59702 node tools/render-consent-tags.mjs   # 现取现渲染
```

输出 `/tmp/consent-tags.html`；控制台逐行打印每个会话的 `resident` / `activity` / 最终标签。

### 2.7 `tests/host/regressions.test.js`（17）

对抗性复核发现的每个缺陷都在这里有对应用例，且**每一条都能对修复前的实现失败**。

| 用例 | 复现的缺陷 |
|---|---|
| R1 | 跨设备路径：`cp→rename→rm(源)`，`rm` 部分失败时抛出 → 回滚删掉唯一完整副本。用真实的 `EXDEV` + 部分 `rm` 失败复现，断言提交后的副本仍在 |
| R1b | 提交点之前失败仍可安全回滚（源目录不受损） |
| R2 | 移动成功后 `inventory` 失败会把完成的删除变成 500，并让 `/list`、`/status` 永久 500（用 `chmod 000` 制造不可读子树） |
| R3 | 预建空 `payload` 让「`moving`+payload ⇒ 已完成」的推断失效 → 谎报删除成功。断言该窗口报 `failed` 且不进可恢复计数 |
| R4 | 被**拒绝**的 `restore` 会改写 manifest → 断言 manifest 字节与 mtime 完全不变 |
| R5 | `list()`/`stats()`（读）会写盘 → 断言文件字节不变 |
| R6 | 无 manifest 的孤儿既不可见也删不掉 → 断言报 `orphan`、`restore` 给 `no-manifest`、`purge` 能删掉 |
| R7 | `readLog` 实际「最旧在前」→ 断言跨日、日内都是最新在前，且小 limit 取到的是最新记录 |
| R8 | 批次里一个畸形 id 抛出并丢掉逐项结果 → 断言一项恢复成功、另一项 `invalid-trash-id` |
| R9 | `waitForReleaseMs` 无上限 → 断言夹取边界（并避免测试自身等待） |
| R10 | `restore`/`purge` 的拒绝不写审计 → 断言两类拒绝记录都在 |
| R11 | 恢复不还原工作区/归档/置顶记账 → 断言三处都还原 |
| R12 | `plan` 对每个 id 各读一次会话列表（O(n²)）→ 断言 25 个 id 只读 1 次 |
| R13 | 第 1 层定位「候选不存在」即返回 → 断言 header 的 cwd 与磁盘不一致时仍能通过扫描找到 |
| R14 | 畸形 trashId 直接进 `purge` → 断言 `invalid-id` |
| R15 | `expired` 标记与 `expiredCount` 可能用不同时钟 → 断言同源一致 |
| R16 | 符号链接源目录 → 断言 `symlink-refused` |
| R17 | **用户报告**：同意停止后，因视图仍持有会话而被拒绝 → 断言释放成功、删除完成、且用于释放的归档没有泄漏到记账里 |
| R18 | **用户报告**：删除正在对话的会话后侧栏留下一行打不开的「已归档」僵尸 → 断言 `force` 把会话从运行时拿下（`released: true`、`residue: false`）、归档 id 被移除、manifest 记 `forced`、审计有记录 |
| R19 | 释放用的归档在删除失败后必须回滚 → 断言归档集合恢复为空 |
| R20 | 未同意时的拒绝零副作用 → 断言既没停止工作也没写归档、更没移动文件 |
| R21 | **用户报告**：删除后残留行落进「未分组」 → 断言强制删除**不 detach**、工作区归属保留、会话已释放 |
| R22 | **用户报告**：残留行删不掉 → 断言**运行时拒绝释放**时强制删除**保持归档**（默认过滤器下唯一能隐藏一行的状态）、结果带 `released: false` 与 `residue: true` |
| R23 | 干净删除仍必须清除归档 id → 否则已删除的会话留在「显示已归档」里 |
| R24 | 恢复一个强制删除的会话 → 断言它留下的归档 id 被清掉，会话可见 |

### 2.8 `tests/integration/render.test.js`（3，可选层）

| # | 用例 | 断言要点 |
|---|---|---|
| 1 | React 可用性探测 | 不可用时整层 `SKIP`（不假装通过） |
| 2 | **全部注册项在真实 React 下渲染** | 5 个注册项 × 各自状态的组合（overlay 的空态/第一步/第二步含同意/单会话被阻塞/彻底删除弹窗/撤销提示；面板的加载/空/有数据）均不抛错 |
| 3 | **渲染结果承载真实内容** | 菜单行含 `menu.delete` 与 `data-danger="true"`；面板含标题 `Alpha`、格式化后的 `2 KB`、超期标记、损坏计数、删除时长、日志条目；空状态含引导文案；读取失败含 `role="alert"` |

本层依赖真实 React，而 React 由 DSH 运行时提供、不是本包的依赖，因此设计为**自动跳过**而不是失败。

**已用变异测试验证本层有效**：把 `Checkbox` 换成未定义组件后，第 2 项立刻失败并给出
`session-trash.overlays [step 1 (batch)] threw: ReferenceError: NotARealComponent is not defined`，
证明它不是空跑。

---

## 3. 需求到测试的追溯

| 验收标准（SPEC §5） | 覆盖用例 |
|---|---|
| AC-1 菜单项位置/样式一致 | 客户端 2 |
| AC-2 两次确认，单击无法完成 | 客户端 8、12 |
| AC-3 批量多选/搜索/全选 | 客户端 11、12、23 |
| AC-28 批量不列已删除/已归档会话，单会话仍显示残留行 | 客户端 22、23、24 |
| AC-4 删除后消失并进回收站 | 服务 9、12；回收站 1 |
| AC-5 恢复后原路径内容一致 | 回收站 6 |
| AC-6 占用时拒绝且条目保留 | 回收站 7；服务 15 |
| AC-7 彻底删除需显式确认 | 服务 16、17；客户端 13 |
| AC-8 运行中会话不被静默删除 | 服务 5、6、7、8 |
| AC-9 拒绝也写日志 | 服务 13 |
| AC-10 恶意 id 无法触达文件系统 | 编码 9、14；回收站 2、10；定位 7、8、8b、9、9b |
| AC-11 崩溃窗口自愈或明确报错 | 回收站 11、12、13 |
| AC-12 服务缺失时页面仍可启动 | 客户端 1、5 |
| AC-13 原有四项功能不受影响 | 客户端 2（只新增 entry）；§4 人工回归 |

---

## 4. 自动化测试无法覆盖、需要人工验证的项

| 项 | 步骤 | 期望 |
|---|---|---|
| 视觉一致性 | 打开会话「…」菜单，与置顶/重命名/分叉/归档并排比较 | 字号、图标尺寸、行高、hover 与 danger 配色一致 |
| 菜单顺序 | 同上 | 「删除会话」在归档之后；「批量删除会话…」在最后且上方有分隔线 |
| 深色/浅色主题 | 切换主题后查看对话框与回收站面板 | 跟随主题，无硬编码颜色残留 |
| 键盘可访问性 | Tab 遍历菜单、对话框、回收站面板 | 焦点可见（focus ring），图标按钮有可读名称 |
| 对话框不被菜单卸载 | 从会话菜单打开删除对话框后移动鼠标 | 对话框保持，不随菜单消失 |
| 撤销提示 | 删除单个会话后点击「撤销」 | 会话回到原位置，侧栏重新出现该行 |
| 侧栏回收站入口 | 点击侧栏「回收站」 | 主区域打开回收站面板，标题与计数正确 |
| 原功能回归 | 依次执行置顶、重命名、分叉、归档/取消归档 | 行为与安装前一致 |
| 归档后的会话删除 | 先把会话归档，再删除 | 成功后归档集合中不再有该 id（可通过 `workspace.json` 核对） |
| 大回收站 | 放入 50+ 条目后打开面板 | 列表滚动流畅，刷新在合理时间内返回 |
| 占用冲突 | 删除会话 → 重建同名会话（同工作区重新产生） → 尝试恢复 | 提示原路径已占用，回收站条目仍在 |

---

## 5. 如何运行

```bash
cd "~/.dsh/plugins/dsh-session-trash"

# 全部（137 必测 + 3 可选项）。串行执行是刻意选择：默认的并行文件执行在
# 六文件规模下会间歇性不退出（子集与串行都稳定），串行总耗时仍约 2 秒。
node --test --test-concurrency=1 "tests/host/*.test.js" "tests/client/*.test.js" "tests/integration/*.test.js"

# 真实 React 渲染检查（可选，需在别处装 react@18.3.1 + react-dom@18.3.1）
mkdir -p /tmp/react-check && cd /tmp/react-check && npm install react@18.3.1 react-dom@18.3.1
cd "~/.dsh/plugins/dsh-session-trash"
NODE_PATH=/tmp/react-check/node_modules node --test "tests/integration/*.test.js"

# 分层
node --test --test-concurrency=1 "tests/host/*.test.js"
node --test --test-concurrency=1 "tests/client/*.test.js"

# 单文件 / 单用例
node --test --test-concurrency=1 tests/host/trash-store.test.js
node --test --test-concurrency=1 --test-name-pattern="崩溃" "tests/host/*.test.js"
```

依赖：仅 Node.js `>= 22.19`（使用内置 `node:test`）。**无需 npm install**，无第三方测试框架。

### 5.1 实测结果

```
$ node --test --test-concurrency=1 "tests/host/*.test.js" "tests/client/*.test.js" "tests/integration/*.test.js"
# tests 171
# pass 167
# fail 0
# skipped 4          (真实 React 层；未安装 React 时跳过)
# duration_ms ~4400

$ NODE_PATH=/tmp/react-check/node_modules node --test --test-concurrency=1 "tests/host/*.test.js" "tests/client/*.test.js" "tests/integration/*.test.js"
# tests 171
# pass 171
# fail 0
# skipped 0
# duration_ms ~4400
```

`/tmp/reactprobe` 是自备的 React 探针环境（`react` + `react-dom`，本包不依赖它们）；该次运行把 `tests/integration/render.test.js`
的真实渲染层也跑了，包含 §5.9 新增的那条断言——**把 `disabled: !plan.deletable` 改回客户端会让它失败**（已用临时改动实测：`not ok 3 … no candidate checkbox may be disabled — the user decides`，随后已还原）。

### 5.2 测试自身的失败记录（保留以备查）

首轮运行 30 个宿主用例时 5 个失败，其中 **2 个是测试期望写错、1 个是真实代码缺陷、2 个暴露了设计改进点**：

| 失败 | 分类 | 处理 |
|---|---|---|
| `encodeSegment("../etc/passwd")` 期望值 | 测试写错 | `.` 是安全码元，正确结果是 `..~002Fetc~002Fpasswd`；**代码与上游一致**，改为正确期望，并新增「任意恶意 id 都不含分隔符」的用例把真正的安全性钉住 |
| 恢复路径与 `sessionDir` 不等 | 测试写错 | manifest 故意记录 realpath；macOS 上 `/var` 是 `/private/var` 的链接，改为比较 realpath |
| `restore(keepItem)` 后列表非空 | **设计改进** | `list()` 把无 payload 的 `restored` 记录误报为 `failed`。修复：`restored` 记录在 payload 检查之前单独处理，`stats.brokenCount` 只统计 `failed`/`corrupt` |
| 无 payload 时 `restore` 返回 `not-restorable` | **设计改进** | `restore()` 未做 `list()` 那样的自愈，且错误码不够精确。修复：`restore()` 加入同样的 `moving`+payload 自愈，缺失 payload 时返回更精确的 `payload-missing`；新增自愈用例 |
| 审计日志 op 列表长度 | 测试写错 | 漏算了第二次 trash；同时把「最新在前」的断言从 `at(-1)` 改为 `[0]` |

这次失败是测试起到作用的具体证据：一个真实缺陷（`restore` 不自愈）和一个真实误报（`restored` 被当损坏）都是被测试逼出来的，而不是被评审看出来的。

### 5.3 测试脚手架的两次真实修正

**keep-alive 让测试进程不退出。** `t.after(() => server.close(cb))` 会等待所有打开的连接结束，而
`fetch` 客户端保持长连接，于是进程挂住。修正为 `closeAllConnections()` 后再 `close()`。
（这也是最初「并行运行间歇性挂住」的原因之一。）

**一个测试自己等了 30 秒。** `waitForReleaseMs` 的回归用例直接传了 `1e9`，夹取后的上限是 30 秒，
于是整套测试要跑过 60 秒而被判定为「挂住」。修正为直接断言纯函数 `clampReleaseWait` 的边界，
不制造真实等待。

> 两处都是测试自身的问题，不是插件行为差异。修正后：串行执行在完整范围（含真实 React）下
> **连续 6 次全部 140 / 140**。

### 5.6 一次由用户实测发现、测试没覆盖到的缺陷

用户在真实应用里点「停止工作并删除」时报告：删不掉。诊断（用 `/session-trash/plan` 对当时正在运行
的会话取证）显示 `blockers: ["session-live","session-active"]`——宿主**先停掉了用户的工作**，再因为
运行时不肯释放该会话而拒绝删除。

根因是一句注释描述了一个从未实现的行为：代码写着「客户端会先导航离开，从而释放引用」，但 `confirmDelete`
里根本没有那段逻辑。测试没抓到，是因为回归用例里的假上下文永远「释放成功」或永远「驻留」，从没有把
**「同意之后必须做成」**当作契约来断言。

修复后新增 R17–R20 覆盖这条契约，并明确了一条更一般的教训：**一个由用户明确同意的破坏性操作，
不能因为内部实现细节而失败。** 释放内部资源是实现的职责，不是用户的操作要求。

### 5.7 一次纯文案的返工（以及为什么给它加了测试）

同一个需求被提了两次：第一次理解为「去掉第二步」，改成了单步对话框，但主按钮仍叫「移入回收站」。
用户要的是按钮就叫**删除**——弹窗的职责是确认删除，点击即删除并进入回收站。

这类「文案即契约」的要求很容易在后续重构中漂移，因此为它加了断言（用例 18、19）：中英文都必须把
主按钮命名为「删除」/「Delete」，同时断言字典里不存在残留的「下一步」与 `dialog.step2` 键。
变异测试确认：把文案改回「移入回收站」会让这两条用例失败。

### 5.5 回归测试的有效性用变异测试验证过

「有一条测试」和「有一条会失败的测试」是两件事。对抗性复核之后，对**每一个**关键修复都做了变异测试：
把修复回退掉，确认对应回归用例**确实失败**。

| 回退的修复 | 结果 |
|---|---|
| F1 客户端在 `apply` 顶层读 `ctx.locale` | 客户端测试失败：`cannot get property "locale" without inject` |
| F2 跨设备路径在 `rm(源)` 失败时抛出 | R1 失败 |
| F3 重新预建空 `payload` | **R3 失败**（真实 SIGKILL 在 `rename` 处，父进程检查磁盘状态） |
| F4 移动后用会抛出的 `inventory` | R2 失败 |
| F5 恢复批次去掉逐项 try/catch | R8 失败 |
| F6 去掉 `waitForReleaseMs` 夹取 | R9 失败 |
| F7 `plan` 每个 id 各读一次会话列表 | R12 失败 |
| F8 无 manifest 的条目改为 `continue` | R6 失败 |
| F9 `readLog` 改回整体 `reverse()` | R7 失败 |
| F11 被拒绝的 `restore` 重新写 manifest | R4 失败 |
| F12 第 1 层定位候选不存在即返回 | R13 失败 |
| F13 恢复 `session-` 前缀要求 | 两处「非常规但安全 id」用例失败 |
| F15 去掉 `#restoreAccounting` | R11 失败 |
| F20 去掉 `force` 回退（用户报告的缺陷） | R18、R19 失败 |
| F20 去掉强制删除时的运行时释放（活会话注册表的 `detach()`） | R18 失败（`released` 变回 `false`）、R21 失败 |
| F20 客户端不再关闭自己开的会话 scope | 客户端「客户端关闭它自己打开的会话 scope」用例失败 |
| F20 去掉客户端的视图释放 | 客户端「删除前释放视图」用例失败 |
| F20 客户端不再发送 `force` | 客户端两条删除流程用例失败 |
| F21 按钮文案改回「移入回收站」 | 客户端文案用例失败 |
| F22 重新加上 detach 步骤 | R11、R21 失败 |
| F22 强制删除后也 unarchive（即使运行时仍持有） | R11、R17、R22、R23、R24 失败 |
| F22 恢复时不再权威地写归档状态 | R24 失败 |

第一版的 R3 **没有通过**这项检查——它模拟的是修复**之后**的磁盘状态，因此对修复前后的实现都会通过。
这正是变异测试的价值所在：它把一个「看起来在测这件事」的用例，变成真正在测这件事的用例。
R3 现在在一个子进程里用 SIGKILL 真的死在 `rename` 处，再由父进程检查磁盘，因此它能区分两种设计。

### 5.4 客户端契约测试的一次真实修正

`vm.createContext` 会在**另一个 realm** 创建对象，而 `deepStrictEqual` 比较原型，导致跨 realm 数组全部不等。修正为 `vm.runInThisContext`（并在测试内临时安装/还原 `window`、`document`）。另有一处：`document` stub 在 factory 执行前就被还原了，而 bundle 的样式注入发生在 factory 体内——测试改为在整个 factory 调用期间保持 stub 有效。两者都是测试脚手架的缺陷，不是插件缺陷。

---

## 6. 未覆盖与残余风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| 上游编码函数变化 | `encodeSegment` / `projectKey` 是复刻实现 | 仅作为第 2/3 层回退；首选后端自己的 `locate()`；有真实目录名回归测试 |
| 上游 `locate()` / `root` 改名 | 非契约方法 | 三层回退，任一层可用即可；有降级测试 |
| 上游 `locate()` 返回根外路径 | 包含性失败 | 专门的 `unsafe-location` 拒绝码（fail-closed），有测试 |
| 跨设备回收站 | EXDEV 回退走复制路径 | 已用 `payload.tmp` + rename 保证不出现部分 payload；该路径本身未在真实跨设备挂载上执行过（残余风险） |
| 会话目录中存在子目录 | `inventory` 递归处理；`moveDir` 整体搬移 | 已支持；真实 DSH 会话目录当前是平铺的 |
| 与未来 DSH 版本的槽位名变化 | 槽位名是公开约定 | 注册失败只会让界面缺席，不影响页面启动（`inject` 为空） |
| 回收站所在磁盘写满 | 移动会失败 | 失败回滚空条目目录并向上抛错；源目录不受损 |
| APFS/SSD 上的「安全擦除」 | 不做承诺 | 明确列为范围外，避免虚假合规保证 |

### 5.8 第二次用户实测缺陷：删除成功了，界面却留下删不掉的残留行

用户在「工作」项目里删掉一个会话后报告：**它出现在「未分组」里，而且再也删不掉**（显示「不可删除」）。

用 `/session-trash/plan` 对那条记录取证，得到决定性的一行：

```
resident: True, exists: False, blockers: ['not-found', 'session-live']
```

文件确实已经在回收站（manifest 里 `forced: true`），但**会话对象还活着**。顺着这条线读代码，找到了三个事实：

1. `dsh-session-query` 的 `listSessions` 把 live 会话也算进列表（`records.set(session.id, {live:true})`）——所以文件没了，行还在。
2. **全产品没有任何 dispose-by-id 接口**：`SessionStore` 的成员只有
   `create/prepare/enter/detachEntered/announce/emitDisposed/flush/get/list/fork`，
   而 `detachEntered` 需要内部 entry 对象；客户端能调的 Remote 会话 API 也只有
   `list/search/create/rename/fork/prompt/cancel/…`。插件无法让运行时放开一个会话。
3. 侧栏「未分组」的定义是「列表里有、但没有任何工作区认领的会话」——而我的清理步骤恰好做了 `detach`。

所以这是我的两个错误叠加：**detach 把残留行推进了「未分组」**，而 **unarchive 让它保持可见**。

修复（R21–R24）：绝不 detach；强制删除保持归档（默认过滤器下唯一能隐藏一行的状态）；干净删除仍清除归档；
列表里无文件的会话在 UI 上显示为「已删除」而不是「不可删除」，并且不计入「无法删除」的计数。

**教训：** 「删除成功」不等于「界面上没有痕迹」。当一个操作的结果要被另一个子系统（这里是宿主会话列表）反映时，
必须顺着那个子系统的**读取路径**去验证，而不是只验证自己写下的状态。我之前的回归测试全部在验证「我的状态对不对」，
没有一条在验证「界面会不会留下东西」。

### 5.9 第三次用户实测缺陷：「能不能删」被插件替用户决定了

用户删掉整个工作区后，里面的会话落进「未分组」，于是想批量删掉这些残留行，看到的却是：**勾不上**（灰掉的复选框），
原话是「所有的删除应该由我决定能不能删，而不是直接把这个决定给定死」。

用 `/session-trash/plan` 对截图里的四行取证，得到两组截然不同的答案：

```
# 两行「已归档 / 已删除」（灰掉、勾不上的那两行）
deletable: false, exists: false, resident: true, archived: true,
blockers: ['not-found', 'session-live'], code: 'not-found'
# 两行「仍有进行中的工作」（有文件、可勾选）
deletable: true, exists: true, resident: true, blockers: ['session-live']
```

由此定位到两个把决定权拿走的点：

1. **客户端** `disabled: !deletable`（`lib/client.js` 的复选框）与 `全选` 的 `plans.filter(isDeletable)`：
   `deletable` 只等于「宿主能在磁盘上定位到目录」，于是「磁盘上没有文件」这一事实被渲染成了「你不能选」。
2. **宿主** `#deleteOne` 在 `!located.ok` 时**直接拒绝**（`not-found`）：用户想删的行没有任何出口，重启前只能干看着。

修复（FR-2.9 + 新增 `#clearFileless`）：

| 层 | 变化 |
|---|---|
| UI | 复选框不再有 `disabled`；`全选` = 当前搜索结果；主按钮的禁用条件只剩「一个都没选」 |
| 提交 | `buildDeletePayload` 发送**全部**选中项，不再在客户端按 `deletable` 过滤 |
| 宿主 | `not-found` 不再拒绝：**清出列表** —— 停止工作（需同意）→ 归档隐藏（驻留时）→ `emit "api-session/removed"` → 审计 `delete:cleared`，返回 `{ok:true, cleaned:true, trashId:null}` |
| 文案 | 提示条对 cleared 行说「只从列表里移除了」，不说「已移入回收站」；`撤销` 只挂到真正进回收站的条目上 |
| 仍然拒绝 | `unsafe-location` / `invalid-session-id`（无法安全确认的路径）与未经同意的 `session-active` / `session-live`；拒绝也带 `code`/`message` 回到界面，而不是灰掉控件 |
| 回归护栏 | `tests/integration/render.test.js` 在**真实 React** 下渲染「含一行无文件残留」的批量选择框，断言候选行数 = 复选框数、且没有任何 `<input disabled>`；把 `disabled: !plan.deletable` 改回去会让它失败（已实测） |

**教训：** 门禁要放在**能解释原因的那一层**。用 `disabled` 表达「不能删」，用户看到的是一个没有理由的死按钮；
正确的做法是让用户选，然后在结果里逐项说明。安全边界（不能删没法确认的路径、不能偷偷停别人的工作）依然保留，
但它们以**带原因的结果**出现，而不是以**被禁用的控件**出现。

### 5.10 第四次用户实测缺陷：修好门禁后，勾选根本不生效

修完 §5.9 重启 DSH，用户回来说：**批量删除依然无法勾选**，并附了新图——五行会话的复选框全部**没有灰显**（说明门禁确实生效了），
但「已选择 0 个」，点哪一行都没反应。

先排除掉我认为最可能的两件事：

1. **不是宿主半没更新**。重启后 `/session-trash/plan` 对那批会话返回的 `deletable` 与重启前一致，且客户端半已被重新打包。
2. **不是 Checkbox 组件的用法不对**。从 `app.asar` 里取出 `dsh-client-ui-primitives` 的真实实现：
   `function Checkbox({ checked, onChange, label, disabled = false, title, className })`，
   渲染成 `<label><input type="checkbox" checked disabled onChange={(e) => onChange(e.target.checked)} /><span>{label}</span></label>`——
   `checked` / `onChange` / `label` 都是真 prop，点 label 也会切换。

真正的死因在插件自己的代码里，而且只有一个词：

```js
// lib/client.js 的 DeletePickStep，三处都调用了一个不存在的东西
const toggle = (sessionId) => {
  const next = new Set(selected);
  ...
  patchDialog({ selectedIds: [...next] });   // ← 这个 patchDialog 是未声明的裸函数
};
```

`patchDialog` 这个名字在整个模块里**只有 store action 上的属性**（`patchDialog: (draft, patch) => …`），
组件里从来没有 import 或定义过同名函数。于是**每一次点击都抛出 `ReferenceError: patchDialog is not defined`**：
`全选`、`取消选择`、勾选行，无一例外。用户看到的就是「点了没反应、计数永远是 0」。

这也解释了为什么 §5.9 的取证会指向门禁：门禁**确实**是问题（那两行确实选不了），但另外两行「有文件」的行当时也点不动——
只是当时对话框里刚好只有那两行能被看见，于是两种故障被混成了同一种。

修复：三处改为 `storeInstance.actions.patchDialog({...})`（`lib/client.js:698`、`:727`、`:731`），与文件里其他调用点风格一致；
宿主半本次没有改动。

回归护栏（这一层是**唯一**能抓住它的层）：

| 护栏 | 做法 |
|---|---|
| `render.test.js` 渲染层 | 让 Checkbox/Button 的桩记录自身 props，测试代**模拟真实点击**调用它们：`onChange(true)` 必须让 `dialog.selectedIds` 变成 `["a"]`；`全选` ⇒ `["a","c"]`；`取消选择` ⇒ `[]`；点主按钮后断言真的 POST 到 `/session-trash/delete` 且 body 是用户选中的那几项 |
| 实测有效性 | 把 698 行改回裸 `patchDialog(` → `not ok 4 … name: 'ReferenceError'`（`# pass 3 # fail 1`），随后已还原 |
| 全模块扫描 | 用脚本枚举模块里所有**裸函数调用**（`(?<![\w.$])\w+\s*\(`）并与已定义名比对，确认 `patchDialog` 是唯一的悬空调用 |

**教训：** 客户端缺陷必须用**会抛异常的测试**验证，而不是用「渲染不报错」。SSR 只在渲染期执行代码，
点击处理器一次都没被调用过，于是这个从 1.0 就存在的 `ReferenceError` 顺利通过了全部三层测试、也顺利通过了手动验收。
下一步的方向是给 `lib/client.js` 加一条最小静态检查（未声明的裸调用即失败），让这一类错误在测试里就暴露，而不是在用户手里。

---

### 5.11 一轮系统性复核：批次会整段丢失、护栏长成死胡同

这一轮不是「用户报了一个 bug 就修一个」，而是让用户（m00844）要求的一次全量复核：逐条找缺陷、归因、简化、优化。
下面 5 条全部**先复现、再改**，每条都留了会失败的测试（不改代码就红）。

| # | 严重度 | 缺陷 | 触发条件 | 影响 | 复现 |
|---|---|---|---|---|---|
| 1 | 高 | `deleteSessions` 的循环没有 try/catch | 存储层抛错（`lstat` 非 ENOENT 错误、`moveDir` 抛出、`fs.rm` 抛出） | 整个批次 reject → 路由 500 → **前面已经进回收站的会话连同 `trashId` 一起丢失**，「撤销」再也拿不回来 | `tests/host/service.test.js`「one session throwing mid-batch does not discard the verdicts already reached」 |
| 2 | 高 | `plan`/`delete` 共用 `maxBatch`，客户端不切批 | 候选会话数 > `maxBatch`（默认 100） | 预检 400 `batch-too-large` → 对话框空着、只有一行错误，用户**没有任何办法**删除 | `tests/host/routes.test.js`「plan accepts a longer list than one mutation batch」（`maxBatch: 1`） |
| 3 | 中 | 恢复时「清空条目目录」失败被判成恢复失败 | `<root>/items` 不可写（权限/文件系统错误） | payload 已经 rename 回原位，但界面说失败：用户以为丢了；`#restoreAccounting` 被跳过（不回到工作区）；回收站留着点不动的条目 | `tests/host/trash-store.test.js`「a restore that cannot tidy the emptied bin item still reports the session as restored」（`chmod 0500 items`） |
| 4 | 低 | `purge` 的 `["*"]` 在进队列**之前**展开 | 清空回收站与另一次删除并发 | 「列出 → 删除」之间新进回收站的条目漏掉，而调用方以为清空成功 | 代码审查（`service.js` 的 `purgeSessions`：哨兵判定移到 `#queue.run` 内部） |
| 5 | 中 | 失败原因只报前 3 条、预检要两次往返 | 一批里有 4 种以上不同原因 / 每次打开对话框 | 用户看到的原因不全；对话框首屏多一次往返 | `describeFailures` 改为 5 条；`plan` 返回体携带 `root`/`maxBatch`（见 `docs/ARCHITECTURE.md` 6） |

同轮的两处「简化」（不是修 bug，是减少步骤）：

| 场景 | 简化前 | 简化后 | 少在哪 |
|---|---|---|---|
| 删除一个安静的会话 | 点菜单 → 等预检 → 读对话框 → 再点「删除」（2 次点击 + 1 次阅读） | 点菜单 → 预检通过直接删（1 次点击，结果用可撤销 Toast 报告） | 少一个对话框、少一次点击；需要同意的会话（运行中/宿主仍持有）仍然弹对话框 |
| 打开批量对话框 | `POST /plan` + `GET /status` 两次往返才能画首屏 | `POST /plan` 一次往返（返回体带 `root`/`maxBatch`） | 少一次往返；旧宿主半没有这两项时退化为一次 `GET /status` |

**教训（这条比上面 5 条都重要）：** 护栏（`maxBatch`）本来是防滥用，却成了用户体验的上限——用户越是想一次清理干净，
越会撞上「无法操作」。护栏应该限制**一个请求的代价**，而不是限制**用户能选多少**：客户端负责把用户的意图切给护栏能接受的形状。
第二，**批次里的失败必须逐项成文**：只要有一个 id 让整个 Promise reject，前面所有成功的动作就失去了凭据（`trashId`），
这比失败本身更危险。

### 5.12 第五次用户实测缺陷：恢复之后，文件回来了但没有活过来

用户删除「数据库迁移方案评审」后又手动恢复，接着在里面发消息——气泡留着，没有任何回应，也不报错。

取证全是只读的：回收站日志显示 `trash … forced=true` 之后 39 秒 `restore … ok`；而该会话目录当天
**零写入**（日志末行停在前一天 22:17 的 `model/selection`），同工作区其它会话在同一时段正常落盘；
`lsof` 显示它的 `session.lock` 没有任何进程持有，而同时其它 13 个活会话的锁都在宿主 PID 上。

三个层面叠在一起，所以过去的测试一条都没抓到：

1. **服务层**：强制删除会主动把会话从运行时拿下（`detach()`），恢复却只搬文件、还原记账、通知客户端。
   文件回来了、活体没有。假上下文里从来没有「恢复完还得能对话」这条契约。
2. **宿主解析**：活的会话只能由 `resolve → resume` 建出来，而恢复路径里没人发起它。这是 DSH 的行为，
   不是插件的 bug——但插件不能指望它自己发生。
3. **客户端**：`handleRemoved()` 只给旧实例打 `removed = true`（不销毁），`api-session/added` 也不清
   这个标记，而 `prompt()` 不看它；失败又只在 `{ok: false}` 时显示错误条——用户看到的就是「发出去了，
   什么都没发生」。

修法与三条设计决定见 `docs/ARCHITECTURE.md` §5.6；回归测试见 §2.3b（6 例）与 §2.6 的第 26、27 条。

**教训**：恢复的验收标准不能止于「文件字节一致」。**用户对恢复的期望是「能接着聊」**——把「文件回位」
当成恢复完成的定义，就把一个会静默失败的中间态留在了用户面前。另外，任何「失败也要如实说出来」的
路径都要检查**客户端有没有把它显示出来**：插件这边报了 `revived: false`，客户端不显示就等于没说。

### 5.13 第六次用户实测缺陷：聊完的会话仍然标着「仍有进行中的工作」

用户问：「这个判断的逻辑是什么？为什么有的会话我已经对话完毕了，还显示这个。」截图里那条
「【BUG修复】删除会话插件」带着 **当前会话** + **仍有进行中的工作** 两个标签，按钮变成「强制删除」。

对本机 44 个会话一次性预检（`POST /session-trash/plan`）后取证：14 个会话被标记，其中 **12 个是
`resident=true, running=false, activity=[]`**——它们什么都没在做，唯一的「原因」是宿主进程里还留着这个
会话（用户打开过就进活会话注册表，直到重启或删除）。真正在跑的只有 2 个。

这件事被用户纠正了**两次**，两次都指向同一个毛病：把「安不安全」和「该不该打扰用户」合成一个布尔。

**第一轮（只改文案）**：行内标签按真实原因四选一（`consentTag`）、对话框说明逐类分开
（`summarizeSelection` 的分项计数），`needsConsent` 保持不动。用户随即否掉了前提：「我需要的是真正在
运行中的会话能删除需要确认，其他的都不需要，都可以直接删除的。」

**第二轮（改门槛）**：`needsConsent` 收到「真的在跑」，`stopActivity`/`force` 改用新的 `needsRelease`
（不弹框也照发，否则宿主会以 `session-live` 拒绝），代价（定时任务会随会话消失）移到删除结果的提示条。
用户又补了一句：「有这种情况的（定时任务指向它），还是需要提示的。」

**第三轮（定稿）**：三个判定各管一件事——

| 问题 | 判定 | 依据 |
|---|---|---|
| 弹不弹框 | `needsConsent` | `running` / 非 `schedule` 的 activity 家族 / `activityKnown === false` / 有 `schedule` 家族 |
| 按钮改不改名 | `needsForce` | 前三条，去掉 `schedule`（没有东西要停，只是有东西会丢） |
| 要不要通知宿主释放 | `needsRelease` | `resident` / 任意 activity / 状态未知 |

设计决定见 `docs/ARCHITECTURE.md` §7.5.2；回归测试见 §2.6 的第 32–36 条与 35b。

**教训**：**「安不安全」和「该不该打扰用户」不是一个布尔能同时回答的**。第一轮把话说对了，但用户受不了
的是「被问一件他不在意的事」——问题在触发条件，不在措辞；第二轮把门槛放开，却又把定时任务会消失这件事
藏了起来。每放开一类「不问」，都必须找到另一个地方把它的代价说出来；每保留一类「要问」，又必须让它的
按钮和文案不夸大事实。
