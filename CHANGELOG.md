# Changelog

版本号与 [GitHub Releases](https://github.com/xlxs123/dsh-session-multiselect/releases) 同步。
推送 `v*` tag 时由 `.github/workflows/release.yml` 校验版本、跑测试、并发布带版本无关 tarball 的 Release。

## 0.5.1

- 修复「打开中的对话删不掉」：区分**正在运行**与**打开过但空闲**——前者在客户端就拦下并写明原因
  （文件正在写，插件无法卸载），后者带 `force-open=1` 正常移进回收站；路由回 `live: true`，
  状态行提示"列表里的行会在重启 DSH 后消失"（文件已在回收站，可恢复）。
- 删除「打开过但空闲」的对话后，面板本地隐藏该行（Host 列表在重启前仍持有它），`restore` 会解除隐藏——避免文件已进回收站、行却还在的错觉。
- 失败列表改进：优先显示对话标题，没有标题时显示去掉 `session-` 前缀的短 id——以前只显示
  前 8 个字符，而所有顶层 id 都以 `session-` 开头，失败列表等于什么都没说。
- 测试 78 个；诊断 BUILD 27。
## 0.5.0

- **删除改为回收站**：删除把会话目录连同投影缓存移进 `$DSH_HOME/trash/session-multiselect/`，
  而不是 `rm -rf`；保留 7 天，超期条目在下次删除/查看/恢复时自动清理。
- **回收站视图**：面板工具栏新增「回收站」，列出最近删除的对话（标题、工作区、删除时间），
  一键恢复回原工作区（目标已存在同名会话时拒绝覆盖）。标题在删除时从投影缓存读出并存入 `meta.json`。
- 新增 `GET /session-multiselect/trash` 与 `GET /session-multiselect/restore?ids=…` 两个路由；
  restore 沿用删除路由的跨站守卫、批量上限与打开中会话拒绝。
- 测试 75 个（新增回收站移动/列表/恢复往返/冲突拒绝/过期清理、面板回收站视图与恢复）。
- 诊断 BUILD 升到 26。

## 0.4.4

- 安全：删除路由拒绝浏览器跨站请求（`Sec-Fetch-Site: cross-site` → 403）——该路由有副作用却只能是 GET，
  同源 fetch 与 curl 不受影响。
- 健壮性：单次请求 id 上限 200，面板自动分批；超长选择不会再变成难懂的请求行 431。
- 发布自动化：新增 tag 驱动的 release workflow（校验 tag/版本、`npm test`、发版本无关 tarball）。
- 安装文档：补充 tarball / GitHub / 本地源码三种安装方式。

## 0.4.3

- 修复「有时删得掉有时删不掉」：Host 同时持有磁盘目录与内存会话库，只删目录时**打开中的会话**会在下次刷新
  回到列表。删除路由现在查询 `ctx.get('sessions')`，逐 id 拒绝打开中的会话并给出原因，同批其余照常删除。
- 删除路由新增 `?dry=1` 探针：只报告 `live` / `present`，不碰磁盘，用于安全排障。
- Windows 目录删除加重试（`maxRetries` / `retryDelay`），短暂文件锁不再误报失败。

## 0.4.2

- 修复 footer 兜底入口：`inject()` 返回面里的 `hooks` 是 slot renderer 的保留键（会被绑定成 `use<Name>` 后删除），
  插件把 snapshot stores 改名为 `seats`，入口不再每次渲染崩溃并被 slot 摘除（slot 检查从 `active: false` 恢复为 `true`）。

## 0.4.1

- 宿主半删除路由：`GET /session-multiselect/delete`（客户端会话服务没有 `delete`；该版 Web server 对所有 POST 回 405）。
- 面板不再列出子智能体会话（裸 UUID id）；删除路由接受两种 id 拼写。
- 删除成功后调用 `ctx.sessions.refresh()` 重拉列表，被删行立即消失。
- 投影缓存清理覆盖当前 `<id>.json` 布局与旧目录布局。

## 0.4.0

- 移除内联勾选模式，只保留面板模式。