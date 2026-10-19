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
   （uiWorkspace.openSession / clearMain）。释放引用是客户端的能力，不是用户的操作要求。
2. 宿主停止进行中的工作 —— 复用 workspaceRegistry.stopSessionActivity
   （归档流程用的同一条接缝，内部派发 workspace/session-stop 并行事件）。
3. 宿主归档该会话 —— 复用 DSH 自己的 archiveSession(sessionId, { stopActivity: true })。
   归档是「让运行时可以放手」的机制：它门禁所有唤醒，并让持有主引用的客户端释放引用，
   于是运行时 dispose 会话、关闭持久化写句柄。
4. 有界等待其离开内存（≤15 秒，夹取在服务层）。
5. 仍未离开 → 若调用方传了 force，**照样移动**，并把 forced: true 记进 manifest、审计日志与提示条。
6. 若移动最终失败，回滚第 3 步写入的归档，绝不让用户看到一个自己没归档却被隐藏的会话。
7. 记账收尾：干净删除 → 移除归档 id；强制删除 → **保留**归档 id（这是唯一能隐藏残留行的状态）。
   两种情况都**不做 detach**，因为 detach 会把残留行推进「未分组」。详见 §5.2。
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

**② 强制删除后**保持归档**。**
强制删除是唯一会出现「文件已移走、运行时仍持有该会话」的情形。DSH 的会话列表把**活的**会话也算进去（`dsh-session-query` 的 `listSessions`：`records.set(session.id, {live:true})`），而全产品**没有任何 dispose-by-id 接口**（`SessionStore` 只有 `create/prepare/enter/detachEntered/announce/emitDisposed/flush/get/list/fork`，`detachEntered` 需要内部 entry；客户端的 Remote 会话 API 也只有 `list/search/create/rename/fork/prompt/cancel/…`）。因此这个残留行会一直存在到**进程重启**为止，而**归档是唯一能隐藏它的状态**（`case "default": return !archived.has(id)`）。

反过来说：非强制（干净）删除时，会话已被 dispose，宿主不会再列出它，残留不可能存在——所以那时**必须** unarchive，否则一个已删除的会话会莫名其妙留在「显示已归档」里。

| 删除类型 | 归档集合 | detach | 结果 |
|---|---|---|---|
| 干净（会话已释放） | **移除** id | 不做 | 行彻底消失 |
| 强制（运行时仍持有） | **保留** id | 不做 | 行被默认过滤器隐藏；重启后彻底消失 |

配套的 UI 处理：宿主 `plan` 对「列表里有、磁盘上没有」的会话返回 `not-found`，客户端把它显示为**已删除**（而不是「不可删除」），并且**不计入**「无法删除」的计数——否则用户会以为自己的删除失败了。

**③ 无文件的会话可以被删（清出列表），不是「删不掉」。**
`not-found` 只是「没有目录可移动」，它不等于「不能删」。宿主的 `#clearFileless` 把它走成一条独立的成功路径：需要同意时先停工作、驻留时归档隐藏、`emit "api-session/removed"`，审计记 `delete:cleared`，返回 `{ok:true, cleaned:true, trashId:null}`（没有回收站条目，因此 UI 的**撤销**不会为它出现，提示条也如实说「只从列表里移除」）。仍然被拒绝的只有两件：无法安全确认的路径（`unsafe-location` / `invalid-session-id`）与未经同意的 `session-active` / `session-live`——而拒绝也带着 `code`/`message` 回到界面，不用 `disabled` 控件替用户做决定（FR-2.9）。残余风险：若文件其实存在、但三层定位都没找到（目录名非标准且后端也报不出路径），清出列表不会搬走它们——这是既有的定位盲区，`totalBytes: 0` 与「只从列表里移除」的措辞都不会谎称已经移入回收站。

### 5.3 通知客户端

- 删除后 `ctx.emit("api-session/removed", id)`：所有已连接客户端把该行从列表移除（这是会话控制器自己在 `session/disposed` 时用的同一个事件）。
- 恢复后 `ctx.emit("api-session/added", summary)`：summary 取自 `ctx.sessionController.listState.list()`，即 DSH 自己的列表构造器，不自行拼装。
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

### 5.6 预检（`plan`）的成本：并发做，别做没人看的事

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
| GET | `/session-trash/list` | — | `{ok, value:{items,broken,stats}}` |
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
  （`max(配置 maxBatch, 500)`）。变更动作（`delete`/`restore`）仍受 `maxBatch` 约束——但那个约束现在由
  客户端**切成多批**来满足，而不是让用户撞上 `batch-too-large` 的死胡同（见 7.5）。
- `plan` 的返回体顺带带上 `root` 与 `maxBatch`：对话框描述需要的回收站路径、以及客户端切批要用的批大小，
  一次往返就够。旧版宿主半不返回这两项时，客户端退化为单独一次 `GET /status`（两半是分开热更新的）。
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
| `sidebar.panellist` | `session-trash` | 50 | 侧栏「回收站」入口（图标 + label） |
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
  purge:  null | { trashIds, count, bytes, acknowledged, pending, error },
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

**回收站恢复**：面板选中条目 → 「恢复选中」→ `POST /restore` → 刷新面板与会话列表 → Toast 报告恢复数量。原始路径被占用时该项返回 `occupied`，其余照常，条目保留在回收站。

**彻底删除**：面板 → 「彻底删除」/「清空回收站」→ 弹窗需勾选「我了解此操作无法恢复」→ `POST /purge`（带 `acknowledge: true`）→ 释放字节数写入 Toast。UI 未勾选时**根本不发请求**，宿主端即使收到请求也会以 428 拒绝。

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
| 21 | **高（用户实测报告）** | 在「工作」项目里删除一个会话后，它出现在了**未分组**里，而且再也删不掉（显示「不可删除」）。取证：`plan` 返回 `resident: true, exists: false`；manifest 记录 `forced: true` | 根因是**强制删除会留下活的会话对象**：DSH 的 `listSessions` 把 live 会话也算进列表，而全产品没有 dispose-by-id 接口，所以文件没了行还在；**再叠加我的 detach**，这行就正好落进「未分组」（该桶的定义就是「列表里有、没有 workspace 认领」）。修复：① 绝不 detach；② 强制删除**保持归档**（归档是默认过滤器下唯一能隐藏一行的状态）；③ 列表里无文件的会话在 UI 上显示为**已删除**而不是「不可删除」，且不计入失败数。回归测试 R21–R24 |
| 22 | **高（用户实测报告）** | 删掉整个工作区后残留的会话落进「未分组」，批量删除时**勾不上**（复选框灰显）。取证：`plan` 返回 `deletable:false, exists:false, resident:true, archived:true, code:'not-found'`；用户原话「所有的删除应该由我决定能不能删，而不是直接把这个决定给定死」 | 两处都把决定权拿走了：① 客户端 `disabled: !deletable` + `全选` 过滤，而 `deletable` 只表示「磁盘上有目录」；② 宿主 `#deleteOne` 在 `!located.ok` 时直接拒绝，`not-found` 没有任何出口。修复：取消所有勾选门禁（禁用条件只剩「一个都没选」）、提交全部选中项、宿主新增 `#clearFileless` 把无文件的行**清出列表**（停工作需同意 / 归档隐藏 / `emit removed` / 审计 `delete:cleared` / 返回 `cleaned:true`），提示条不再对这类行说「已移入回收站」。安全边界保留为**带原因的拒绝**（`unsafe-location`、未经同意的 `session-active`/`session-live`），而不是灰按钮。回归测试：宿主 `a delete of a missing session clears the row…`、`a delete of a fileless resident session hides it…`、`a fileless session still needs consent…`，客户端 `canAdvance` / `buildDeletePayload` / `trashIdsOf` |
| 23 | **高（用户实测报告）** | §5.9 的门禁修好、重启 DSH 后，用户报告**勾选依然完全无效**：复选框已不灰显，但「已选择」永远是 0。取证：`dsh-client-ui-primitives` 的 `Checkbox({checked, onChange, label, disabled})` 用法正确；`lib/client.js` 的 `DeletePickStep` 三处（勾选 / `全选` / `取消选择`）调用了**未声明的裸函数** `patchDialog(...)`——该名字只存在于 store action 上，模块里从未定义 → 每次点击抛 `ReferenceError: patchDialog is not defined`（从 1.0 起就存在，与本轮门禁无关） | 三处改为 `storeInstance.actions.patchDialog({...})`（`lib/client.js:698/727/731`）。回归护栏：渲染层改为**驱动控件**（记录 Checkbox/Button 的 props 并代真实点击），断言选中状态、`/session-trash/delete` 的请求体与撤销项；改回裸调用即以 `ReferenceError` 失败。另加全模块裸调用扫描，确认没有第二处悬空引用 |

> **为什么 SSR 测试抓不到它**：服务端渲染只执行渲染路径，点击处理器一次都不会被调用。类缺陷只能靠
> 「调用它」的测试来发现——这也是 TEST-PLAN §5.10 新增那层测试的唯一目的。

### 5.10 客户端三层测试各自负责什么

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
| 彻底删除门槛 | UI 勾选 + 宿主 `acknowledge` | 只在前端拦 | 前端可被绕过，宿主必须是权威 |
| 删除的确认次数 | **单步**（用户明确要求） | 两步确认 | 回收站本身可恢复，因此确认的职责是「讲清后果」而非「多拦一次」；而不可逆的彻底删除仍然保留勾选门槛 |
| 主按钮命名 | 命名**动作**（删除 / 强制删除） | 命名**去向**（移入回收站） | 用户要的是「确认删除」；去向由描述与结果提示说明。这条被要求了两次，因此由测试固定 |
| 驻留会话的删除 | 释放 → 归档 → 有界等待 → **强制完成** | 直接拒绝 | 拒绝发生在工作已被停止之后，等于让用户既丢工作又删不掉 |
| 配置 | 文件 + 宽容读取 | schemastery + 设置页 | 换取零运行时依赖 |
