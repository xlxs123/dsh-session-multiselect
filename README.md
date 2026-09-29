# dsh-session-multiselect

[![test](https://github.com/xlxs123/dsh-session-multiselect/actions/workflows/test.yml/badge.svg)](https://github.com/xlxs123/dsh-session-multiselect/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](#开发)
[![DSH Desktop](https://img.shields.io/badge/DSH%20Desktop-0.9.0-black.svg)](#dsh-session-multiselect)

DSH Web 客户端的**对话多选插件**：一次勾选多个对话，然后批量删除或归档。

> **Multi-select for DSH Desktop conversations.** A checkbox panel — grouped by workspace, with search,
> select-all/invert and Shift-range select — whose batch actions are delete and archive, over the
> official `session.delete` contract and plugin-local archive state.
> Install as a standard DSH bundle: `dsh plugin --profile web add .` (see [安装](#安装)).
> No build step, no host-side code, MIT licensed.

**入口与做法**：DSH 原生侧边栏的会话列表由 `@deepseek-ai/dsh-client-ui-workspace` 以 `single` slot 独占渲染，
**没有提供逐行的扩展 slot**，所以无法在原生会话行上直接加复选框。本插件的做法是：

- 在**会话列表工具栏那一行、搜索放大镜左侧**注入一个 28px 的入口按钮，打开一个自带的完整多选面板；
  这是整个插件**唯一的 DOM 注入**（官方没有 header slot，做法与踩过的坑见下文「入口位置」）
- 面板、状态、批量动作全部走官方扩展面：`sidebar.footer.action` slot（注入失败时的兜底入口）、
  `sessions` 服务、`locale` 字典、客户端 store —— 不改动 DSH 原生代码
- 注入失败也**不会失去功能**：定位不到目标时入口自动退回侧边栏底部

兼容性：在 **DSH Desktop 0.9.0 与 0.10.0**（Harness 0.1.x / 0.1.7-rc.2）的 Web 客户端上开发并实测（Windows）。
插件只依赖官方已有的 `slots` / `locale` / `sessions` 三个服务；对会随版本变化的**装饰性契约**
（图标导出名、Button 的 variant）一律做「多候选名 + 自带兜底」，见下文「跨版本兼容」。

## 功能

**选择方式**

- 复选框列表（只列出真实对话，自动隐藏空白会话）
- **按工作区分组**：每个工作区一个标题（**显示完整路径**，路径过长时省略号出现在左侧、保留尾部目录名），
  标题上带 `已选/总数`；点标题一次即可**整组勾选/取消**。分组顺序按该组内最新对话的时间排，
  没记录工作目录的会话单独归到最后一组。工具栏的「按工作区分组」可以关掉（关掉后回到单纯按时间排序的
  平铺列表），这个选择会记住
- 全选 / 清空 / 反选
- 搜索：按标题、工作目录、会话 ID 过滤
- **Shift + 点击按范围选择**（范围按**当前显示顺序**，也就是分组后的顺序）；Ctrl/Cmd + 点击追加选择
- 已选计数实时显示

**入口位置**

入口按钮注入在**会话列表工具栏那一行、搜索控件左侧**，与原生控件同一行，间距与原生按钮一致。

这是整个插件**唯一的 DOM 注入**：那个工具栏由 `dsh-client-ui-workspace` 渲染，官方**没有声明任何 header slot**，
「放在放大镜左边」在官方扩展面上无法实现。做法是把按钮**绝对定位在搜索控件左侧、脱离 flex 流**：

- **必须脱离 flex 流**，这是两次踩坑换来的结论。该行是 `display:flex; gap:4px; justify-content:flex-end`，
  其中搜索槽是 `flex:1; max-width:28px; overflow:hidden` —— **只为搜索按钮预算了 28px**。
  按钮一旦参与这一行的 flex 排布（无论插进控件内部，还是插成控件的兄弟节点），
  都会把这 28px 挤爆，表现就是「放大镜被挤走 / 消失」。
  现在 host 用 `position:absolute` 挂在控件左缘，**不占这一行任何宽度**，放大镜原地不动
- 该行是带 `overflow:hidden` 的 flex item，会把绝对定位（露在盒外）的按钮裁掉，所以它的 `overflow`
  用**内联样式**临时放开；卸载时连同 `position:relative` 和标记属性一起还原，不在别人的 DOM 里留痕迹
- 按钮 28px，和原生 `_searchButton` 同尺寸，四个按钮共用一套节奏；间距**不是硬编码的 4px，而是量出来的**：
  先测出这一行里「放大镜 → 下一个原生图标」的实际距离，再用「百分比定位 + 测量校正」的闭环把按钮放到同样距离。
  `transform` 祖先会劫持绝对定位的包含块（纯百分比会算错），主题改了这一行的 gap 也能自动跟上
- 用**无障碍名称**（`搜索会话` / `Search sessions`）定位，而不是带构建哈希的类名
  （另加 `*_searchButton` 与输入框 placeholder 两级兜底）
- **点击有两路触发**：React 的 `onClick`，外加一个挂在 `document` 上的**捕获阶段** click 监听
  （只认落在自己 host 里的点击）。按钮长在别人的 DOM、由本插件自己的 React root 渲染，
  万一合成事件链路被别的 root 或外层处理器影响，捕获阶段的监听仍能拿到手势；重复打开是幂等的。
  按钮与 host 还带 `-webkit-app-region:no-drag`：桌面壳若把窗口顶部做成拖拽区，拖拽区会吞掉点击
- 面板开合状态放在插件自己的 store 里（不在某个组件的 state 里），所以会话列表重渲染那一行、
  甚至重建 host，弹窗都不会跟着消失
- `MutationObserver` 在会话列表重渲染后重新定位，**复用同一个 host**，不会重复插入
- **入口只有头部按钮一个**：侧边栏底部那个入口会显得多余（影响美观），因此它只在**注入失败或定位不到目标**时
  才作为兜底出现；头部按钮可用时它不渲染。两者共用同一个面板；面板通过 portal 渲染到 body，
  所以按钮位置与弹窗互不影响

**批量操作**

面板只提供两个动作按钮（这是刻意的：按钮越少，误点越少）：

| 操作 | 说明 | 可靠性 |
| --- | --- | --- |
| **删除** | 永久删除选中的多个对话及其全部记录。点「删除」后按钮自身会亮起红框、确认框自动滚进视野，二次确认后才调用服务 | 官方 `session.delete` 契约 |
| **归档 / 取消归档** | 一个按钮两个方向：选中项里**全是已归档**时显示「取消归档」，否则显示「归档」。归档的对话默认从面板隐藏（勾选「显示归档」可见） | 插件本地状态 |

> 0.2.0 起移除了 **Fork / 导出 MD / 导出 JSON / 汇总给 AI / 置顶 / 标为未读** 这些按钮，
> 对应的实现与测试也一并删除（`git revert` 对应提交即可整块找回）。归档做成双向切换，
> 正是因为面板只剩两个按钮：没有它，「取消归档」在界面上就没有入口了。

### 关于「归档」的重要说明

DSH 客户端 **没有** host 侧的 archive 契约（原生侧边栏的「未读」也只是工作区插件的
本地 localStorage 状态，未暴露成服务）。因此本插件的归档是**插件自己的持久化状态**：
它影响本多选面板的显隐，**不会**改变原生侧边栏的显示。删除走的是官方契约，对所有界面都生效。

### 会话列表数据的形状

`ctx.sessions.list.getSnapshot()` 给的是**归一化快照**：`{ ids, byId, current, phase, … }`
（工作区插件、`dsh-better-sidebar` 等都是在读 `byId[sessionId]`）。同一服务上还存在一个拍平成显示顺序的
`{ items, … }` 投影。本插件两种都认（`snapshotItems()`）：只读 `items` 会让侧边栏满屏对话、
而面板里一条都列不出来。

**`byId` 的值里没有 `sessionId`**：控制器把 id 存成 `id`，标题存成派生出来的 `displayTitle`
（`title` → `cwd` → id 依次兜底）。面板在 `normalizeSummary()` 里补齐这两个字段，并且**跳过没有可用 id 的行** ——
否则每一行都会落在同一个 `undefined` 键上，表现就是「选一行 = 全选」，批量动作也会指向空 id。
测试夹具直接使用控制器的真实形状，就是为了让这类 bug 无法回流。

### 自己的翻译器

面板文案不依赖 slot 传进来的 `t`：那个 `t` 只在 footer 那个 slot 渲染之后才会存在，而应用可能根本不渲染它
（本机上就没有）。等它的结果就是满屏 `panel.title`、`action.delete` 这样的原始键。因此 bundle 自带
`makeTranslator()`，用 `ctx.locale` 的当前语言在自己的 zh/en 字典里取词，`{name}` 占位符自己插值。

### 面板崩了会说出来，而不是静默消失

面板包在一个 error boundary 里。没有它，React 在渲染报错时会卸载整棵树 —— 包括打开弹窗的那个按钮，
用户看到的就是「点了没反应」。现在弹窗会留着，并把失败原因显示成一行红字。

### 按工作区分组（以及它为什么改动了「顺序」）

分组不是单纯加个标题：它**重排了行的显示顺序**，而 Shift+点击的范围选择、全选/反选走的都是
「显示顺序」。所以 `visibleRows()` 先按时间排出基础顺序，`groupRows()` 只做**稳定归组**
（组内保持基础顺序，组按组内最新时间排，无工作目录的组排最后），面板再把
`flattenGroups()` 的结果当作唯一的顺序来源 —— 否则 Shift+点击会扫过用户在两击之间根本看不到的行。
行的 `cwd` 默认不再重复显示（标题已经写了），关掉分组后恢复显示。

### 诊断环（排查用）

插件在 `sessionStorage` 的 `dsh.session.multiselect.diag` 里维护一个**最多 40 条**的事件环：
`apply build=N` / `placed` / `click document` / `click react` / `panel open` / `panel rendered rows=N` /
`panel error …`，以及每个批量动作的结果：`action empty` / `delete service …` / `delete start n=…` /
`delete failed <id> <原因>` / `delete done ok=… failed=…` / `action error …`。
它只写入本标签页的会话存储、写失败也绝不影响功能，用来回答「点击到底有没有到达按钮、
面板有没有渲染、删除到底报的什么错」这类只能靠现场才能判断的问题。

### 跨版本兼容

DSH 升级会改两类东西，本插件对它们的处理方式不同：

| 会变的东西 | 例子 | 本插件的做法 |
| --- | --- | --- |
| **结构性契约** | `slots` / `sessions` / `locale` 服务、`dsh.client` 清单、`/plugins/<id>/client.js` 路由、`Modal` / `Button` / `Input` 组件 | 直接依赖，缺失就**明确报错**（面板会显示原因，不会静默消失） |
| **装饰性契约** | 图标导出名（0.10 把 `IconSearchOutline16` 改成 `IconSearchOutlineRegular` 并删掉旧名）、`Button` 的 variant（0.10 的 `solid` 变成 `primary`）、带哈希的类名 | **多候选名 + 自带兜底**：图标按候选名找，找不到就用插件内联的同一份 16px path 自己画；删除按钮的红色用插件自己的 class，不看 variant |

0.10 那次的真实教训：旧版本把图标写进「必需导出」清单，于是**一个图标改名 = 插件挂不上**
（`apply` 抛错，没有按钮、没有面板、也没有提示）。现在必需清单只剩 `Modal` / `Button` / `Input`；
`Tooltip` 与三个图标都是可选的，`tests/primitives.test.mjs` 会**读本机安装的
`@deepseek-ai/dsh-client-ui-primitives` 的真实导出清单**来验证解析结果（没装 DSH 时该用例自动跳过，
所以 CI 仍然全绿）。哪一次升级又把图标改名了，诊断环里的 `apply … icons={…}` 会直接写出 `fallback(...)`。

### 升级 DSH 之后如果入口不见了

先看**设置 → 插件**里这个插件是否还在。DSH Desktop 0.10 引入了插件管理器与「移除记录」
（`$DSH_HOME/recovery/plugin-removals.json`）：一次大版本升级或一次「移除损坏插件」的操作，
会把条目从 profile 的 `package.json`（依赖 + `dsh.profile.bundles`）里摘掉 —— 这不等于不兼容，
重新装一次即可：

```sh
cd <本包目录>
dsh plugin --profile web add .
# 然后完全退出并重开 DSH Desktop
```

若 `dsh plugin add` 在本机报 `spawn …powershell.exe ENOENT` 之类的错（0.10 的 CLI 偶发），
等价的手工做法是：在 profile 目录（`$DSH_HOME/profiles/web`）的 `package.json` 里加上
`"dsh-session-multiselect": "link:<本包绝对路径>"` 依赖与 `dsh.profile.bundles` 条目，
然后在**该 profile 目录内**用 DSH 自带的 pnpm 跑一次 `install`
（`$DSH_HOME/.desktop-bin/pnpm.cmd`），最后重启。

## 安装

插件是标准 DSH bundle 包（声明 `dsh.bundle.patch` + `dsh.client`），**没有依赖需要安装**：仓库里就是可直接加载的产物。安装后**需要重启 DSH Desktop**（profile 的 bundle 层栈与 `__DSH_BOOT__` 客户端图在启动时合成）。

```sh
git clone https://github.com/xlxs123/dsh-session-multiselect.git
cd dsh-session-multiselect
dsh plugin --profile web add .     # 路径含空格时务必在包目录内执行 `add .`
```

或直接使用 pnpm 再重启：

```sh
# profile 目录：$DSH_HOME/profiles/web
<pnpm> add "link:<本包绝对路径>"
# 然后把 dsh-session-multiselect 追加到该 profile package.json 的 dsh.profile.bundles
```

> 注意：`dsh plugin` 在 Windows 上经 `shell: true` 转发参数，**路径中的空格会被拆开**。
> 因此请在包目录内执行 `add .`，不要把含空格的绝对路径当作参数传入。

卸载：`dsh plugin --profile web remove dsh-session-multiselect`（或从 profile 的
`dsh.profile.bundles` 里删掉这一项），重启后插件连同它的那一个 DOM 注入一起消失。

## 开发

```
lib/index.js      Node half（空实现：本插件没有 host 侧功能）
lib/client.js     浏览器 bundle：面板、选择模型、批量动作、头部注入（window.__ModuleLoader__ 契约）
src/index.ts      Node half 源码
tests/            48 个测试：纯逻辑单测 + 以假 Cordis 上下文挂载真实 bundle + 注入逻辑（含 DOM 桩）
                  + 对着本机安装的 primitives 真实导出清单做兼容性验证
tests/browser/    真实浏览器冒烟测试：真 React 18 + 无头 Chromium + 复制自工作区插件的头部 CSS
```

```sh
npm install                            # 只装 devDependencies（react/react-dom/ws），供测试当 React/WebSocket 源
npm test                               # = node --test  （48 个文件级测试，约 0.4 秒）
npm run test:browser                   # 真实浏览器冒烟：需要 Chrome/Edge（自动探测路径）
npm run diag                           # 从桌面应用的 Session Storage 里读出诊断环
```

`tests/browser/harness.mjs` 会起一个静态服务（插件目录 + 真实 React UMD），用 CDP 驱动无头 Chromium
打开 `click.html`，断言真实布局下的结果：按钮落在哪、中心点上压着谁、真实点击能否打开面板、
间距是否等于原生按钮间距、分组标题是否显示完整路径、点标题能否整组勾选。Node 桩答不了的就是这类问题。
React UMD 的查找顺序是：`SMOKE_APP_NODE_MODULES` / `DSH_APP_NODE_MODULES` → 本包 `node_modules` →
DSH Desktop 安装目录（Windows `%LOCALAPPDATA%\Programs\...`、macOS `/Applications/DSH Desktop.app/...`）。
Node 只要 20+：CDP 客户端优先用 Node 自带的 `WebSocket`（v22 起才有），否则用 devDependency `ws`
（CI 跑在 Node 20 上，走的就是这条路；`SMOKE_WS=ws` 可以强制走它做验证）。
可覆盖的环境变量：`SMOKE_BROWSER`、`SMOKE_PORT`、`SMOKE_CDP_PORT`、`SMOKE_APP_NODE_MODULES`、
`SMOKE_KEEP_BROWSER=1`。CI（GitHub Actions）跑的就是这两条命令。

`tests/primitives.test.mjs` 是**针对本机安装版本**的兼容性用例：它从
`@deepseek-ai/dsh-client-ui-primitives` 的构建产物里读出真实导出清单，用它当模块表来挂载插件，
再断言三个图标都解析成了这份清单里的真名（而不是兜底）。装了 DSH 才有意义，所以没装时自动 `skip`：
`SMOKE_APP_NODE_MODULES=<...>/resources/app.asar.unpacked/node_modules npm test`。

`lib/client.js` 是手写的 CJS 形式浏览器 bundle（与官方客户端插件同构），无需构建步骤即可被
客户端模块系统加载；`tests/` 通过伪造 `window.__ModuleLoader__` 与 `require` 直接驱动这份产物，
所以测试覆盖的就是实际发布的代码 —— 插件作者改一行 `lib/client.js`，测试跑的就是那一行。

## 已知限制

- **不能把复选框放进原生会话行**：原生列表没有逐行 slot（见上）。本插件提供独立面板作为替代方案。
- **入口按钮是 DOM 注入**：官方面没有 header slot，所以「放大镜左侧」只能靠注入实现。
  DSH 若改动该工具栏结构（改了无障碍名称又换了类名），注入会失败 —— 届时按钮自动退到侧边栏底部
  （`sidebar.footer.action`，设置图标左侧），不会消失、也不影响功能。注入还会给工具栏那一行加一个
  限定作用域的 `overflow` 覆盖（否则绝对定位的按钮会被 `overflow:hidden` 裁掉），卸载时该覆盖会被移除。
- **归档是插件本地状态**：DSH 客户端没有 host 侧的 archive 契约（原生侧边栏的「未读」也只是
  工作区插件的 localStorage 状态），所以归档只影响本面板的显隐；删除走官方契约，对所有界面生效。
- **删除不可撤销**：批量删除走官方永久删除契约，这是设计如此，确认框会明确写出数量。
- **只有删除和归档两个动作**：Fork / 导出 / 汇总给 AI / 置顶 / 未读在 0.2.0 被移除（含实现与测试）。
  需要它们时用 `git revert` 回滚对应提交，或在 0.1.0 的 tag/提交上取。
- **只在 Web 客户端上做过实测**：插件声明 `platform: "web"`；Tauri/其他壳未验证（理论上同构，
  但 `-webkit-app-region` 之类的桌面壳差异没有实测数据）。

## 许可

MIT，见 [LICENSE](LICENSE)。
