# better-dsh-session-deletetool

> **本地派生版。** 上游原版是 [Lzcdebear/better-dsh-session-deletetool](https://github.com/Lzcdebear/better-dsh-session-deletetool)（npm 同名包），本目录是它的一个 fork：0.5.2 及之前的条目属于上游，0.6.0 起是本地改动。作者栏保留原作者署名，本地改动不享有他的署名。
>
> 装法是 profile 的 `link:` 本地路径依赖，DSH 的插件管理**没有任何更新动作**（只有 list / set / install / remove），所以**这个版本不会被覆盖**。唯一会顶掉它的情况是自己对这个插件重装、且 spec 写成 npm 上的同名包名——别那么做。

**真正删除 DeepSeek Harness 里的会话 —— DSH 自带的能力只有归档。**

[English](README.md)

---

## 为什么需要它

DSH 只能**归档**会话：归档把那一行从侧边栏隐藏，工件一样不动，日志、工程记录、投影缓存都留在磁盘上，随时可以恢复。持久化接口本身根本没有删除能力，`@deepseek-ai/dsh-session-persistence-jsonl` 写得很直白：

> **Nothing deletes session files** —— 日志在 `root` 下不断堆积，直到被外部删除；这一层没有删除接口。

于是用得越久，会话只增不减。这个插件补上缺失的那一步：在会话的 `⋯` 菜单里加一项**删除会话**，真的把数据抹掉；它弹出的确认框也是唯一能看清一个会话全家结构的地方。

**入口只有一个。** 没有侧栏按钮、没有批量删除入口：会话的 `⋯` 菜单里那一项就是全部，删除和清理磁盘占用都在它打开的同一个对话框里。批量删除做过，然后撤掉了——它删不掉正在占用中的会话，得等 DeepSeek 退出才生效，期间那一行还挂在列表里，而退出才能清理这件事本身就说明它没有真正解决问题。一个一个删，每个都删得干净。

## 删了什么

对选中的会话，宿主半会：

1. **删掉会话工件目录** —— 当前日志、保留的每一代历史格式、以及目录里的会话本地文件（路径由 `ctx.sessionPersistence.locate(header)` 给出）；
2. **删掉你勾选的子会话** —— 子会话是各自独立的 session，各有各的日志。DSH 把每个子会话的父 id 记在它自己的 header 里（`SessionHeader.parentSession`），而且它创建的每种关系都写这个字段：子智能体由运行时写入并带 `origin: 'subagent'`，fork 出来的对话写入并带 `isSeeded`，Agent Teams 的名册也靠同一个字段解析。插件按这条血缘广度优先遍历，再与持久化的 `subagentCatalog` 投影（`ctx.subagents.listDescendants`）取并集，因此连 header 已经读不出来的子会话也能被点名。删除**从最深的往下**，集合在动手之前先收集完，一次最多删 200 个，而且只删勾上的那些；
3. **摘掉工程记录** —— 每个 id 从每个 Workspace 记录的 `sessionIds` 里移除（`Workspace.detachSession`），并从注册表全局的归档集合、置顶集合里移除；
4. **删掉投影缓存** —— `session_projcache` 域里的记录和磁盘上对应的 `<id>.json`；
5. **关掉它拥有的终端** —— `ctx.terminals` 不属于任何一条准入族，服务要等 Agent 被释放才回收，而那时日志早就没了；
6. **通知页面** —— 每个被删的 id 各发一次 `api-session/removed`，这是官方会话控制器销毁会话时发的同一个事件，侧边栏的行会立刻消失；
7. **清掉页面自己的残留** —— 客户端半删掉官方按会话 id 键控的草稿与面板布局（`dsh.conversation.<id>`、`dsh.sidebar-right.v1.<id>`、`dsh.sidebar-browser.v1.<id>`、`dsh.user-questions.drafts.v1.<id>`、`dsh.schedule.task-tab.v1.<id>`）。只有页面能碰 `localStorage`，所以这一步由它做；`dsh.sessions.current` 这类全局键**从不**触碰。

### 真正释放磁盘空间，而不只是删掉那一行

删日志从来不是全部，因为最占地方的字节是**共享的**和**派生的**。在上面这些删除之后，宿主半继续回收：

8. **没有任何会话再引用的附件对象** —— `~/.dsh/attachments/v1/**` 是内容寻址、按内容去重的仓库，没有索引、没有引用计数；官方包自己写明「没有任何东西会回收未被引用的对象」。插件自己算这份引用计数：读每个会话日志，**结构化地**收集 `attachmentId` 字段，只有当**存活的**日志都不再引用某个 blob 时才 unlink。两个会话共享的 blob 会被保留，并在报告里标为 kept。结构化读取不是优化：blob 的哈希也会原样出现在消息正文和工具输出里，grep 它会报出不存在的引用。日志还是**一串独立的 zstd 帧**，所以读取器要按帧偏移逐帧解压——把整个文件当单流解压只会得到第一帧；
9. **provider 上传缓存** —— `~/.dsh/llm-deepseek/files-v3.json` 记录附件对应的 DeepSeek 侧 file id。它不是按会话键控的，所以按「引用已悬空」和「已过期」裁剪，**绝不**按会话删；
10. **派生的搜索索引** —— 删掉被删会话的行，然后压缩文件。删行不会让 SQLite 文件变小，字节还留在 freelist 里，要 `VACUUM` 才还回来。索引用引擎自己的 `application_id` 定位，属于别的应用的库**绝不**打开。（本 profile 把引擎配成 `path: ':memory:'`，所以一般根本没有这个文件；这一步是为配了持久路径的部署准备的。）
11. **存活会话里陈旧的检查点** —— 父会话的投影缓存里嵌着子会话的 id，删掉子会话会让父会话继续宣称一个已经打不开的会话；
12. **崩溃残留的暂存文件**（`attachments/v1/tmp`）与**陈旧的 Workspace 备份** —— `~/.dsh/storages/` 下原子发布留下的备份里仍然写着已删除的会话 id，而这正是「彻底删除」所指的残留。

确认框会在你确认**之前**就报出这个数字，删除成功后对话框报出实际回收的字节数。

### 清理磁盘占用：同一个对话框的下半部分

一次删除只带走**这个会话独占**的字节：一张同时贴在两个对话里的图，删掉其中一个会保留它（报告里标为 *kept*），删掉最后一个才释放。更早的删除、或者崩溃留下的东西——没有任何日志再引用的附件、发布失败的暂存文件、过期的上传缓存记录、还写着已删会话 id 的陈旧备份——**一次删除不知道它们的存在**，所以确认框的下半部分就是**清理磁盘占用**：

- 打开对话框时它就自己扫描一遍（`dryRun`），**先报数字再动手**，和删除预估是同一条规矩；
- 按来源分行列出：无引用的附件、残留临时文件、过期的上传缓存、可压缩的搜索索引、陈旧备份；**没有内容的行不出现**，不会摆一排零；
- **立即清理**按下才真的删，按完报出实际释放了多少；**重新扫描**只报告不动手；
- 它**从不删除任何会话**：子智能体和派生对话是没有被任何 Workspace 记录列举的合法会话，只有一次删除才知道哪条血缘要走了；
- 删除正在跑时它整套控件是禁用的——两件事不能读成一下按键。

所以侧栏底部**没有任何属于这个插件的控件**：入口是会话 `⋯` 菜单里那一项，删除和清理都在它打开的同一个对话框里。

### 看清家族，再选择删什么

侧边栏里，子智能体和派生对话都是各自独立的一行，看不出是谁生的，DSH 本身也没有任何地方画这条关系。这个确认框是唯一画出来的地方：整个家族画成**一棵树**，包括派生对话自己带出来的下一层。

- 第 1 行是**本对话**，它的勾选框管整个家族，名字跟侧边栏显示的一致；
- 第 2 行是一个**可折叠的「子智能体（n）」分支**，装本对话自己生的子智能体；
- 第 3 行是一个**可折叠的「派生对话（n）」分支**，分支里每个派生对话自带它自己的「子智能体（n）」子分支，所以**派生对话的派生对话画在父辈块里面**（缩进多一格），而不是跟它并排；
- 子智能体自己派生出来的对话，同理画在那个子智能体的块里面；
- 每行都有勾选框，标出名字和 id 尾号，还开着的或还有工作没跑完的会带状态标记；名字跟侧边栏同一套规则：日志里有名字用名字，没有就用它项目目录的末段，再没有才用 id，所以不会显示成"未命名"；
- 层级只靠**缩进**表达：一级缩进一格、二级两格，父行后面紧跟它自己画出来的子行，所以第 3 层那行一眼能看出是挂在上面第 2 层那行下面，而不是"反正更深一点"。

每行的勾选框管**它自己那棵子树**：下面全都勾上时它是勾上的，只勾了一部分时显示成半选，按一下整棵子树一起勾或一起取消；分组标题的勾选框管这个分组列出的所有行。删除集合只存这一份 id，不再有"选中的根 + 排除的子行"两套状态，所以底部的计数不会和画面对不上。

读不到的血缘会写在列表上方（比如某个分支的目录打不开），而不是静默少几行——少行和"这个会话确实没有子会话"原来长得一样。

确认时只提交勾上的 id，按钮上写着即将删掉几个会话。没勾的子会话会作为独立的会话根留下来。选择会在宿主侧拿它自己走出来的血缘做校验，请求只能点到这个家族里的会话。fork 出来的对话本身也是独立会话，所以它是"带勾选框列出来"，而不是被静默带走。

### 什么会拦，什么不会

**只有"还有工作在跑"会拦，"还开着"不会。** 门槛用的是 DSH 自己归档时的那条 `workspace/session-activity` 瀑布：Agent 注册表报进行中的回合，后台任务注册表报后台任务，子智能体运行时报运行中的子会话，定时提醒报生效中的任务。这个询问是**对删除集合里的每一个会话各问一次**，因为这条准入是按被问的会话作答的：只问目标的话，子会话正在跑的回合或后台任务根本不会出现。确认框会把还在跑的东西写在对应行上、也写在汇总里，并提供**停止并删除**——先对每个忙碌的会话派发一次 `workspace/session-stop`，和 `archiveSession(id, { stopActivity: true })` 完全一致。

宿主内存里还持有这个会话（`ctx.sessions` / `ctx.agents`）时照样删。本机实测（Windows）：文件句柄还开着时 `rm` 依然成功，目录项立刻消失，之后的写入落进已删除的文件而不是把它复活。早先的版本会拒绝这种会话并提示"先切换到别的会话"，结果把没显示在窗口里的会话也一起误伤了，那条规则已经去掉。

### 已知边界

- **只有「没有存活日志引用」的 blob 才会被回收。** 这是正确规则，不是缺陷：附件按内容寻址，同一张图粘进两个对话在磁盘上就是一个 blob。删掉其中一个会保留它并标为 *kept*；删掉最后一个才释放。没有任何引用的 blob 由同一个对话框里的**清理磁盘占用**回收。
- **回收是尽力而为。** 它在会话已经删完之后才跑，所以那一步失败只会记进 `warnings`，绝不让删除本身失败——剩下的字节是浪费的空间，不是丢失的数据。
- **会话仍被占用时可能留下一条死缓存。** 删除时宿主还持有它的话，它被销毁的那一刻投影缓存可能再写回一条 checkpoint。那条记录永远读不到（没有日志就没有会话），只是几十 KB 的死文件，清理入口会扫掉它。
- **页面自己的草稿要再清一遍。** 会话正开着的时候删掉它，装载中的 store 会在这一轮清理**之后**又把键写回来一次（它只在 slot 被销毁后才停）。所以清理会隔几个 tick 重做，直到某一轮什么都没删掉为止——这也意味着不必为了删干净而退出 DeepSeek。
- **改插件代码要重启 DSH。** 宿主半边在启动时装配：profile 的 HMR 会监视 manifest 并对账补丁，但**新加**的宿主 bundle 不会被挂载进已经跑着的后端。要加载本插件的宿主半边，请重启应用；客户端那一半刷新页面即可。
- **`request-images` 那条通道是可再生的缓存。** 它按 *请求* 哈希键控，不是附件 digest，所以任何日志都无法把一条记录归属给自己。它按时间回收（超过一周），从不按会话，字节需要时会重新生成。

## 安装

下面几条都走 DSH 自带的插件管理，它接受一个安装 spec（`@deepseek-ai/dsh-plugin-manager`）：registry 包名、git 主机简写、仓库 URL、tarball，或者本地绝对路径。npm 那条也可以直接用 `npm install` 装进 profile 目录。按你的网络情况挑一条。

### 1. 从 npm 装（包名 `better-dsh-session-deletetool`）

走 registry，也是唯一不需要访问 github.com 的：

```
npm install better-dsh-session-deletetool
```

DSH 自带的插件管理直接接受 registry 包名，在应用里走这条更省事，它会往 profile 记一条依赖并重载。

- **在应用里**：设置 → 插件 → 安装入口，粘贴 `better-dsh-session-deletetool`。
- **在会话里**：`plugin_manager { action: "install_bundle", target: "better-dsh-session-deletetool" }`。

要钉版本就照 npm 的写法：`better-dsh-session-deletetool@0.4.0`。

### 2. 直接从 GitHub 装（需要能访问 github.com）

spec：

```
github:Lzcdebear/better-dsh-session-deletetool
```

等价写法：

```
https://github.com/Lzcdebear/better-dsh-session-deletetool
```

把 spec 交给 DSH：

- **在应用里**：设置 → 插件 → 安装入口，粘贴 spec。（插件管理界面和 `plugin_manager` 工具接受的是同一个字符串。）
- **在会话里**：让 Agent 装 —— 工具调用是 `plugin_manager`，`action: "install_bundle"`，`target: "github:Lzcdebear/better-dsh-session-deletetool"`。

可以用 `#` 钉住某个 ref：`github:Lzcdebear/better-dsh-session-deletetool#v0.1.0`。

连接检查失败时 DSH 会给出一个有界的日志路径。如果这台机器根本连不上 github.com，走第 1、3 或第 4 条，或者先给 git 配上代理（`git config --global http.proxy http://127.0.0.1:7890`）。

### 3. 从本地副本装（离线可用）

把仓库下载下来（ZIP 或 `git clone`），解压到任意位置，然后把**绝对目录**交给插件管理：

```
plugin_manager { action: "install_bundle", target: "D:\\plugins\\better-dsh-session-deletetool" }
```

DSH 会记一条 `link:` 依赖并重载 profile。开发这个插件用的就是这条路，网络受限时也走它。

### 4. 从发布 tarball 装

```
https://github.com/Lzcdebear/better-dsh-session-deletetool/archive/refs/heads/main.tar.gz
```

安装入口同第 2 条；git 不可用但 HTTPS 通的时候好用。

### 装完之后

宿主半随 profile 一起加载；客户端半刷新页面后出现。会话的 `⋯` 菜单里会多一项**删除会话 / Delete conversation**。侧栏底部不会有任何变化——这个插件不往那里加东西。

想卸载就用同一个管理入口：`plugin_manager { action: "remove_bundle", target: "better-dsh-session-deletetool" }`（bundle 键就是包名）。

## 用法

1. 在任意会话行上点 `⋯`，选**删除会话**。
2. 确认框先向宿主问一次真实状态，写清楚：会删掉什么、它是不是还被 Harness 占用、还剩什么在工作。
3. 接着把整个家族画成一棵树让你挑：本对话一行，下面按「子智能体（n）」「派生对话（n）」两个可折叠分组展开，派生对话把自己那一层接在自己的块里面；每行都有勾选框（带标题、id 尾号和状态标记），分组标题的勾选框管这一块。不想删的把勾去掉。
4. 确认。按钮上写着即将删掉几个会话；如果还有在跑的工作，按钮会变成**停止并删除**，按下去先停掉那些工作。
5. 相关的行立刻从侧边栏消失，数据也从磁盘上没了，对话框报出这次释放了多少字节。
6. 想连更早的删除留下的东西一起回收，就在同一个对话框的下半部分按**立即清理**——它先报数字，按完再报实际释放了多少。它从不删除任何会话。

## HTTP 接口

客户端半通过 `ctx.webServer` 上三条同源 `exact` 路由访问宿主。纯 JS、无构建步骤的插件没法声明带类型的 `ctx.remote` 命名空间（那需要 Typert 生成产物），所以这里用的是社区插件 `dshmarket` 同款通道。

| 路由 | 方法 | 作用 |
|---|---|---|
| `/better-dsh-session-deletetool/inspect?sessionId=…` | GET | 返回 `stored` / `open` / `agent` / `running` / `activity` / `artifactDirectory` / `warnings`（没读到的血缘线索，避免"少几行"被当成"这个会话没有子会话"）、`reclaim`（这次删除将释放的字节数），以及 `descendants` = `{ count, subagents, derived, truncated, maxDeletable, items[] }`，其中每项带 `id`、`kind`、`depth`、`parentId`、`title`、`open`、`agent`、`running` 和它自己的 `activity` |
| `/better-dsh-session-deletetool/delete` | POST | body `{ sessionId, stop?, descendants? }`——`descendants` 不传表示整个家族，传空数组表示只删它自己；返回 `removed`、`descendants`（每条带 `kind`）、`kept`、`stoppedActivity`、`terminalsKilled`、`warnings`、`runtime`、`activity`，以及 `reclaimed` = `{ attachments, staging, uploadCache, searchIndex, checkpoints, backups, bytes, warnings }`。点到的名字不在家族里会在动手之前就以 `400 unknown-descendant` 拒绝 |
| `/better-dsh-session-deletetool/sweep` | POST | body `{ dryRun?, pruneExpiredCache?, pruneBackups? }`——回收没有任何会话再引用的字节：无引用的附件对象、残留暂存文件、过期的 provider 上传缓存记录、压缩后的搜索索引、陈旧的 Workspace 备份。`dryRun: true` 只报告不动手。返回与删除相同的 `reclaimed` 结构。**清理永远不会删除任何会话**——子智能体和派生对话是没有被任何 Workspace 记录列举的合法会话，只有一次删除才知道哪条血缘要走了 |

三条路由各自带同源校验：`Host` 必须是环回、`sec-fetch-site` 不能是 `cross-site`、`Origin` 存在时必须与 `Host` 同源。别的网站页面打不进来。

## 构成

| 文件 | 作用 |
|---|---|
| `host.js` | 宿主半：三条路由、工件/工程记录/缓存清理、子会话子树 |
| `client.js` | 客户端半：`sidebar.workspaces.session.menu.item` 菜单项（order 500）、一个 `shell.overlay` 对话框（删除与清理磁盘占用都在里面）、以及页面自己的 `localStorage` 清理 |
| `reclaim.js` | 磁盘布局：多帧 zstd 日志、结构化附件引用、内容寻址的三条通道、provider 上传缓存、检查点、备份 |
| `reclaim-host.js` | 回收编排：删除前后的引用计数、删除时的回收、独立的孤儿清理 |
| `search-index.js` | 派生 SQLite 索引：用引擎的 `application_id` 定位、清除某个会话的行、压缩文件 |
| `cordis.patch.yml` | 把宿主行插进 profile 层栈 |
| `test/host.test.mjs` | 路由测试，跑在真实临时目录上 |
| `test/reclaim.test.mjs` | 回收测试：引用计数、共享 blob、上传缓存、搜索索引、sweep |
| `test/client.test.mjs` | 客户端测试：字节格式化、清理区块、一次删除**允许**碰哪些 `localStorage` 键，以及被复写的键如何再清掉 |

样式只用宿主主题 token（`--dsw-alias-*`），浅色深色都跟随；界面文案通过客户端 locale 服务本地化（英文 / 简体中文）。

## 开发

```sh
node --test test/host.test.mjs
```

测试直接驱动真实的 `apply()` 注册，配假的宿主服务和真实的临时目录，覆盖：删除本体、有活时的拦截与停止、子会话子树、状态查询、清理入口从不删会话，以及各种拒绝路径（坏 id、坏 body、错方法、跨站来源）。

## 许可

[MIT](LICENSE) —— 沿用上游的 MIT，版权归原作者。

## 作者

**上游原版**：陆知辰（Lzcdebear）— [GitHub](https://github.com/Lzcdebear/better-dsh-session-deletetool)、[Bilibili](https://space.bilibili.com/220996778)

**本地派生版**：基于上游 0.5.2 的本地修改，改动从 CHANGELOG 的 0.6.0 起记录；不享有原作者署名，也不代表他的立场。上游的问题请到他的仓库提，本地改动的问题请自行处理。
