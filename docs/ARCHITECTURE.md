# 会话删除插件 —— 架构设计与技术方案

> 配套文档：[功能规格说明书](SPEC.md) · [测试计划](TEST-PLAN.md) · [用户指南](../README.md)

本文档说明「为什么这样实现」，重点是可验证的事实与取舍，而不是泛泛的分层图。

---

## 1. 技术选型的出发点：为什么必须是双面插件

DSH 的插件是 Cordis 生态里的 npm 包，安装在 profile 目录下：

```
~/.dsh/profiles/<profile>/
├── package.json          # dsh.profile.bundles 决定启用哪些 bundle
├── cordis.yml            # 装配后的完整配置（自动生成）
├── cordis.patch.yml      # 用户补丁层，优先级最高
└── node_modules/         # 已安装插件
```

一个插件包可以同时提供两个半边：

| 半边 | 入口 | 运行位置 |
|---|---|---|
| 宿主端 | `exports["."]` → `lib/index.js` | DSH 宿主进程（Node） |
| 浏览器端 | `exports["./client"]` → `lib/client.js` | Web GUI 页面，由 DSH 客户端模块系统按需加载 |

`package.json` 的 `dsh` 字段声明两者：

```json
"dsh": {
  "manifestVersion": 1,
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web" }
}
```

### 1.1 客户端服务访问的硬规则（最容易让整页崩掉的地方）

Cordis 对**服务属性访问**有门禁：只有在读取者 fiber 的 inject 表里声明过的服务，才能用
`ctx.<name>` 读取；否则抛 `cannot get property "<name>" without inject`。而 DSH 启动后会审计每个
entry，任何 entry 的 fiber 不是 ACTIVE 就让整页失败：

```
web boot: N entries did not activate <id>: failed
```

**这两条组合起来是一个陷阱。** 本插件最初的写法是「`exports.inject = []` + 在 `apply` 顶层用
`ctx.locale.register(...)`」，意图是「不硬声明服务就不会卡住启动」。这在 Cordis 4.0.4 上**是错的**：
`ctx.locale` 直接抛错 → fiber FAILED → 整页显示 "Failed to load plugins"。

已用真实 Cordis 4.0.4 实测确认：

| 写法 | 结果 |
|---|---|
| `inject = []`，`ctx.locale` | **抛错** `cannot get property "locale" without inject` |
| `inject = ["locale"]`，`ctx.locale` | 通过 |
| `inject = []`，`ctx.inject(["locale"], s => s.locale)` | 通过 ← **本插件采用** |
| `inject = []`，`ctx.get("locale")` | 通过（`get` 不受门禁） |

因此规则是：

| 位置 | 含义 | 本插件取值 |
|---|---|---|
| `package.json` → `dsh.client.inject` | **模块到达顺序**：这些包的浏览器 bundle 必须先注册好 | 省略（不依赖任何动态包） |
| `lib/client.js` → `exports.inject` | **Cordis 服务名**：entry 的 fiber 依赖 | `[]`（空数组） |
| `apply` 内部 | 用 `ctx.inject([...], scope => …)` 拿到服务，并且**只用 `scope.<name>`** | `["slots","locale"]` 与 `["slots","locale","layout"]` |
| 任意位置 | 跨作用域查询用 `ctx.get(name)`（不受门禁） | 用于 `sessions` / `layout` 的惰性查询 |

于是 entry 立即进入 ACTIVE，启动审计必然通过；服务缺失时只是对应界面降级缺席。这条纪律由测试强制：
客户端测试的假上下文是一个 **Proxy**，任何未在 `deps` 里声明的服务属性访问都会抛
`cannot get property "..." without inject`——把这条规则变成了会失败的断言。

### 1.2 为什么客户端 bundle 是手写的

`lib/client.js` 不是构建产物，而是**源码**，采用 DSH 的懒 CJS 方言：

```js
window.__ModuleLoader__.load({
  id: "dsh-session-trash",
  factory: (require) => {
    var module = { exports: {} };
    let React = require("react");
    // ...
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
```

取舍：

| 方案 | 优点 | 缺点 |
|---|---|---|
| tsdown + 自定义打包（生态常见做法） | 可写 JSX/TS，有类型 | 需要构建链、产物与源码可能不同步；安装要联网装 devDeps |
| **手写懒 CJS（本插件）** | 零构建、零依赖、可直接审阅、安装即用 | 只能用 `React.createElement`，代码略啰嗦 |

`require` 只能解析 DSH 平台**冻结模块表**中的 9 个 specifier（`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`）。本插件只用到其中 3 个，并且有测试断言「不得 require 平台表以外的模块」。

---

## 2. 后端能力现状（为什么删除要自己实现）

从 `app.asar` 提取全部 327 个 `@deepseek-ai/*` 包后核对：

### 2.1 持久化接缝没有 delete

`dsh-session-persistence` 暴露的服务方法只有：

```text
ctx.sessionPersistence.create(header)     // 建立并取得写句柄
ctx.sessionPersistence.open(id, 'read'|'write')
ctx.sessionPersistence.stat(id)           // header + revision（不读日志体）
ctx.sessionPersistence.list()             // 每个可见会话一个快照
ctx.sessionPersistence.flush()            // 全后端持久化屏障
```

没有 delete / remove / forget / purge / evict。

### 2.2 会话控制器没有 delete

客户端 Remote 命名空间 `session` 提供 `create` / `fork` / `rename` / `list` / `projections` / `history`，同样没有 delete。

### 2.3 归档是唯一既有机制

`ctx.workspaceRegistry.archiveSession(id)` 把 id 写进 `~/.dsh/storages/workspace.json` 的 `global.archivedSessionIds`，**文件原封不动**。所以归档不是删除的替代品。

### 2.4 磁盘布局

`@deepseek-ai/dsh-session-persistence-jsonl` 的实际布局：

```
<root>/                                  # ~/.dsh/sessions
  /--Users-example-Desktop-work-~7814~7A76--/     # projectKey(cwd)
    session-155e353b-8902-49bb-824a-bb64c1936631/          # encodeSegment(id)
      session.v4.jsonl.zstd                                # 当前世代日志
      session.lock
```

两个纯函数（后端**未导出**，本插件在 `lib/host/encode.js` 中逐字节复刻）：

```js
// 安全码元保持字面量；'.'/'..' 特判；其余（含 '~'）→ ~XXXX（UTF-16 码元，大写 16 进制）
encodeSegment(raw)

// 分隔符 '/' '\' ':' → '-'（连续折叠）；不安全码元同上；最后 --<可读部分≤251>--
projectKey(cwd)
```

回归锚点是本机真实目录名，不是构造的样例：

```js
projectKey("/Users/example/Desktop/work/研究")
  === "/--Users-example-Desktop-work-~7814~7A76--"
projectKey("/Users/example/Desktop/work/插件")
  === "/--Users-example-Desktop-work-~63D2~4EF6--"
```

---

## 3. 会话目录定位：三层回退

**定位错目录 = 删错数据**，所以这一层被设计得最保守（`lib/host/locate.js`）。

| 层 | 依据 | 何时使用 | 风险 |
|---|---|---|---|
| 1 | `persistence.stat(id)` → `header` → `persistence.locate(header).path` 的 dirname | 有 `locate` 时（JSONL 后端） | 依赖实现方法存在——因此不是必需 |
| 2 | `persistence.root` + `projectKey(header.cwd)` + `encodeSegment(id)` | `locate` 缺失，但能读到 header | 依赖复刻的编码正确——有回归测试锚定 |
| 3 | 扫描每个候选根的**一级**项目目录，找 `<encoded id>` | header 也读不到（后端冷/损坏/stat 抛错） | O(项目数) 次 `lstat`，无正确性依赖 |

三层都通过同一个接受函数，且候选根包含 `persistence.root` 与 `<dshHome>/sessions`：

```js
async function acceptableDir(root, dir) {
  const info = await fs.lstat(dir);                 // 必须存在
  if (info.isSymbolicLink() || !info.isDirectory()) return undefined;
  const real = await fs.realpath(dir);
  const realRoot = await fs.realpath(root);
  return isInside(realRoot, real) ? real : undefined; // 必须落在根内
}
```

- 拒绝符号链接（避免通过链接把别处目录搬走）；
- realpath 之后再判包含（正确处理 macOS `/var` → `/private/var`）、正确处理前缀邻居（`/a/bc` 不算是 `/a/b` 之内）；
- 第 1 层即使返回了根外路径也会被拒，随后回退到第 2 层重算——有测试覆盖「恶意 `locate()` 答案」这一场景。

---

## 4. 回收站设计（`lib/host/trash-store.js`）

### 4.1 布局

```
<root>/                                   # 默认 ~/.dsh/session-trash
├── items/
│   └── t-20261001T153000Z-a1b2c3d4/
│       ├── manifest.json                 # 唯一的真相来源
│       └── payload/                      # 被移走的整个会话目录
│           ├── session.v4.jsonl.zstd
│           └── session.lock
└── logs/
    └── trash-2026-10-01.ndjson           # 追加写审计日志
```

**故意不设持久化索引。** 列表由 `items/*/manifest.json` 推导。理由：双写索引与实体必然会不一致，而这类不一致在删除场景里意味着「界面说没有、磁盘上有」或反过来，都是数据事故。代价是 O(条目数) 次小文件读，对本地回收站完全可接受。

### 4.2 崩溃安全：一次删除的写入顺序与提交点

```
1. mkdir  items/<trashId>/                  ← 只为放 manifest；**不预建 payload**
2. 原子写  manifest.json { state:"moving", originalPath, sessionId, … }   ← 先记下「从哪来」
3. rename(源目录 → payload)                  ← 提交点（同文件系统原子）
   3'. 跨设备：cp 源 → payload.tmp ; rename(payload.tmp → payload)  ← 提交点 ; rm -rf 源
4. 原子写  manifest.json { state:"trashed", files:[…], totalBytes }
5. 追加审计日志
```

**提交点**是第 3 步的 `rename`。在它之前失败 = 什么都没搬，可以安全回滚；在它之后失败 =
会话已在回收站，只剩收尾（第 4/5 步、以及跨设备时删除源目录），**一律不得再抛错**，否则调用方
的回滚会把唯一一份完整副本删掉。

**为什么「`moving` + payload 存在 ⇒ 移动已完成」是成立的**：`payload` 只由 `rename` 创建。
同文件系统是原子 rename；跨设备是先复制到 `payload.tmp` 再原子 rename 到 `payload`。任何时刻
`payload` 都不会以「复制了一半」的状态存在（第 1 步不预建 `payload` 正是为了保住这个性质——
早期版本预建了空 `payload`，于是这个推断在「已写 manifest、尚未 rename」的窗口里失效，
会把一个**没有真正删除**的会话报告成已删除）。

每个中断点的后果：

| 中断位置 | 磁盘状态 | 行为 |
|---|---|---|
| 2 之前 | 会话原封不动 | 可能留下一个空 items 目录；`list()` 把它报为 `orphan`，可彻底删除，字节不会永远泄漏 |
| 2 与 3 之间 | manifest 为 `moving`，**payload 不存在** | `list()` 报 `failed`（「移动从未完成」）；`restore()` 报 `not-restorable`；会话仍在原位 |
| 3 与 4 之间 | manifest 为 `moving`，payload **完整** | `list()` / `restore()` 在**内存中**判定为 `trashed`（rename 已原子生效），不写盘 |
| 3' 的 rm 失败 | payload 完整，源目录残留 | 记为 `leftover`：删除仍报成功并写入审计（`ok-with-warnings`），残留路径记入日志由人工清理 |
| 4 之后 | 完整可恢复条目 | 正常 |

### 4.2.1 只读路径不写盘

`list()`（GET）与**被拒绝**的 `restore()` 都不会修改任何文件：自愈只在内存里发生，落盘只发生在
真正改变状态的操作上。这是对「拒绝的操作绝不触碰文件系统」这条承诺的实际兑现，也有测试守护
（对比 manifest 的字节与 mtime）。

### 4.3 恢复

```
1. 读 manifest；只接受 state === "trashed"（moving+payload 会先自愈）
2. 目标 = manifest.originalPath（删除前 realpath 的规范化绝对路径）
3. 若目标已存在 → 拒绝 { code:"occupied" }，**回收站条目保留**
4. mkdir -p 目标父目录；rename(payload → 目标)
5. 删除条目目录（或 keepItem 时留作审计记录）
6. 追加审计日志
```

「拒绝而非覆盖」是刻意的：两个会话目录合并是数据损坏，而删除后重建同名会话是完全可能发生的正常操作。

第 5 步的清理是**恢复之后**的事：payload 在第 4 步就已经 rename 回原位，所以清理失败（权限、文件系统错误）
不能把这次恢复判成失败——那会让用户以为会话丢了，同时跳过 `#restoreAccounting`，还会在回收站里留下一个
「点了恢复却什么都没有」的条目。因此清理失败时只记一条 warn，并把清单就地改成 `state: "restored"`
（尽力而为：清单本身也可能写不下去，那就只留日志），返回仍然报告成功、`move.leftover = true`。

到这里只完成了**文件层面**的恢复：磁盘上又有这个会话了，但宿主并不持有它的活体——删除时
`#releaseResidentSession` 已经把活会话从运行时拿下（§5.2 ④），而磁盘上的冷会话只有在下一次
`resolve → resume` 时才会重新变成「能对话的会话」。谁也不会替用户发起那次 resume，所以恢复必须
自己把它做完，见 §5.6。

### 4.4 原子且持久的写入

```js
writeFileAtomic(file, data):
  tmp = file + ".tmp-" + 随机          // 同目录，保证 rename 不跨设备
  open(tmp) → write → fsync(句柄)      // 数据落盘
  rename(tmp → file)                   // 原子替换
  fsync(父目录)                        // 让 rename 本身可存活断电（尽力而为）
```

manifest 是恢复的唯一依据，所以先 fsync 再改名，而不是「写完了事」。

### 4.5 权限与标识

- 回收站目录 `0700`、manifest `0600`、日志 `0600`——删除的会话可能含敏感内容，不对同机其他用户开放。
- 日志中的主机名只记 SHA-256 前 12 位，避免日志本身泄漏机器标识。

---

## 5. 安全守卫与拒绝语义（`lib/host/service.js`）

### 5.1 两种危险，两种同意，以及「同意之后必须做成」

删除一个会话目录有两个不同风险，因此有两个判据；但一旦用户对它们表示同意，**删除就必须完成**。

| 风险 | 判据 | 未同意时的拒绝码 |
|---|---|---|
| 有正在运行的工作，删掉会丢失用户可见的进度 | `workspace/session-activity` waterfall 返回非空 | `session-active`（附活动清单） |
| 会话仍驻留内存，runtime 可能仍持写句柄，之后 flush 会在已删除目录里重建日志 | `ctx.get("sessions").get(id) !== undefined` | `session-live` |

只有调用方传 `stopActivity: true`（UI 上按钮变成「停止并删除」）时才继续。此后按顺序：

```
1. 客户端先放手：目标里含当前打开的会话时，切到另一个幸存会话；没有幸存者就释放主选区
   （uiWorkspace.openSession / clearMain），并关闭本客户端为这些会话开的 scope
   （sessions.retireScope / sessions.manager.drop）。释放引用是客户端的能力，不是用户的操作要求。
2. 宿主停止进行中的工作 —— 复用 workspaceRegistry.stopSessionActivity
   （归档流程用的同一条接缝，内部派发 workspace/session-stop 并行事件）。
3. 宿主归档该会话 —— 复用 DSH 自己的 archiveSession(sessionId, { stopActivity: true })。
   归档是「让运行时可以放手」的机制：它门禁所有唤醒，并让持有主引用的客户端释放引用，
   于是运行时 dispose 会话、关闭持久化写句柄。
4. 有界等待其离开内存（≤15 秒，夹取在服务层）；已同意强制的只探 250ms（FORCE_RELEASE_PROBE_MS）。
5. 仍未离开 → 若调用方传了 force，**主动把会话从运行时拿下**：调用活会话注册表自带的
   detach() 释放器（ctx.sessions.store.get(id).detach()），等最后一次 drain（RELEASE_SETTLE_MS）
   之后再移动文件。释放器不可用或释放失败，才退化为「照样移动 + 保留归档」。
6. 若移动最终失败，回滚第 3 步写入的归档，绝不让用户看到一个自己没归档却被隐藏的会话。
7. 记账收尾：释放成功 → 移除归档 id（行彻底消失）；运行时仍持有 → **保留**归档 id
   （这是唯一能隐藏残留行的状态），并如实返回 residue: true。两种情况都**不做 detach**，
   因为 detach 会把残留行推进「未分组」。详见 §5.2。
```

**为什么必须有第 5 步（force）**：没有它，一个运行时始终不肯放手的会话就永远只能被拒绝——
而拒绝发生在第 2 步**已经停掉了用户的工作之后**。这正是用户报告的缺陷：点了「停止工作并删除」，
工作被停了，然后删除被拒绝，用户既丢了工作又没删掉会话。停止工作与删除必须同生共死。

**force 的残余风险**是被迫接受的、且被记录：驻留的 runtime 理论上仍可能写出一个只含后续事件的
残缺日志，于是会话会以不完整的样子重新出现。缓解措施是第 2、3 步（工作已停、唤醒已被归档门禁）
加上记账清理；即使真的发生，完整副本仍在回收站里可恢复，审计里也有 `forced: true` 可查。

未经同意的拒绝路径（第 1 步之前）**零副作用**：不停止任何工作、不写归档、不移动任何文件。

### 5.2 记账清理（移动成功之后）—— 两个决定都是「承重」的

移动成功之后要对 DSH 的持久账本做收尾。这里有两个决定，都直接由**侧栏如何取行**决定，写错任何一个都会在界面上留下删不掉的鬼影。

侧栏的分组规则（`dsh-client-ui-workspace/lib/client.js` 的 `groupByWorkspace`）：

```js
const accounted = new Set();
for (const workspace of workspaces)
  for (const id of workspace.sessionIds) {
    const summary = list.byId[id];
    if (summary === undefined) continue;      // 没有 summary 就是惰性 id，被跳过
    accounted.add(id);
    if (!sessionVisible(...)) continue;
    members.push(summary);
  }
// 「未分组」= 列表里有、但没有任何 workspace 认领的会话
const stray = list.ids.map(id => list.byId[id])
  .filter(s => s && !accounted.has(s.id) && sessionVisible(...));
if (stray.length > 0) groups.push(buildGroup("", ...));   // 标题 group.ungrouped
```

而可见性（`sessionVisible`）：

```js
if (session.origin === "subagent") return false;
if (session.blank && session.id !== current) return false;
switch (archivedFilter) {
  case "default": return !archived.has(session.id);   // 在归档集合里 ⇒ 隐藏
  case "show":    return true;
  case "only":    return archived.has(session.id);
}
```

据此得到两条规则：

**① 绝不 detach。**
detach 会把 id 从它所属的 workspace 里摘掉，于是「列表里还有、但没人认领」→ 正好落进**未分组**。惰性 id 本身是无害的（`groupByWorkspace` 遇到 `summary === undefined` 会跳过），而且保留归属还有一个好处：**恢复时会话回到原来的工作区**，不需要按 `cwd` 反猜。

**② 只有「运行时仍持有」时才保持归档。**
强制删除原本是唯一会出现「文件已移走、运行时仍持有该会话」的情形。DSH 的会话列表把**活的**会话也算进去（`dsh-session-query` 的 `listSessions`：`records.set(session.id, {live:true})`），而全产品**没有任何公开的 dispose-by-id 接口**（`SessionStore` 只有 `create/prepare/enter/detachEntered/announce/emitDisposed/flush/get/list/fork`，`detachEntered` 需要内部 entry；客户端的 Remote 会话 API 也只有 `list/search/create/rename/fork/prompt/cancel/…`）。但活会话注册表**自己给每个会话一个 entry，entry 自带 `detach()` 释放器**（`ctx.sessions.store.get(id).detach()` → `detachEntered` → 删除 entry、关闭写句柄、`emitDisposed` → 宿主 `session/disposed` → `api-session/removed`）。插件用它把会话真正拿下：释放成功 → 宿主不再列出它 → **行彻底消失**，归档 id 也随之移除；释放器不可用或释放失败（唯一的残留情形）→ 行会一直存在到**进程重启**，而**归档是唯一能隐藏它的状态**（`case "default": return !archived.has(id)`）。

反过来说：释放成功时**必须** unarchive，否则一个已经彻底消失的会话会莫名其妙留在「显示已归档」里。

| 删除类型 | 归档集合 | detach | 结果 |
|---|---|---|---|
| 干净（会话已释放） | **移除** id | 不做 | 行彻底消失 |
| 强制且释放成功 | **移除** id | 不做 | 行彻底消失（会话被从运行时拿下） |
| 运行时拒绝释放（残留） | **保留** id | 不做 | 行被默认过滤器隐藏；重启后彻底消失 |

配套的 UI 处理：宿主 `plan` 对「列表里有、磁盘上没有」的会话返回 `not-found`，客户端把它显示为**已删除**（而不是「不可删除」），并且**不计入**「无法删除」的计数——否则用户会以为自己的删除失败了。

**③ 无文件的会话可以被删（清出列表），不是「删不掉」。**
`not-found` 只是「没有目录可移动」，它不等于「不能删」。宿主的 `#clearFileless` 把它走成一条独立的成功路径：需要同意时先停工作；若运行时仍持有该会话，先归档隐藏，再**主动释放**（调用宿主 live registry 自带的 `detach()` 释放器，DSH 没有公开的 dispose-by-id API），释放成功后把归档集、工作区槽位、置顶里的残留记账一并清掉，行彻底消失；释放失败才退回归档隐藏，并如实返回 `residue: true` 与出路文案（「已归档隐藏，重启 DSH 后彻底消失」）。全程 `emit "api-session/removed"`，审计记 `delete:cleared`，返回 `{ok:true, cleaned:true, trashId:null}`（没有回收站条目，因此 UI 的**撤销**不会为它出现，提示条也如实说「已从列表和 DSH 运行时中清除」）。仍然被拒绝的只有两件：无法安全确认的路径（`unsafe-location` / `invalid-session-id`）与未经同意的 `session-active` / `session-live`——而拒绝也带着 `code`/`message` 回到界面，不用 `disabled` 控件替用户做决定（FR-2.9）。残余风险：若文件其实存在、但三层定位都没找到（目录名非标准且后端也报不出路径），清出列表不会搬走它们——这是既有的定位盲区，`totalBytes: 0` 与「已从列表和运行时中清除」的措辞都不会谎称已经移入回收站。

**④ 释放为什么必须由插件来做（`「已归档且删不掉」` 的根因）。**
DSH 的宿主在客户端打开一个会话的事件流时，会把这个**冷会话**（文件已不在、只剩投影缓存）**激活**（`promote` → `resume`），把它放进宿主的活会话注册表，于是宿主持续在列表里列出它。用户点过那一行，行就活了；此后插件的预检看到 `resident: true`，既不能删（没有目录可搬），也删不掉（运行时还持有）。旧实现只做了「归档隐藏」——归档集是唯一能藏住一行的状态，但归档集本身不会让行消失，于是留下一个灰行、对话框写着「已归档」、点删除没有反应。这不是用户操作的问题，是插件的缺陷：新实现主动释放运行时 + 清掉全部残留记账，客户端另外把这类行标成**残留**（不是「已删除」），并给出「切到『隐藏已归档』」或「重启 DSH」这两条出路。

### 5.3 通知客户端

- 删除后 `ctx.emit("api-session/removed", id)`：所有已连接客户端把该行从列表移除（这是会话控制器自己在 `session/disposed` 时用的同一个事件）。
- 恢复后 `ctx.emit("api-session/added", summary)`：summary 取自 `ctx.sessionController.listState.list()`，即 DSH 自己的列表构造器，不自行拼装。
- 恢复的顺序是「文件回位 → 记账回位 → **复活** → 通知」：`api-session/added` 只在复活尝试**之后**发出。
  反过来（先通知再复活）会让客户端先拿到一行、隔一个不确定的时长才变得可对话，而这段时间里用户发出的
  提示会落进一个没有活体的会话里——这正是 §5.6 要修的那个故障的可见形态。
- 调用方自己的客户端还会额外 `ctx.sessions.refreshList()`，因为 emit 是尽力而为，不应作为唯一依赖。

### 5.4 串行化与批次隔离

- `SerialQueue` 把 `deleteSessions` / `restoreSessions` / `purgeSessions` 串起来，保证不会有两个操作同时改写同一份 manifest。这也是「同一会话被并发删除」的唯一保护：第二个请求看到的是 `not-found`，**不需要**额外的 per-id 登记（早期版本的 `#inFlight` 因此是死代码，已删除）。
- **批次内逐项隔离**：`deleteSessions` / `restoreSessions` / `purgeSessions` 都对每个 id 单独校验、单独 try/catch，逐项返回结果。否则一个畸形 id、或者一次没被 `trash()` 转成裁决的文件系统错误，会在前面的条目**已经改动过磁盘之后**抛出，调用方拿到一个 500 却看不到到底发生了什么——更糟的是，已经进回收站的会话连同它们的 `trashId` 一起丢失，而那个 `trashId` 是「撤销」唯一的凭据。
- **`purge` 的 `["*"]` 在队列内部展开**：哨兵先被记录下来，真正枚举回收站内容发生在 `#queue.run` 里。否则「列出 → 删除」之间如果插进一次 delete，新条目就会漏掉，而调用方以为清空成功了。
- `trashId` 由 `时间戳 + 4 字节随机` 生成并校验格式，从请求体到路径全程受正则约束，无法用于路径穿越。

### 5.5 删除与恢复的记账对称性

删除会把 id 从三处持久化记账里移除；因此**恢复必须放回去**（`#restoreAccounting`），否则会话会以
「未分组、归档/置顶状态被静默改变」的样子回来：

| 记账 | 删除时 | 恢复时 |
|---|---|---|
| `tables.workspaces[ws].sessionIds` | `Entity.detachSession(id)` | 按 manifest 记录的 `cwd` 找到工作区并 `Entity.attachSession(id)` |
| `global.pinnedSessionIds` | `unpinSession(id)`（如果删前是置顶） | `pinSession(id)` |
| `global.archivedSessionIds` | `unarchiveSession(id)`（如果删前是归档） | `archiveSession(id)` |

恢复出的会话在工作区内的**精确次序**不还原：DSH 的会话显示次序是浏览器本地的，删除移走的是
「成员资格」这一持久事实，恢复也只承诺把成员资格还回来。

### 5.6 恢复即复活：文件回来不算回来

`#restoreOne` 在 `#restoreAccounting` 之后、`#emitAdded` 之前调用 `#reviveSession(sessionId)`：

```
1. 活体注册表里已经有它（ctx.sessions.get(id) 有值）→ already-live，不重复 resume
2. 宿主没有 sessionController.resolveAgent → no-resume-api（降级，不假装成功）
3. await Promise.race([ resolveAgent(id), 超时 ])，超时 = reviveTimeoutMs（默认 8000ms）
4. 返回 {agent} → resumed；{error} / 抛错 / 超时 → resume-failed + message
5. 每条分支都写审计（op: "restore-revive"），并把 revived / reviveCode / reviveMessage 带回结果行
```

三条设计决定：

- **复活失败不把恢复判成失败。** 文件已经回原位、记账也已经回位，把整次恢复报成失败会让用户以为
  会话丢了，还会把一个「重启就能救回来」的会话报成「恢复失败」。所以 `ok` 仍为 `true`，另用
  `revived: false` + `reviveCode` / `reviveMessage` 如实说明，客户端据此把提示降级成警告：
  「文件已恢复，但没有重新挂载到运行时（原因）：重启 DSH 后即可继续对话」。
- **复活必须有超时。** resume 要走 `sessionQuery.observeSession` → `agents.resume`，读盘、建 agent；
  一个卡住的 resume 不允许把恢复请求一起挂住——`SerialQueue` 是串行的，挂住就等于所有人的删除/
  恢复/彻底删除一起挂住。超时之后那个 promise 仍然挂着 `.catch(() => {})`，免得它在很久以后变成
  未处理的拒绝。
- **驻留判定问注册表本身，不用 `isResident()`。** `isResident` 是 **fail-closed** 的：探测本身失败时
  按「可能驻留」返回 `true`——这对删除路径是对的（宁可拒绝也不误删），但在这里会把「注册表读不到」
  翻译成「会话还活着」，于是**跳过**复活，恢复又退回沉默的僵尸行。所以 `#reviveSession` 直接读
  `ctx.sessions.get(id)`，读不到就照常去 resume：宿主对活会话的 `resolveAgent` 是空操作
  （`resolve()` 先查 `liveAgent()`，命中即返回，不触发 resume），多叫一次没有代价。

客户端侧配套（`lib/client.js`）：

- **丢弃陈旧实例**（`releaseStaleSession`）：删除时客户端把该会话的 scope 退休了
  （`releaseClientScopes`），但 `api-session/removed` 的处理只给实例打 `removed = true` 标记、**不销毁**
  它（`handleRemoved()` 的注释就是「flag the snapshot while retaining the resident instance」），而
  `api-session/added` 也**不清**这个标记。于是恢复后重新打开时可能复用一个带着删除标记的实例，而
  `prompt()` 根本不看这个标记——失败还是静默的（`prompt()` 只在 `{ok: false}` 时退役回显并设
  `promptError`，抛异常时连错误条都没有，用户看到的正是「消息发出去了，什么都没发生」）。所以恢复时
  主动丢弃：`removed === true` 的走 `sessions.retireScope(id, scope)`，其余走 `sessions.manager.drop(id,
  instance)`，由下一次打开重新懒建。
- **重开原来那一页**：删除时模块态记下当时 main view 上的会话 id（`currentMainSessionId()`）；恢复结果
  里包含它就 `uiWorkspace.openSession(id)` 重新打开——用户回到的是「刚才那个会话」，不是回收站面板。

### 5.7 预检（`plan`）的成本：并发做，别做没人看的事

预检是唯一一个「一次要问很多会话」的只读动作，它的耗时必须与用户选中的行数无关地保持在几十毫秒量级：

- **并发而非串行**：`plan` 用 `mapWithConcurrency(ids, PLAN_CONCURRENCY = 4, …)` 跑每项 `#planOne`
  （`Promise.all` + worker pool），结果按输入顺序收集——顺序是调用方的语义（行与标题一一对应），
  不能因为快而乱。上限 4 是刻意的：`lstat` 与 `readdir` 是磁盘操作，并发太高只是把队列挪到内核，
  还要和 DSH 自己的写入抢 IO；删除/恢复/彻底删除**不**走这个并发（它们必须串行，见 5.4）。
- **不量没有展示的字节数**：`bytes` 需要 `directorySize()` 递归遍历。客户端从来没有展示过它
  （`summarizeSelection` 算了 `bytes` 却没有任何渲染路径用到），所以 `plan` 默认不量（`bytes: 0`），
  只有显式 `sizes: true` 才付这笔 IO。实测 17 个会话、9.6 MB 的现场：带 `sizes` 39 ms——不快到无关紧要，
  但也不值得让它成为默认成本。

---

## 6. HTTP 接口（`lib/host/routes.js`）

只注册**一条**前缀路由 `/session-trash`，因此不会与其他插件撞路径（`webServer.register` 对重复路径会抛错）。
`enabled` 在**每个请求**里读取，所以 profile 里关掉它立即生效，而不是要等重新挂载。

| 方法 | 路径 | 请求体 | 返回 |
|---|---|---|---|
| GET | `/session-trash` \| `/status` | — | `{ok, value:{root,count,bytes,retentionDays,canDelete,…}}` |
| GET | `/session-trash/list` | — | `{ok, value:{items,broken,stats,maxBatch}}` |
| GET | `/session-trash/log?limit=N` | — | `{ok, value:{records}}` |
| POST | `/session-trash/plan` | `{sessionIds, sizes?}` | `{ok, value:{plans, root, maxBatch, retentionDays, canDelete}}`（**只读预检**） |
| POST | `/session-trash/delete` | `{sessionIds,titles?,stopActivity?,waitForReleaseMs?}` | `{ok, value:{results,deleted,failed}}` |
| POST | `/session-trash/restore` | `{trashIds}` | `{ok, value:{results,restored,failed}}` |
| POST | `/session-trash/purge` | `{trashIds,acknowledge}` | `{ok, value:{results,purged,freedBytes}}`；未确认 → **428** |

**访问控制**（`lib/host/access.js`）与 DSH 自己的 `/api` 桥保持一致，而不是自创一套更窄或更宽的规则：

1. 请求 authority 必须是回环地址（`localhost`、`::1`、**整个 `127.0.0.0/8`**），或本部署声明的
   受信 authority（读 `ctx.get("connection").trustedHosts`，并可与插件自己的 `trustedHosts` 配置合并）；
2. `Sec-Fetch-Site !== cross-site`；
3. `Origin` 缺省或与请求 authority 同源。

这三道闸门分别对应 DNS rebinding、跨站页面、跨源伪造三条混淆代理路径，缺一不可。

> **关于「已配对设备」**：早期版本照抄了某个第三方插件的 `remoteWebUiPairing` 分支并写进了文档。
> 该服务在 DSH 0.2.0-rc.2 中**根本不存在**（全量检索出现 0 次），也就是说那段分支永远不会执行。
> 现已删除，文档也不再宣称它——非回环部署请用 `trustedHosts`，那是真实可读的。

**其他边界**：
- 方法约束：非 GET/POST → 405；对只读动作例外，对变更动作发 GET 也 → 405；未知动作 POST → 404。
- 请求体上限 256 KiB，**超限排空后回 413**（不是 `req.destroy()`：销毁会让调用方看到网络错误，
  而不是可解释的拒绝）。
- 所有接受 id 列表的动作都在请求层统一校验；`purge` 的 `["*"]` 哨兵豁免（它命名的是回收站自己的内容）。
- **`plan` 的上限与变更动作不同**：预检只读、代价是每会话一次 `lstat`，所以它单独放宽到 `planMaxIds`
  （`max(配置 maxBatch, 500)`）。变更动作（`delete`/`restore`/`purge`）仍受 `maxBatch` 约束——但那个约束现在由
  客户端**切成多批**来满足，而不是让用户撞上 `batch-too-large` 的死胡同（见 7.5）。
- `plan` 的返回体顺带带上 `root` 与 `maxBatch`：对话框描述需要的回收站路径、以及客户端切批要用的批大小，
  一次往返就够。旧版宿主半不返回这两项时，客户端退化为单独一次 `GET /status`（两半是分开热更新的）。
- `list` 的返回体同样带上 `maxBatch`：回收站面板没有预检，它要恢复/彻底删除的是**回收站里的条目**，
  批大小只能从这里拿；旧版宿主半不返回时客户端退回默认值（100，与宿主默认一致）。
- `waitForReleaseMs` 在服务层被夹到 `[0, 15000]`：这个等待发生在**共享的变更队列内部**，
  不设上限的话一个请求就能把所有人的删除/恢复/彻底删除全部堵住。
- 未预期异常 → 500 并写入宿主日志；业务拒绝 → 200 内的 `results[].code`（批次语义），
  或 400/413/428（请求级错误）。

### 6.1 为什么用 HTTP 而不是类型化 Remote

DSH 的 Remote 命名空间是**构建期**由 `@deepseek-ai/dsh-typert-generator` 生成、由 `@deepseek-ai/dsh-api-remotes` 按显式清单装配的（"The capability set is fixed by explicit build-time value imports"）。外部插件无法把自己的命名空间塞进这个清单。

而 `ctx.webServer.register()` 是公开服务，且已有第三方插件（如 git-graph 用 `/git/*`）这样实践。因此本插件走 HTTP，并在概念上模拟 Remote 的 `{ok, value}` / `{ok, code, message}` 信封，让客户端处理逻辑保持单一。

---

## 7. 客户端架构（`lib/client.js`）

### 7.1 注入的槽位

| 槽位 | id | order | 作用 |
|---|---|---|---|
| `sidebar.workspaces.session.menu.item` | `session-trash.delete` | 500 | 「删除会话」 |
| `sidebar.workspaces.session.menu.item` | `session-trash.delete-batch` | 600 | 「批量删除会话…」（带分隔线） |
| `shell.overlay` | `session-trash.overlays` | — | 两步确认对话框、彻底删除对话框、撤销提示 |
| `sidebar.panellist.actions` | `session-trash.more` | −20 | 侧栏「更多」菜单里的「回收站」行（排在宿主内置两行之前） |
| `main`（keyed） | key `session-trash` | — | 回收站主面板页 |

`shell.overlay` 是必须的：会话菜单行会随菜单卸载，对话框不能挂在行内。这也是 DSH 自己的重命名/归档对话框的做法。

`main` 槽位是按 `activePanelId` 取值的 keyed 槽，`ctx.layout.selectPanel("session-trash")` 即切换过去（提示条上的「查看回收站」用它）。

### 7.2 组件如何拿到状态与文案

Renderer 的 slot "kit" 按注册项声明注入 props：

- 注册项写 `locale: "sessionTrash"` → 组件收到 `t`；
- 注册项写 `store: <handle>` → 组件收到 `useStore(selector, eq?)` 与 `actions`；
- 父槽位（workspace 的菜单列表）声明了 `inject.hooks.menuOpenState` → 每个菜单行收到 `useMenuOpenState`。

### 7.3 单一 store 实例（关键细节）

`defineStore(decl)` 返回一个 **handle**，其 `.create()` 产出实例。Renderer 原则上可能**为每个 entry 各建一个实例**，那样「菜单行写入、对话框读取」就会失效。

因此本插件只 `create()` 一次，并把 handle 的 `create` 覆写为返回同一实例：

```js
const storeInstance = storeHandle.create();
const storeSeat = { ...storeHandle, create: () => storeInstance };
```

这正是 DSH 自己的插件管理器页面为避免这个问题所采用的手法。测试断言了所有声明 `store` 的注册项解析到同一实例。

### 7.4 状态模型

```js
{
  dialog: null | { mode:"single"|"batch", sessionIds, titleById, singleTitle,
                   plans, selectedIds, step:1|2, pending, error, root },
  bin:    { status, items, broken, stats, error, selected, log },
  purge:  null | { trashIds, count, bytes, pending, error },
  notice: null | { text, tone, undo:{trashIds} | null }
}
```

### 7.5 交互流程

**单会话删除**

```
菜单「删除会话」
  → 关闭菜单；POST /plan  ← 预检：是否可删、是否运行中、有无进行中工作、回收站路径
  → 若这一项「安静」（可删、非 resident、无进行中工作、未在运行）：
       不弹对话框，直接 POST /delete，Toast「会话已删除」+ 「撤销」/「查看回收站」
       ⇒ 常见情况下是「一次点击 = 删完」，而不是「点开→再点一次」
  → 其余情况（运行中 / 有进行中的工作 / 目录定位不了）才打开对话框：
       展示标题 / 标签 / 原因 / 回收站路径 / “之后可随时恢复”，主按钮「删除」或「强制删除」
       快捷路径被宿主拒绝时，对话框带着拒绝原因打开，用户可以直接重试
  → payload.stopActivity = payload.force = 所选里存在需要同意的项
  → 若目标含当前打开的会话：先 uiWorkspace.openSession(幸存者) 或 clearMain()
  → POST /delete → 关闭对话框；refreshBin() + sessions.refresh()
  → Toast：「会话已删除」+「撤销」（=恢复）/「查看回收站」
       被强制删除时追加一行说明；被清空的残留行说「只从列表里移除了」
```

**批量删除**

```
菜单「批量删除会话…」
  → POST /plan（按 DEFAULT_MAX_BATCH=100 切批，逐批预检）
  → **按预检结果收敛列表**：剔除宿主判定为「已归档」与「已删除」的行
     （客户端看不到归档集合，只有宿主能区分「残留行」与「只是被隐藏的会话」）
  → 一次渲染全部行：每行都可勾选（标签只描述状态，不代替用户决定）
  → 「全选」= 当前筛选结果；已选计数实时更新
  → 「删除」/「强制删除」= 一次点击
       payload 只带真正选中的会话；所选里存在需要同意的项 ⇒ stopActivity = force = true
       按 dialog.maxBatch（来自 plan 返回，缺省 100）切批 POST /delete
       某一批被请求层拒绝（如 413/400）就停在那里，并把「已到达的裁决」原样交出：
       已经进回收站的会话仍然出现在 Toast 的「撤销」里
  → Toast 汇总：删除 N 个 / 清出 N 个 / 失败 N 个 + 去重后的原因（最多 5 条）
```

**为什么切批而不是让用户看到 `batch-too-large`**：`maxBatch` 是防滥用的请求层护栏，不是用户体验的
上限。旧实现把 100 个 id 直接发过去，超过了就整次预检 400，对话框空着、只有一行错误——一个用户
根本不知道怎么处理的死胡同。现在客户端负责把「用户选了多少」翻译成「宿主能接受多少」。

**回收站恢复**：面板选中条目 → 「恢复选中」→ `POST /restore` → 刷新面板与会话列表 → Toast 报告恢复数量。原始路径被占用时该项返回 `occupied`，其余照常，条目保留在回收站。选中条目多于一次请求能带的数量时，按 `maxBatch` **切成多批**提交（与删除路径同一套切批逻辑），而不是整次被 `batch-too-large` 拒绝。

**彻底删除**：面板 → 「彻底删除」/「清空回收站」→ 弹窗点「确认彻底删除」即 `POST /purge`（客户端把按钮点击翻译成 `acknowledge: true`，不再有单独的勾选步骤）→ 释放字节数写入 Toast。宿主端仍是权威：请求缺 `acknowledge` 就以 428 拒绝。同样按 `maxBatch` 切批；`["*"]` 哨兵是一个整体，永远只发一次请求。

### 7.6 样式

在 factory 体内注入一段样式表（这是模块系统认可的副作用时机，产物会被 `data-plugin` 归属并在卸载时回收）：

```js
tag.dataset.plugin = "dsh-session-trash";   // 模块系统据此在插件卸载时移除
tag.dataset.pluginCss = "dsh-session-trash/styles.css";  // 幂等键，避免重复注入
```

CSS 全部使用 DSH 自己的设计令牌（`--dsw-alias-label-primary`、`--dsw-alias-border-l3`、`--dsw-radius-md`、`--dsw-focus-ring-color`、`--dsw-font-xs-13` 等），因此自动跟随主题（含深色模式）而不是钉死自己的配色。图标按钮有 hover / focus-visible / disabled 三态，与既有 UI 的手感一致。

---

## 8. 配置

宿主端 `apply(ctx, config)` 只用 Node 内置模块，配置以「宽容读取」方式解析：既接受字面值，也接受 Cordis 设置写入后留下的 live reference（`{ get() }`）。

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 是否注册路由 |
| `root` | `<dshHome>/session-trash` | 回收站根目录 |
| `retentionDays` | `30` | 超期**标记**窗口（0 = 关闭；不会自动删除） |
| `maxBatch` | `100` | 单次批量删除上限（硬上限 1000） |
| `actor` | `session-menu` | 审计日志中的操作者标签 |

写在 profile 的 `cordis.patch.yml`：

```yaml
- id: session-trash
  name: 'dsh-session-trash'
  config:
    retentionDays: 14
    maxBatch: 50
```

**没有导出 `Config`（schemastery）是刻意的**：那会给插件引入一个运行时依赖，并使设置页依赖 DSH 的 schema→表单生成机制。本版选择零依赖 + 配置文件，代价是没有图形化设置页（已在 SPEC 的「范围外」中列明）。

另外，`apply` 会检查 `root` 是否落在 `<dshHome>/sessions` 内并告警——回收站若嵌在会话仓库里，会被定位器的第 3 层扫到，属于应当避免的配置。

---

## 9. 对抗性复核：发现与修复

代码完成后做了一轮独立的对抗性复核（目标是找缺陷，不是找认可），结论按严重度分级处理。
下列每一条都已修复，并且**每一条都有对应的回归测试**（`tests/host/regressions.test.js` 等）。

| # | 严重度 | 缺陷 | 修复 |
|---|---|---|---|
| 1 | **致命** | `exports.inject = []` 却在 `apply` 顶层读 `ctx.locale` → Cordis 门禁抛错 → fiber FAILED → **整个 GUI 启动失败** | 字典注册移入 `ctx.inject(["slots","locale"], scope => …)`，只用 `scope.locale`；测试假上下文改为 Proxy 强制门禁 |
| 2 | **致命** | 跨设备路径 `cp→rename→rm(源)`，`rm` 部分失败时抛出，调用方回滚把**唯一完整副本**删掉（且无任何审计） | `moveDir` 引入提交点：rename 之后的清理失败记为 `leftover` 而不再抛出 |
| 3 | 高 | `payload` 被预建为空目录，导致「`moving`+payload ⇒ 已完成」的推断在最关键的窗口失效：会**谎报删除成功**，而会话仍在原处且永远无法恢复 | 不再预建 `payload`；该窗口现在报 `failed`；`restore()` 也不接受它 |
| 4 | 高 | 移动成功后的 `inventory`/manifest 写在 try 之外：一次读取失败就把已完成的删除变成 500（无审计、无记账清理），并让 `/list`、`/status` **永久 500**（回收站面板彻底死掉） | 新增 `safeInventory`；移动后的一切失败都降级为告警字段，删除仍报成功并留审计 |
| 5 | 中 | 批次里一个畸形 id 会抛出，前面的条目已改盘，调用方只拿到裸 500 | 逐项校验 + 逐项 try/catch，逐项结果 |
| 6 | 中 | `waitForReleaseMs` 无上限，且等待发生在共享队列内 → 一个请求堵死所有人的删除/恢复/清理 | 服务层夹到 `[0, 15000]` |
| 7 | 中 | `maxBatch` 只管 `delete`；`plan` 还对每个 id 各读一次宿主会话列表（O(n²)） | 统一在请求层约束所有批量动作；summary 列表整批只读一次 |
| 8 | 中 | 无 manifest 的条目目录既不可见也删不掉 → 字节永久泄漏 | `list()` 报为 `orphan`（含字节数）；`purge()` 允许删除它 |
| 9 | 中 | `readLog` 的日文件顺序被整体反转，实际返回「最旧在前」，与自身契约相反（面板 `slice(0,50)` 只显示最旧记录） | 每日内部反转、日序保持最新在前 |
| 10 | 中 | `restore`/`purge` 的拒绝与失败不写审计，与头部注释承诺的「每次拒绝都留痕」不符 | 两处都补上拒绝/失败审计 |
| 11 | 中 | **被拒绝**的 `restore` 会因自愈而改写 manifest；`list()`（GET）也会写盘，违反「拒绝不触碰文件系统」 | 自愈改为纯内存；落盘只发生在真正改状态的操作上 |
| 12 | 中 | 第 1 层定位一旦「候选不存在」就直接返回 `not-found`，绕过了后两层回退——header 的 cwd 与磁盘不一致时该会话**无法删除** | 候选不存在时继续走第 2/3 层；仅「越界」才是立即拒绝 |
| 13 | 中 | `isSafeSessionId` 要求 `session-` 前缀，比 DSH 的真实 `SessionId` 窄（`session.create` 接受调用方传入的 id），导致这类会话删不掉 | 规则改为「非空、有界、不含分隔符、不是 `.`/`..`」——这正是防路径穿越所需的全部 |
| 14 | 中 | 访问控制比 DSH 自身的更窄（只接受 `127.0.0.1`，不接受整个 `127/8`、不读 `trustedHosts`），LAN 部署下**全部 403**；同时 `remoteWebUiPairing` 分支是死代码却被写进了文档 | 与 `dsh-client-connection` 的规则对齐；删除死分支；新增 `trustedHosts` 配置；文档不再宣称配对 |
| 15 | 中 | 恢复不还原工作区成员资格与归档/置顶状态 → 会话以未分组、状态被改写的样子回来 | 新增 `#restoreAccounting`（见 §5.5） |
| 16 | 低 | 超大请求体用 `req.destroy()`，调用方看到网络错误而不是可解释的拒绝 | 排空后回 **413** |
| 17 | 低 | `refreshSessions` 调的是 `refreshList`（内部子管理器的方法），实际是空操作 | 改调 `sessions.refresh()`，并保留回退 |
| 18 | 低 | 死代码与陈旧注释（`#inFlight` 永不为真、`trash()` 的包含性注释与实际不符、`enabled` 只读一次、`expired` 与 `stats` 用了不同时钟、`actor: undefined` 会抹掉默认值） | 逐条修正；`enabled` 改为逐请求读取 |
| 19 | 低 | 未使用/不可达的表层：`panel.purgeAll`（「清空回收站」）在文档里存在但 UI 永远不会发 `["*"]`；删除失败只报数量不报原因；未用导入与 prop | UI 接上「清空回收站」；失败原因汇总展示；清理未用项 |
| 20 | **高（用户实测报告）** | 同意「停止并删除」后，宿主**先停掉了用户的工作**，再因为运行时不肯释放该会话而拒绝删除 → 用户既丢工作又删不掉；代码注释声称「客户端会先导航离开」但从未实现 | 客户端先放手（`openSession` / `clearMain`）；宿主归档以促成释放；有界等待后按 `force` 强制完成并留痕；失败则回滚归档。回归测试 R17–R20 |
| 21 | **高（用户实测报告）** | 在「工作」项目里删除一个会话后，它出现在了**未分组**里，而且再也删不掉（显示「不可删除」）。取证：`plan` 返回 `resident: true, exists: false`；manifest 记录 `forced: true` | 根因是**强制删除会留下活的会话对象**：DSH 的 `listSessions` 把 live 会话也算进列表，而全产品没有公开的 dispose-by-id 接口，所以文件没了行还在；**再叠加我的 detach**，这行就正好落进「未分组」（该桶的定义就是「列表里有、没有 workspace 认领」）。修复：① 绝不 detach；② 归档 id 的去留改为由「运行时是否放手」决定——放得了就清掉（行彻底消失），放不了才保留归档（归档是默认过滤器下唯一能隐藏一行的状态）；③ 列表里无文件的会话在 UI 上显示为**残留**而不是「不可删除」，且不计入失败数。回归测试 R21–R24 |
| 22 | **高（用户实测报告）** | 删掉整个工作区后残留的会话落进「未分组」，批量删除时**勾不上**（复选框灰显）。取证：`plan` 返回 `deletable:false, exists:false, resident:true, archived:true, code:'not-found'`；用户原话「所有的删除应该由我决定能不能删，而不是直接把这个决定给定死」 | 两处都把决定权拿走了：① 客户端 `disabled: !deletable` + `全选` 过滤，而 `deletable` 只表示「磁盘上有目录」；② 宿主 `#deleteOne` 在 `!located.ok` 时直接拒绝，`not-found` 没有任何出口。修复：取消所有勾选门禁（禁用条件只剩「一个都没选」）、提交全部选中项、宿主新增 `#clearFileless` 把无文件的行**清出列表**（停工作需同意 / 归档隐藏 / `emit removed` / 审计 `delete:cleared` / 返回 `cleaned:true`），提示条不再对这类行说「已移入回收站」。安全边界保留为**带原因的拒绝**（`unsafe-location`、未经同意的 `session-active`/`session-live`），而不是灰按钮。回归测试：宿主 `a delete of a missing session clears the row…`、`a delete of a fileless resident session hides it…`、`a fileless session still needs consent…`，客户端 `canAdvance` / `buildDeletePayload` / `trashIdsOf` |
| 23 | **高（用户实测报告）** | §5.9 的门禁修好、重启 DSH 后，用户报告**勾选依然完全无效**：复选框已不灰显，但「已选择」永远是 0。取证：`dsh-client-ui-primitives` 的 `Checkbox({checked, onChange, label, disabled})` 用法正确；`lib/client.js` 的 `DeletePickStep` 三处（勾选 / `全选` / `取消选择`）调用了**未声明的裸函数** `patchDialog(...)`——该名字只存在于 store action 上，模块里从未定义 → 每次点击抛 `ReferenceError: patchDialog is not defined`（从 1.0 起就存在，与本轮门禁无关） | 三处改为 `storeInstance.actions.patchDialog({...})`（`lib/client.js:698/727/731`）。回归护栏：渲染层改为**驱动控件**（记录 Checkbox/Button 的 props 并代真实点击），断言选中状态、`/session-trash/delete` 的请求体与撤销项；改回裸调用即以 `ReferenceError` 失败。另加全模块裸调用扫描，确认没有第二处悬空引用 |

> **为什么 SSR 测试抓不到它**：服务端渲染只执行渲染路径，点击处理器一次都不会被调用。类缺陷只能靠
> 「调用它」的测试来发现——这也是 TEST-PLAN §5.10 新增那层测试的唯一目的。

### 9.1 第二轮复核：与 DSH 上游契约对齐

前一轮复核的对象是本插件自身。这一轮的起点是**插件对 DSH 的假设**，逐条回到上游源码核对
（`packages/client/ui-workspace/src/client/tree.ts`、`packages/client/runtime/src/client/sessions/service.ts`、
`packages/session/session-persistence-jsonl/src/format.ts`），结论如下。前五条都已修复并有回归测试。

| # | 严重度 | 缺陷 | 修复 |
|---|---|---|---|
| 24 | 中 | 批量删除的候选集用 `parentId` 判断「子代理」，而 DSH 的子代理位是 `origin === 'subagent'`（上游 `sessionVisible` 的规则）。**普通分叉（fork）也带 `parentId`**，于是侧栏里照常可见的分叉会话在批量选择器里**静默消失**，用户无法批量删除它 | 改判 `origin`：只排除子代理，与 DSH 自己的可见性规则逐字一致。回归测试 `batch candidates exclude blanks and subagent children` 同时固定「子代理被排除、普通分叉被保留」 |
| 25 | 中 | 回收站面板的「恢复选中」「彻底删除」把**整份选择**放进一个请求，而宿主按 `maxBatch`（默认 100）拒绝超限请求 → 回收站里超过 100 项时，这两个按钮**完全不可用**（删除路径早已切批，恢复/彻底删除没有） | 恢复与彻底删除按 `maxBatch` **切批**，与删除路径同一套逻辑；`list` 的返回体带上 `maxBatch`（面板没有预检，批大小只能从这里拿）。回归测试：切批请求数与每批 id、`["*"]` 哨兵仍只发一次 |
| 26 | 中 | manifest 能解析、但 `state` 是本版本不认识的（例如另一个版本写的）时，该条目**既不可恢复、也不算损坏**：面板看不见它，「清空回收站」的展开也跳过它 → 字节永久泄漏，且用户无从得知 | `list()` 把未知状态报为 `unknown-state`（并入 `BROKEN_STATES`，含字节数）→ 可见、可彻底删除。回归测试 R25 |
| 27 | 低 | 审计日志的 `host` 列取 `process.env.HOSTNAME`；`HOSTNAME` 是 shell 的约定，GUI 启动的 DSH 进程**通常没有它** → 每条记录都记成空串的哈希（`e3b0c44298fc`），所有机器同一个值，审计轨迹分不出是谁干的 | 退回 `os.hostname()`（`HOSTNAME` 仍在时优先用它），哈希方式不变（仍是 12 位十六进制、不落明文）。回归测试 R26 |
| 28 | 低 | 删除结果里的 `timings.wait` 记的是**允许等待的预算**而不是实际等待时长：会话秒释放也被报成「等了 8 秒」，而且等待的时间被算进了 `move` 阶段 → 客户端的「本次删除很慢」提示每次都误报 | 改为 `phase("wait")` 计时（预算只决定等多久，不决定报告什么）。回归测试 R27 |
| 32 | **高（用户实测报告）** | **已删除的会话仍出现在「批量删除会话…」的列表里**，旁边挂着「已删除」徽标和一个复选框。取证：回收站 `items/` 里已有 `t-20261025T111935Z-9775eb01`（`插件调研与安装`）与 `t-20261025T112004Z-d8447a6a`（`了解 hyperframes 项目用途`），两个会话目录早已移走，但 `batchCandidates` 只排除空白与子代理，**既不套用侧栏的归档过滤、也不看行是否还有文件** → 批量列表等于承诺一次早已发生过的删除，「全选」还会把用户从未在侧栏见过的行一并扫进去 | 批量列表只保留用户**还能删**的行：以**宿主预检**为准剔除 `archived`（用户已归档、侧栏默认隐藏）与「已删除」（`exists:false` / `code:'not-found'`，只剩残留行）。判定交给宿主，因为客户端看不到归档集合，只有宿主能区分「残留行」与「只是被隐藏的会话」。**单会话对话框不受影响**：用户点名问的那一行仍要显示（「已删除」徽标在那里说的是实话）。回归测试：`the batch picker drops rows the user can no longer act on`、`the batch dialog never lists a session that is already deleted or archived`、`the single-session dialog still shows a residue row it was asked about` |

### 9.2 第三轮复核：按**部署版本**（`dsh-v0.2.0-rc.2`）逐条核对契约

第二轮把插件对 DSH 的假设拿回上游源码核对时，用的是本地检出的 `dsh-v0.1.0-rc.7`——**版本比插件部署的版本旧**。
这一轮改用插件真正面对的 `dsh-v0.2.0-rc.2` tag 重新核对（`git show dsh-v0.2.0-rc.2:<path>`），结论如下。

**先说核对无误的**（这些是插件能工作的前提，逐条确认）：

| 契约 | 上游（`dsh-v0.2.0-rc.2`） | 插件的用法 | 结论 |
|---|---|---|---|
| 客户端会话行 | `SessionSummary { id, displayTitle, cwd?, parentId?, origin?: 'subagent', running, blank }`，`SessionListState { ids, byId }` | `batchCandidates` 读 `id`/`displayTitle`/`blank`/`running`/`cwd` | 一致（`origin` 判定已按上游修正，见 §9.1 第 24 条） |
| 子代理判定 | `sessionVisible`：`session.origin === 'subagent'` 才隐藏；`parentId` 只用于分叉的**排序** | 原先按 `parentId` 过滤 → 会误删分叉候选 | 已修（§9.1 第 24 条） |
| 会话目录布局 | `<root>/<projectKey(cwd)>/<encodeSegment(id)>`；`encodeSegment`/`projectKey` 与 `encode.js` 逐字节相同 | 定位器第 2/3 层 | 一致 |
| 定位层 1 | JSONL 后端有 `locate(meta)` → `{kind:'jsonl', path}`（TS `private`，运行时可见） | `persistence.locate(header)` | 运行时成立（见第 29 条的脆弱性说明） |
| `sessionPersistence` 契约 | 抽象类只有 `create/open/flush/stat/list`；**没有 `root`/`locate`** | `persistence?.root` / `persistence?.locate` 都是**可选优先** | 契约外成员，但插件有纯计算回退层，缺失也不失效 |
| `workspaceRegistry` | `archivedSessionIds`/`pinnedSessionIds` 是数组；`archiveSession(id,{stopActivity})`、`unarchiveSession`、`pinSession`、`unpinSession`、`list()` 均存在；实体有 `path`/`sessionIds`/`attachSession` | 记账清理与恢复记账 | 一致 |
| 活动探针 | `workspace/session-activity`（载荷 `{sessionId}`，返回 `SessionActivity[]`），提供者：agent / jobs / schedule / subagent | `ctx.waterfall(...)` | 一致 |
| 停止工作 | `workspace/session-stop`（载荷 `{sessionId}`）；agent 的处理器只在 `status === 'running'` 时取消 → 幂等 | 原先只走 `registry.stopSessionActivity`（TS private） | 已修（§9.1 第 29 条） |
| 事件 | `api-session/added`（带 summary）、`api-session/removed`（带 sessionId）均存在 | `#emitAdded` / `#emitRemoved` | 一致 |
| 客户端服务 | `sessions.refresh()`、`sessions.list.getSnapshot()`、`uiWorkspace.mainReference.sessionId` / `openSession` / `clearMain`、`layout.selectPanel` 均存在 | 对应调用 | 一致 |
| 路由注册 | `webServer.register({kind:'prefix', path, handler})` | 唯一一条前缀路由 | 一致 |

**本轮修掉的三条**：

| # | 严重度 | 缺陷 | 修复 |
|---|---|---|---|
| 29 | **中（安全相关）** | 停止工作的路径依赖 `workspaceRegistry.stopSessionActivity`——它是注册表的 **TS `private`** 成员（上游自己内部就是 `ctx.parallel('workspace/session-stop')` 的一层包装）。私有成员可以被改名或改成真正的 `#private` 而无需通知；届时插件的 `typeof === "function"` 守卫会**静默跳过停止** → 用户明明点了「强制删除（会先停止工作）」，会话却带着仍在运行的工作被搬走 | 公开契约 `ctx.parallel("workspace/session-stop", { sessionId })` 作为**回退**：注册表接缝在时行为完全不变，接缝消失时走公开瀑布流。回归测试 R28（注册表没有该接缝时，公开瀑布流仍被派发） |
| 30 | 低 | 审计日志只追加、从不轮转，而 `limit` 原样透传 → 一个请求就能把**全部历史**读进内存；`limit=0` 还会返回 1 条记录 | 路由层夹到 `[0, 10000]`，存储层按夹取后的值精确截断（`limit=0` 返回空）。回归测试 R29 + 路由用例 |
| 31 | 低 | 抑制重复告警的 `warnedResidency` 集合与宿主进程同寿且**从不清理** → 随进程探过的每个会话增长 | 上限 256 条，满了淘汰最旧的一条（Set 保序）。回归测试 R30 |
| 32 | **高（用户实测报告）** | 用户删掉**正在对话的那个会话**（会话正跑着一轮对话），侧栏那一行**仍然留着**，点它弹出「已归档对话暂时无法查看，请取消归档后再看」——一个打不开、也删不掉的僵尸行。取证：审计日志 `trash … forced=true` → `restore … ok`（用户随后点了恢复）；`plan` 返回 `resident: true, running: true, activity: [{kind:"turn"}]` | 两个原因叠加：① `stopActivity` 的 `sessionController.cancel` **掐不断在飞的模型请求**，于是 `waitForRelease` 在强制的 250ms 预算内必然超时 → `forced=true`；② 旧实现把 `forced` 当成「归档 id 保留」的信号，于是会话被**归档**而不是被释放，宿主仍在列表里列出它 → 灰行 + 「已归档」+ 删除无效。修复：① 强制删除时**主动把会话从运行时拿下**（`ctx.sessions.store.get(id).detach()`，活会话注册表自带的释放器），等最后一次 drain 后再搬文件，释放成功即 `released: true` / `residue: false`，归档 id 随之移除 → 行彻底消失；② 只有释放器不可用或释放失败才保留归档，并如实返回 `residue: true` + 出路文案；③ 客户端在对话框里给「当前正在看的会话」加「当前会话」标签并写明「删除会立刻结束这段对话」。回归测试 R18（强制删除把会话拿下）、R22（运行时拒绝释放才保持归档） |

> **仍然成立但值得记录的脆弱性**：`sessionPersistence.root` 与 `locate()`、`workspaceRegistry.stopSessionActivity()`
> 都是上游的**非契约成员**（TS `private` 或抽象类之外）。它们在 `dsh-v0.2.0-rc.2` 上运行时都存在，插件对缺失也有回退
> （第 29 条已把停止路径的回退补齐；定位器的回退层是纯计算的第 2/3 层）。但如果上游把它们改成真正的 `#private`，
> 插件会退回到**计算式定位**（第 2/3 层）而不是失效——这是设计上的取舍，README 的数据安全一节已说明。

同时**确认无误**的部分：`encode.js` 的 `encodeSegment` / `projectKey` 与上游
`session-persistence-jsonl/src/format.ts` 逐字节一致；`workspaceRegistry` / `sessions` / `sessionPersistence`
三个服务名与上游 `super(ctx, '<name>')` 一致；`archivedSessionIds` 是数组（`.includes` 可用），
`list()` 返回的实体带 `path` 与 `sessionIds`（`attachSession` 的用法成立）。

### 9.3 第五次用户实测：恢复后的会话「点了没反应」

用户把「数据库迁移方案评审」这个会话**删除、又立刻手动恢复**，之后在里面发消息：气泡发出去了，
界面没有任何回应，也没有报错。

取证（全程只读）：

- 回收站日志：`trash … forced=true released=true` → 39 秒后 `restore … ok`，`actor: session-menu`。
- 该会话目录 `~/.dsh/sessions/--Users-…-project-alpha--/session-78dfc5b9-…/` 当天**零写入**；日志末行停在
  前一天 22:17 的 `model/selection`（seq 982）。同工作区其它会话在同一时段正常落盘，同一条提示词在
  别的会话里得到正常回应——不是模型、不是提示词，也不是宿主进程坏了。
- `lsof` 显示该会话的 `session.lock` 与日志**没有任何进程持有**，而同时其它 13 个活会话的锁都握在
  宿主 PID 上。也就是说：它不在运行时里。

根因是**删除与恢复不对称**：强制删除把活会话从运行时拿下（`#releaseResidentSession` → `detach()`，
DSH 唯一可用的按 id 释放手段），而恢复只做「文件 rename 回原位 + 记账回位 + 通知客户端」。文件回来了，
活体没有；而 DSH 的活体只能由 `resolve → resume` 建出来，恢复路径里没人发起它。客户端再叠一层：旧
实例带着 `removed` 标记继续存在，`prompt()` 不看这个标记，失败又是静默的（只在 `{ok:false}` 时显示
错误条）。于是用户看到的是「消息发出去了，什么都没发生」。

修法与三条设计决定的理由写在 §5.6；回归测试 `tests/host/restore-revive.test.js`（6 例）加客户端 2 例。
**不可逆的部分**：这次故障发生在修复之前，该会话的恢复动作已经做完——唯一的解法是重启 DSH，让宿主
在启动时重新扫描会话目录。修复只保证**下一次**恢复不再出现这个问题。

### 9.4 客户端三层测试各自负责什么

| 层 | 能发现 | 发现不了 |
|---|---|---|
| `tests/client/bundle.test.js`（桩件） | 模块契约、纯函数的决策逻辑、字典键对齐 | 组件树、事件回调 |
| `tests/integration/render.test.js`（真实 React SSR） | 条件调用 Hook、非法元素/props、渲染期异常 | 任何只在**交互**里才执行的代码 |
| 同文件的「驱动控件」用例 | 事件回调能否改变 store、能否把请求发出去 | 需要真实 DOM 事件的浏览器行为 |

`lib/client.js` 是手写的 lazy-CJS 客户端半，没有构建期类型检查，因此**没有任何工具会在打包或测试时替我们发现悬空引用**，
唯一的防线是「让测试真的去调用它」。

复核同时明确确认**没有问题**的部分（值得记录，避免重复怀疑）：`encode.js` 与上游
`encodeSegment`/`projectKey` 在 543 组对抗输入下逐字节一致；`isInside` 与前缀邻居、`..`、
realpath（含 macOS `/var`→`/private/var`）的判定正确；包含性、符号链接、正则三层守住伪造 id；
`acknowledge` 在包括 `["*"]` 的每条路径上都是必需的；工作区注册表与 `api-session/*` 接缝签名
完全匹配；客户端用到的每个组件与 prop 都真实存在；`defineStore` 覆写 `create` 的做法合法且共享
实例确实到达三个界面。

---

## 10. 关键设计权衡一览

| 决定 | 选择了 | 放弃了 | 理由 |
|---|---|---|---|
| 传输 | HTTP 前缀路由 | 类型化 Remote | Remote 命名空间是构建期装配的，外部插件无法贡献 |
| 删除语义 | 移动目录到回收站 | 直接 unlink | 可恢复；误删是必然会发生的人为错误 |
| 列表来源 | 每次扫描 manifest | 持久化索引 | 消除「索引与实体不一致」这一类数据事故 |
| 定位目录 | 三层回退 + 包含性校验 | 只按公式计算 | 公式是复刻的，可能随上游变化；`locate()` 更权威但非契约 |
| 客户端构建 | 手写懒 CJS | tsdown 打包 | 零依赖、零构建、可直接审阅 |
| 客户端 inject | 空数组 + 响应式获取 | 硬声明服务名 | 硬声明若有一项不匹配会导致整页启动失败 |
| 过期条目 | 只标记，不自动删除 | 自动清理 | 静默销毁用户数据不可接受 |
| 彻底删除门槛 | 确认按钮即同意 + 宿主 `acknowledge` | 只在前端拦 | 前端可被绕过，宿主必须是权威；用户明确要求去掉多一次的勾选 |
| 删除的确认次数 | **单步**（用户明确要求） | 两步确认 | 回收站本身可恢复，因此确认的职责是「讲清后果」而非「多拦一次」；而不可逆的彻底删除由确认弹窗本身承担这次「多看一眼」 |
| 主按钮命名 | 命名**动作**（删除 / 强制删除） | 命名**去向**（移入回收站） | 用户要的是「确认删除」；去向由描述与结果提示说明。这条被要求了两次，因此由测试固定 |
| 驻留会话的删除 | 释放 → 归档 → 有界等待 → **强制完成** | 直接拒绝 | 拒绝发生在工作已被停止之后，等于让用户既丢工作又删不掉 |
| 配置 | 文件 + 宽容读取 | schemastery + 设置页 | 换取零运行时依赖 |
