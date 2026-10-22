# dsh-session-trash

> **DSH 自研插件家族 · [索引与恢复顺序](https://github.com/chuilian/dsh-plugins-infra)**
>
> 本仓库是 6 个自研插件之一：`dsh-genui` · `dsh-prompt-polish` · `dsh-session-trash` ·
> `dsh-artifacts` · `dsh-skill-veil` · `plugin-autoupdate`，全部为 `github.com/chuilian` 下的仓库库。
>
> 换机恢复顺序、profile「四处登记」的规则、以及 `lib/` 为什么必须入库，见索引仓库，本 README 不重复。

> 给 DSH Web GUI 的会话删除功能：**两步确认 + 批量删除 + 可恢复回收站**。
> DSH 本身只能归档会话，无法删除；本插件在不修改 DSH 源码的前提下补上这个能力。

[English summary](#english-summary) · [功能规格](docs/SPEC.md) · [架构设计](docs/ARCHITECTURE.md) · [测试计划](docs/TEST-PLAN.md)

---

## 它解决什么问题

DSH 侧栏的会话菜单只有 **置顶 / 重命名 / 分叉 / 归档** 四项。归档只是把会话移出默认视图，**文件仍然留在磁盘上**，归档列表本身也会不断变长，而且无法真正移除敏感内容。

本插件新增：

- **删除会话**：菜单里的第五项，位置在归档之后，风格与其余四项一致。
- **一次点击即删除**：安静的会话（没在工作、没被运行时占用）连对话框都不弹——点菜单就直接删，结果用可撤销的提示条报告；需要你同意的会话才弹对话框，主按钮叫 **删除**，仍有进行中的工作时变成 **强制删除**，点击后**删除必定完成**。
- **批量删除**：多选、搜索、全选，逐项报告成功与失败。
- **回收站**：删除是「移到回收站」而不是抹除，可随时恢复；侧栏有独立的回收站面板。
- **彻底删除**：只有显式勾选「我了解此操作无法恢复」之后才可执行。
- **审计日志**：删除、恢复、彻底删除、以及每一次拒绝，都留痕。

---

## 这个插件装在哪里

本插件与其他自研插件统一住在 **`~/.dsh/plugins/`**，profile 用 `link:` 直连，不经过任何中间目录：

```
~/.dsh/plugins/dsh-session-trash/                        ← 真实文件 + git 仓（源码即运行代码，无构建步骤）
~/.dsh/profiles/desktop/package.json                     ← 声明 link: 指向上面这个路径
~/.dsh/profiles/desktop/pnpm-lock.yaml                   ← importers 段同步写 link:
~/.dsh/profiles/desktop/node_modules/dsh-session-trash   ← 符号链接 → 上面这个路径
~/.dsh/plugins/dsh-session-trash/              ← 可选入口软链，删掉不影响运行
```

git 仓就住在 `~/.dsh/plugins/dsh-session-trash/.git`，所以「删掉工作区」只删掉入口软链，
插件本体和版本历史都在。2026-10-19 曾在工作区短暂停留一天，当晚搬回 `~/.dsh/plugins/`。

**DSH 自己的备份范围**（`~/.dsh/profile-backups/`）只覆盖 profile 的**配置**：`cordis.yml`、`package.json`、
`pnpm-lock.yaml`、`compatibility.json`。它**不备份** `node_modules`，也不备份任何插件源码 ——
所以插件源码的持久化由 GitHub 仓库 `chuilian/dsh-session-trash` 承担（源码含 `lib/` 全部入库，
克隆下来即可直接运行，无需安装依赖）。反过来，**删掉工作区的软链入口对插件没有任何影响**：
profile 的软链直连 `~/.dsh/plugins/dsh-session-trash/`，不经过工作区。

### 改位置 / 恢复

不要手工建软链 —— 登记分散在四处，漏改任何一处都会在下次 `pnpm install` 时被顶掉。用 infra 仓库的
`relink.sh` 统一改写，`verify.sh` 做 44 项只读复查：

```bash
cd ~/.dsh/plugins/dsh-plugins-infra
./tools/relink.sh --all --dry-run   # 先看要改什么（零写入）
./tools/relink.sh --all             # 真改（自动备份到 ~/.dsh/backups/profile/）
./tools/verify.sh                   # 期望 44 项全 ok
```

工作区换了位置就加 `--workspace <新路径>`；恢复别处丢失的 profile 加 `--profile <名字>`。
换机恢复的完整步骤见 `dsh-plugins-infra/INSTALL.md`。

## 安装

### 前置条件

- DSH `>= 0.2.0-rc.1`（本插件在 `0.2.0-rc.2` / profile `desktop` 上开发与测试）
- Node.js `>= 22.19`（DSH 自带运行时即满足）
- **无需联网**：插件零运行时依赖，宿主端只用 Node 内置模块，浏览器端只用 DSH 平台自带的模块

### 方式一：用 infra 仓库的 relink.sh（推荐，本机唯一可靠路径）

```bash
cd ~/.dsh/plugins/dsh-plugins-infra
./tools/relink.sh --all --to workspace --dry-run   # 先看要改哪四处（零写入）
./tools/relink.sh --all --to workspace             # 真改（自动备份到 ~/.dsh/backups/profile/）
./tools/verify.sh                                  # 42 项复查
```

工作区换了位置就加 `--workspace <新路径>`；换 profile 加 `--profile <名字>`。

> ⚠️ **不要用 `dsh plugin add`，也不要在装完之后跑 `pnpm install`。**
> 本机的插件管理器命令会报 `ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED`
> （`minimumReleaseAge` 策略缺 `no handleResolutionPolicyViolations` 回调），失败发生在写盘之前、
> 零副作用，但它意味着这条路根本走不通。而 `pnpm install` 更危险：它会按 lock 重算
> `node_modules`，把 `link:` 软链顶回 registry 版本 —— `dsh-genui` 真的因此被换回 0.12.0，
> 并被塞进一棵 428MB 的依赖树。

### 方式二：手工编辑 profile（只在你不想用工具时）

编辑 `~/.dsh/profiles/<profile>/package.json`：

```json
{
  "dependencies": {
    "dsh-session-trash": "link:/absolute/path/to/dsh-session-trash"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "...原有的 bundle 保持不变...",
        "dsh-session-trash"
      ]
    }
  }
}
```

**但只改这里是不够的。** `package.json` 之外还必须同步两处，漏任何一处都会被下一次
`pnpm install` 顶掉：

1. `pnpm-lock.yaml` 的 `importers` 段写两行
   `specifier: link:/absolute/path/to/dsh-session-trash` +
   `version: link:<相对 profile 的路径>`
2. `node_modules/dsh-session-trash` 建成指向工作区的**相对**软链

然后重启 DSH。不跑 `pnpm install`。想省事就直接用方式一。

### 安装后验证

1. 刷新页面。
2. 侧栏应出现 **回收站** 入口。
3. 任意会话行的 **「…」菜单** 中应出现 **删除会话** 与 **批量删除会话…**。

若页面显示 "Failed to load plugins"，请参见 [故障排查](#故障排查)。

### 卸载

```bash
dsh plugin remove dsh-session-trash
```

卸载**不会**删除回收站数据。若要一并清理：

```bash
rm -rf ~/.dsh/session-trash
```

---

## 使用流程

### 1. 删除单个会话

1. 在侧栏找到目标会话，鼠标悬停后点击行尾的 **「…」**。
2. 菜单底部点击 **删除会话**。
3. **多数情况下到这一步就结束了**：会话没在工作、也没被运行时占用时，点完菜单就直接删除，右下角提示 **会话已删除**（可撤销）。只有需要你同意的会话才继续弹出对话框——它列出该会话（标题、`运行中`/`已归档`/`已置顶` 标签）、回收站路径，并说明之后可随时恢复。
4. 点击主按钮，**一次点击即完成删除**：

   | 情况 | 按钮 |
   |---|---|
   | 没有进行中的工作 | **删除** |
   | 仍有进行中的工作，或会话仍被运行时占用 | **强制删除**（按钮上方会先说明「会先停止这些工作，被停止的工作不会自动继续」） |

   没有「下一步」这一步：弹窗就是确认，点一下即删除。
5. 会话立即从侧栏消失，右下角提示 **会话已删除**，并带 **撤销** 与 **查看回收站**。

> **关于「强制删除」**：点击之后删除一定会完成——插件会先停掉工作、把会话归档以让运行时放手、等待其释放，若仍未释放则强制完成。**它不会出现「工作被停了但会话没删掉」的情况。** 强制完成时，提示条、审计日志与回收站记录里都会标明 `forced`。
>
> **强制删除后侧栏可能短暂留一行。** 原因是 DSH 的会话列表把**驻留内存**的会话也算进去，而 DSH 全产品没有「按 id 释放一个会话」的接口，所以当运行时不肯放开它时，文件进了回收站、内存里的会话对象还在，宿主仍会列出它。插件的处理是：
> - 这一行**保持归档**（默认视图下归档会话是隐藏的），所以你看不到它；
> - **不会**把它从原工作区挪走，因此它不会跑到「未分组」里；
> - 你在回收站里**恢复**它，就一切回到正常（文件回来，它也能正常打开）；
> - **重启 DSH 后它彻底消失**（进程重启后内存里不再有它）。
>
> 如果侧栏出现了标着 **已删除** 的残留行，它同样**可以勾选并删除**：没有文件可移动时，删除的含义就是「把它从列表里拿掉」（同理，它会保持归档，重启 DSH 后彻底消失）。
>
> **关于「当前打开的会话」**：会被删的会话如果正是你在看的那个，插件会先把视图切到另一个会话（没有其他会话时就释放当前视图），这是为了让运行时能放开它。你不需要自己先切换。

### 2. 批量删除

1. 在**任意**会话的「…」菜单中点击 **批量删除会话…**（位于菜单最后，上方有分隔线）。
2. 对话框列出全部可删除的会话，**默认全不选**：
   - 顶部搜索框可按**标题或会话 id** 过滤；
   - **全选** / **取消选择** 一次性操作；
   - 右侧实时显示已选数量；
   - 空会话（未发过消息）与子代理会话不出现在列表中——它们不是你要删的「对话」；
   - 无法删除的会话仍会列出并标注原因（如 `目录无法确认`），但**任何会话都可以勾选**——能不能删由你决定，宿主只会逐项给出结果；列表里已经没有文件的会话会被**清出列表**（而不是被拒绝或被灰显挡掉）。
3. 勾选目标后点击 **删除**（或 **强制删除**）——同样是一次点击完成。
4. 结果逐项处理：**部分失败不会影响其余成功项**，提示条会说明失败数量与具体原因。

单次**请求**上限默认 100 个（可配置，见[配置](#配置)）——但这只是请求层的护栏，不是你能选的上限：选了多少就删多少，插件会自己按上限切成多批发送。

### 3. 从回收站恢复

**方式 A：用提示条撤销（最快）**

删除后提示条上的 **撤销** 即恢复刚删除的内容。

**方式 B：回收站面板**

1. 点击侧栏 **回收站** 入口。
2. 面板顶部显示条目数与占用空间；每条显示标题、删除时间（如 `12 分钟前`）、大小、原工作区路径。
3. 恢复方式：
   - 单条：点击该行右侧的 **恢复** 图标按钮；
   - 多条：勾选若干条后点击 **恢复选中**。
4. 恢复后会话回到**删除前的原始绝对路径**，内容逐字节一致，并重新出现在侧栏与会话列表中。
   若删除前该会话处于**已归档**或**已置顶**状态，恢复会一并还原这两个状态（删除时它们被移除了）——所以一个原本归档的会话恢复后会回到「显示已归档」视图里。

> **如果原路径已被占用**（例如删除后又创建了同名会话），该条目的恢复会被**拒绝**，并保留在回收站中——插件绝不覆盖或合并两个会话目录。你可以先把占用该路径的会话处理掉，再回来恢复。

### 4. 彻底删除（不可恢复）

1. 打开 **回收站** 面板。
2. 勾选要永久删除的条目，点击 **彻底删除**；或点击 **清空回收站**。
3. 弹窗说明将永久删除的数量与占用空间，并声明**此操作无法撤销，会话文件会被直接抹除**。
4. 必须勾选 **我了解此操作无法恢复**，**确认彻底删除** 按钮才会变为可用。
5. 未勾选时**不会发出任何请求**；即使绕过界面直接调用接口，宿主端也会拒绝（HTTP 428）。
6. 成功后提示释放的字节数。

> 保留期（默认 30 天）只用于在面板上标记「已超过保留期」并给出计数。**插件不会自动删除到期条目**——静默销毁数据不是可接受的行为。

### 5. 查看操作日志

回收站面板底部展开 **操作日志**，显示最近 50 条记录。完整日志在：

```
~/.dsh/session-trash/logs/trash-<YYYY-MM-DD>.ndjson
```

每行一条 JSON，包含时间、操作（`trash` / `restore` / `purge` / `delete`）、结果（`ok` / `refused` / `failed`）、会话 id、回收站 id、原因码与操作者标签。

---

## 配置

所有配置写在 profile 的 `cordis.patch.yml`：

```yaml
- id: session-trash
  name: 'dsh-session-trash'
  config:
    enabled: true
    root: /~/.dsh/session-trash
    retentionDays: 30
    maxBatch: 100
    quickDelete: true
    actor: session-menu
```

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉后不注册任何路由（界面入口随之失效） |
| `root` | `<DSH_HOME>/session-trash` | 回收站根目录。**不要**放在 `<DSH_HOME>/sessions` 之内，否则会被会话定位器的扫描层看到（插件会就此告警）。**仅在插件挂载时读取一次**，改完需要重启 DSH 才生效（路由会就此告警一次） |
| `retentionDays` | `30` | 超期**标记**窗口。`0` 表示关闭该报告。**不会自动删除** |
| `maxBatch` | `100` | 单次**请求**的批量上限（硬上限 1000）；界面会自己切批，不作为「能选多少」的上限 |
| `quickDelete` | `true` | 安静的会话点菜单即删、不弹对话框。设为 `false` 则恢复「每次都要在对话框里点一次」的旧流程 |
| `actor` | `session-menu` | 审计日志中的操作者标签 |
| `trustedHosts` | `[]` | 额外的非回环受信 authority（会与 `ctx.get("connection").trustedHosts` 合并）。默认只允许本机访问 |

> 本版没有图形化设置页：这会引入一个运行时依赖，与「零依赖、安装即用」的目标冲突。配置改完需让 profile 生效（DSH 的配置 HMR 通常使其立即生效，否则重启）。唯一的例外是 `root`：回收站目录在插件挂载时就固定了，改动它必须重启 DSH。

---

## 数据与安全

### 删除到底做了什么

```
删除一个会话 =
  1. 把 <sessions>/<工作区key>/<会话id>/  整个目录
     移动到  <回收站>/items/<trashId>/payload/
  2. 写入 manifest.json（原路径、标题、工作区、删除时间、文件清单与字节数）
  3. 从 DSH 自己的记账中移除该 id（归档集合、置顶集合、工作区会话列表）
  4. 通知所有已打开页面把该行从列表移除
  5. 追加一条审计日志
```

**在第 1 步之前，插件会拒绝所有不该删的情况**，被拒绝的请求不会碰到文件系统。

### 会拒绝的情况

| 情况 | 结果 |
|---|---|
| 会话仍在运行（有进行中的工作） | 拒绝，列出具体工作；需明确选择「停止工作并删除」 |
| 会话仍被当前页面打开/驻留内存 | 拒绝或先等待其释放；超时则提示先切换离开 |
| 会话目录不存在 | 拒绝，不会臆造路径 |
| 会话目录是符号链接 | 拒绝（避免把链接指向的别处目录搬走） |
| 解析出的路径落在会话仓库之外（含符号链接指向外部） | 拒绝，返回 `unsafe-location` |
| 回收站条目没有 manifest（中断的删除） | 可彻底删除，但不可恢复（返回 `no-manifest`）；会作为「损坏项目」计数显示 |
| 会话 id / 回收站 id 不符合严格格式 | 拒绝 |
| 恢复时原路径已被占用 | 拒绝，回收站条目保留 |
| 彻底删除未显式确认 | 拒绝 |

### 崩溃安全性

移动会话目录使用 `rename(2)`（同一文件系统上原子）。manifest 会在移动**之前**先写入「从哪来」，移动成功后再补全文件清单。因此断电/崩溃后只可能处于两种可自愈状态：

- 会话**原封未动**；
- 会话**已在回收站**，回收站面板打开时会自动补全记录。

跨磁盘（回收站与会话仓库不在同一文件系统）时，先复制到 `payload.tmp` 再原子改名为 `payload`，最后才删除源目录——**永远不会出现「复制了一半」的 payload**。

`rename` 是**提交点**：在它之后，任何收尾失败（跨磁盘时源目录没删干净、某个子目录读不动导致清点失败）都只会记一条警告与审计，而**不会**让删除报失败——否则回滚就会删掉唯一一份完整副本。若源目录没能删干净，日志里会有 `sourceLeftover` 指向残留路径。

### 谁能调用删除接口

删除接口只接受三类调用者，规则与 DSH 自身的 `/api` 桥一致：

1. **本机**请求（`localhost` / `::1` / 整个 `127.0.0.0/8`）；
2. 本部署声明的**受信主机**（DSH 的 `trustedHosts`，可用本插件的 `trustedHosts` 追加）；
3. 且 `Sec-Fetch-Site` 不是 `cross-site`、`Origin` 缺省或同源。

这三道闸门分别挡住 DNS rebinding、其他站点的页面、以及跨源伪造。默认只允许本机访问。

### 审计

所有变更与拒绝都写入 NDJSON 日志。主机名只记录 SHA-256 前 12 位，避免日志本身泄漏机器标识。回收站目录权限 `0700`，manifest 与日志 `0600`。本插件不采集、不外发任何遥测。

### 明确不做的事

- **不做「安全擦除/加密粉碎」**。在 SSD/APFS 上这无法可靠实现，承诺它等于给出虚假的合规保证。本插件只保证文件被移除。
- **不自动清理过期条目**。
- **不删除工作区**（DSH 已内置该功能）。

---

## 故障排查

### 侧栏出现一行「已删除」的残留会话

这是**已经删掉**的会话。它的文件在回收站（或已经彻底不在），只是运行时在本次进程中还持有那个会话对象，DSH 就会继续把这一行列出来（DSH 没有「按 id 释放会话」的接口，插件无法强制它从内存消失）。

- 它**仍然可以被勾选和删除**：没有文件时，删除的含义就是**把它从列表里拿掉**（宿主会把它归档隐藏、并通知各客户端这行已经离开）。提示条会如实说「只从列表里移除了」，不会谎称移入回收站；
- 它已经被**归档隐藏**，默认视图里通常看不到；
- 想彻底清掉这一行：**重启 DSH**（内存里的对象随进程消失）；
- 想让它回来继续用：在回收站里点**恢复**，文件会回到原位。


**页面显示 "Failed to load plugins"，或侧栏/菜单里没有我的入口**

1. 确认包已启用：检查 profile 的 `package.json` 中 `dsh.profile.bundles` 是否包含 `dsh-session-trash`。
2. 若整页启动失败，通常是 bundle 未正确加载或某个 entry 未激活：
   - 查看浏览器控制台与宿主日志中的 `client-modules` / `web boot` 报错（`web boot: N entries did not activate …` 会点名是哪个 entry）；
   - 临时从 `dsh.profile.bundles` 中移除该包并重启，即可回到干净状态。
3. 本插件的客户端 `inject` 为空数组，服务全部在 `ctx.inject` 作用域内获取（这是硬要求：Cordis 会门禁未声明服务的属性访问，越界读取会让 entry FAILED 并拖垮整页启动）。

**菜单里没有「删除会话」**

- 该入口注册在 `sidebar.workspaces.session.menu.item` 槽位。刷新页面（客户端插件在页面刷新后加载）。
- 若 DSH 版本较新且改名了该槽位，入口会静默缺席而不会报错——此时请看浏览器控制台是否有槽位相关警告。

**删除被拒绝，提示"仍处于打开状态"**

- 该会话在当前页面仍是活动的。切换到另一个会话（或删掉别的会话）后重试；插件随后会等待它释放。
- 你正在查看的会话需要先失焦，这是为了避免运行中的会话在文件被移走后重建残缺日志。

**恢复失败，提示原路径已占用**

- 删除后又在同一工作区创建了会话，占用了原目录。先处理占用方，再恢复；回收站条目不会因此丢失。

**回收站面板打不开**

- 面板依赖 `layout` 服务。缺少它时，菜单删除与会话撤销仍然可用（这是有意的降级设计）。

**删除被拒绝，提示某会话「无法删除」**

- 未找到会话目录（`not-found`）：这种情况**不会**再被拒绝——列表里已经没有文件的会话会被**清出列表**（提示条会说「只从列表里移除了」）。若你看到这条旧的拒绝信息，说明宿主进程还在跑旧代码，重启 DSH 即可。
- 提示 `unsafe-location`：会话存储报告了一个落在会话仓库之外的路径。这是包含性失败，出于安全考虑一律拒绝；请检查会话存储配置。

**日志**

```
~/.dsh/session-trash/logs/trash-*.ndjson   # 插件审计
```

---

## 开发

```bash
cd "~/.dsh/plugins/dsh-session-trash"

# 全部测试（137 个必测项，无需 npm install；串行执行以保证确定性）
node --test --test-concurrency=1 "tests/host/*.test.js" "tests/client/*.test.js" "tests/integration/*.test.js"

# 仅宿主 / 仅客户端
node --test --test-concurrency=1 "tests/host/*.test.js"
node --test --test-concurrency=1 "tests/client/*.test.js"
```

**没有构建步骤**：`lib/**` 既是源码也是安装后实际运行的产物。宿主端是普通 ESM；客户端 `lib/client.js` 是手写的 DSH 懒 CJS 方言（`window.__ModuleLoader__.load({id, factory})`），只 `require` DSH 平台冻结模块表中的 `react`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-store`。

### 目录结构

```
dsh-session-trash/
├── package.json            # 双面插件清单（dsh.bundle.patch / dsh.client）
├── cordis.patch.yml        # bundle 补丁：插入插件行 + 配置示例
├── icon.svg
├── lib/
│   ├── index.js            # 宿主插件入口：宽容读取配置、装配、注册路由
│   ├── host/
│   │   ├── encode.js       # 逐字节复刻后端的 encodeSegment / projectKey
│   │   ├── locate.js       # 三层会话目录定位 + realpath 包含性校验
│   │   ├── trash-store.js  # 回收站：原子移动、manifest、自愈、审计日志
│   │   ├── service.js      # 安全守卫、记账清理、批次语义
│   │   ├── access.js       # loopback / 配对设备访问控制
│   │   └── routes.js       # /session-trash HTTP 接口
│   └── client.js           # 浏览器端：菜单项、两步确认、批量、回收站面板、样式
├── tests/
│   ├── host/               # 115 个（含 regressions.test.js：复核缺陷的回归测试）
│   ├── client/             # 22 个
│   └── integration/        # 4 个（真实 React：SSR 不抛 + 代真实点击驱动控件，需要时自动跳过）
└── docs/
    ├── SPEC.md             # 功能规格说明书
    ├── ARCHITECTURE.md     # 架构设计与技术方案
    └── TEST-PLAN.md        # 测试计划与执行结果
```

---

## English summary

DSH can archive a session but cannot delete one: the persistence seam exposes only
create/open/stat/list/flush, and no product package removes a stored session. This plugin
adds deletion without patching DSH.

- **Host half** (`lib/index.js`) registers one `/session-trash` HTTP prefix route and owns a
  crash-safe recycle bin: it *moves* a session's own directory into the bin with a manifest that
  makes the move reversible byte-for-byte, then drops the id from DSH's durable accounting.
- **Client half** (`lib/client.js`) adds a `删除会话` row (order 500) and a batch row (order 600) to
  the `sidebar.workspaces.session.menu.item` slot, a one-click confirmation dialog in
  `shell.overlay`, a `回收站` sidebar entry and main panel, token-based CSS, and an undo flow. The
  dialog releases the view's reference to the target first, because a session a view still holds
  cannot be disposed by the host.
- **Safety**: it refuses to move a directory a live writer may still own *unless the user has
  consented to stopping that work* — and once they have, the delete always completes (stop →
  archive to release → bounded wait → force, all recorded). It refuses symlinks and any path
  outside the session store, never overwrites on restore, requires an explicit acknowledgement to
  purge, audits every mutation and refusal to an append-only NDJSON log, and never stops a user's
  work and then refuses to delete.
- **Zero dependencies, no build step.** 137 tests run with `node --test` alone, plus a
  render check against real React 18 (self-skips when React is absent; 140 total with it).

## License

MIT
