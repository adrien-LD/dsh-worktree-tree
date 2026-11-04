# dsh-worktree-tree

给 DeepSeek Harness Web 侧栏加一层 **Git worktree 视图**：每个工作区（Workspace）下面先列出它的 git worktree（主检出 + `.agents/worktrees/*`），再把该工作区里的会话按「当前在哪个 worktree」归到对应分组下，形态类似：

```
▾ tea-app-im                         ← 工作区（原生行）
    ▾ 主分支  master 3               ← 插件插入的 worktree 头
        · 会话 A
        · 会话 B
    ▾ feat/ai-voice-billing 1
        · 会话 C
    ▾ worktree-1f2e…  0              ← 空 worktree 也会显示（host 数据可用时）
```

**不替换、不搬移原生会话行**：点击打开、悬停卡片、… 菜单、拖拽排序、归档/置顶、双击改名、搜索等全部保持原生行为。插件只做三件事：

1. 在 `div.groupSection` 里插入非 React 的 worktree 头（`[data-dswt-header]`，**不带** `data-row-key`，不参与原生行动画/测量）；
2. 用 CSS `order` 对原生会话行做视觉重排（DOM 顺序不变）；
3. 用 MutationObserver + store 订阅增量校正，卸载时完整还原。

## 安装

**GUI**：侧栏 **插件 → 添加插件 → 安装第三方插件**，选择本仓库目录。

**CLI**（在本仓库根目录执行）：

```bash
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH" plugin --profile desktop add "link:$PWD"
```

然后**完全退出并重新启动 DSH**（客户端 bundle 只在启动时加载；每次修改 `lib/client.js` 后都需要重启才能看到效果）。

卸载：

```bash
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH" plugin --profile desktop remove dsh-worktree-tree
```

## 数据来自哪里

| 来源 | 用途 | 回退 |
|---|---|---|
| host 半（`ctx.connection.rpc` 通道 `/dsh-worktree-tree`，endpoint `snapshot`） | 每个工作区真实 `git worktree list --porcelain`：分支、HEAD、locked、prunable、dirty；空 worktree 也能显示 | host 不可用/失败时自动退回路径约定 |
| 客户端 `ctx.get('sessions').list` | 每个会话的当前目录（`projectionValues.workingDirectory`，回退 `cwd`）与原生行顺序 | — |
| 客户端 `ctx.get('workspaces').list` | 工作区路径、标题、会话归属 | — |

回退约定：DSH 官方 worktree 的目录/分支约定是 `<工作区>/.agents/worktrees/<branch>`，因此没有 host 数据时也能从会话目录后缀解析出分支名（含 `feat/xxx`）；主检出分支名则显示为「主分支 / Main」。

host 半是只读的：只执行 `rev-parse --show-toplevel`、`worktree list --porcelain -z`、`status --porcelain`，走调用方沙箱策略（`ctx.sandboxPolicy.resolve({})`，agentless 合法），**不 fetch、不写文件**。可用环境变量 `DSH_WORKTREE_TREE_GIT` 指定 git 可执行文件（默认 `git`）。

## 已知限制

- **只在「按工作区」/「按工作区树」视图生效**；「一个列表」平铺视图与搜索结果保持原样（不注入、不重排）。
- 视觉顺序由 CSS `order` 决定，DOM/Tab 顺序仍是原生顺序；拖拽排序仍按原生逻辑生效，拖拽过程中分组视觉可能短暂跳一下。
- 会话归属按**当前**工作目录计算：在 worktree 里 `working_directory({ cd: 原路径 })` 离开后，该会话会回到主分支组（不保留历史归属）。
- 用户手工 `git worktree add` 到任意路径（不在 `.agents/worktrees/` 约定内）时：host 数据可用则正确分组，否则会退回「未知/其他目录」组。
- 与本地插件 `dsh-workspace-group-tabs` 可以共存（本插件不使用 `!important` 覆盖 `display`，不会顶掉它的分组隐藏）；两者叠加时以实际视觉为准。
- 依赖侧栏内部约定 `[data-row-key^="workspace:"]` / `[data-row-key^="session:"]` 与 `div.groupSection` 结构；DSH 大版本升级后若侧栏 DOM 结构变化需要适配。
- 折叠状态保存在 `localStorage` 的 `dsh.worktree-tree.collapsed.v1`（按 origin 隔离）。

## 目录

```
dsh-worktree-tree/
├─ package.json          # dsh.bundle.patch + dsh.client（双半包，无构建步骤）
├─ cordis.patch.yml      # 往 loader 插入 host 行
├─ lib/index.js          # host 半：RPC 通道 / snapshot（git worktree 清单）
├─ lib/parse.js          # porcelain 解析（纯函数，可单测）
├─ lib/client.js         # client 半：侧栏分组渲染（无 React 依赖，纯 DOM）
├─ test/host.test.mjs    # host 解析单测
└─ test/client-logic.test.mjs  # 纯逻辑单测（vm 加载 client.js 的 __test）
```

## 开发

```bash
cd dsh-worktree-tree
node --check lib/client.js && node --check lib/index.js
node --test test/host.test.mjs test/client-logic.test.mjs
# DOM 集成测试需要 jsdom（只装在临时目录，不是插件依赖）：
#   mkdir -p /tmp/dsh-wt-dom && cd /tmp/dsh-wt-dom && npm init -y && npm i jsdom
node --test test/dom-integration.test.mjs
```

客户端代码是手写 JS（`window.__ModuleLoader__.load({ id, factory })`），无构建步骤；修改后需要重启 DSH 才会重新加载。
