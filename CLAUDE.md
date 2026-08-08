# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

「文象」(Write Then Publish) 是一个面向内容创作者的本地排版编辑器，纯前端为主，另含一个本地多 Agent 洗稿工作台。核心价值：输入内容后一键在「图文卡片」与「长文」两种排版间互转、导出、发布。

仓库由两大块组成：

1. **排版编辑器（网页版核心）**：纯前端 Vanilla JS 单页应用，无框架、无构建。这部分深挖见 [`AGENTS.md`](AGENTS.md)（结构、渲染管道、常量、已知陷阱都很全，改 app.js 前先读它）。
2. **文象 Agent Studio（`agentic/`）**：本地洗稿工作台 —— FastAPI + LangGraph 后端 + Electron 桌面壳。这是最近一次提交新增的，`AGENTS.md` 尚未覆盖，是本文件的补充重点。

## 常用命令

```bash
# 网页版（必须通过 HTTP 访问，不要直接 open index.html）
npm start                 # python3 -m http.server 5173 → http://127.0.0.1:5173/
npm open                  # 打开 index.html（仅调试，file:// 下 Canvas toBlob 会抛 SecurityError）

# Agent Studio 后端（Python 3.11+，用 uv 管理）
cd agentic/backend && uv sync
uv run uvicorn app.main:app --reload     # http://127.0.0.1:8000/
uv run pytest                            # 后端测试

# Agent Studio 桌面应用（Electron，自动拉起本地后端并打开文象窗口）
cd agentic/desktop && npm install
npm start                                 # 或 npm run dev 带 --dev

# 多端版本同步（唯一版本源是根 package.json 的 version）
npm run sync                              # 全量同步
npm run sync:plugin | sync:extension | sync:skill | version:sync   # 只同步指定端
```

**Chrome 扩展**：无构建，在 `chrome://extensions/` 开启开发者模式后「加载已解压的扩展程序」选 `extension/` 目录；改完代码后回页面 `Command + Shift + R` 强刷，直到顶栏显示「扩展已连接」。

## 架构总览

### 1. 排版编辑器核心（`index.html` + `src/app.js` + `src/styles.css`）

- **单文件业务逻辑**：`src/app.js`（约 5100 行）承载全部逻辑，无模块划分，靠函数分区。
- **数据流**：`state` 全局状态 ← `readForm()` 从 DOM 读设置 → `render()` 按模式分发 → 输入 `debounce` 140ms 后 `saveState()`。
- **两种渲染路径**：
  - 图文卡片：`parseBlocks()` → `buildPages()`（分页）/ `buildScrollPage()`（滑动截图）→ `renderPage()` → Canvas `drawPageToContext()` → `toBlob()` 导出 PNG。Canvas 宽度固定 864px，比例 3:4（高 1152）/ 3:5（高 1440，默认）。
  - 长文：`renderArticlePreview()` 用 DOM 排版，html2canvas 导出长图。
- **存储**：localStorage（历史记录/设置，key 前缀 `graphicTextLayoutState.*`）+ IndexedDB（大图片媒体库，DB 名 `estherBuerWriteThenPublishMedia`）。
- **行内样式语法**：`{{color:#2563eb|文字}}`、`{{bg:#fff3a3|文字}}`、图片引用 `[[image:img_id]]`、Markdown 表格。
- **图标**：Lucide（CDN），每次动态更新 DOM 后须调用 `window.lucide.createIcons()`。

### 2. 多端同源与版本同步

四个端共享 `package.json` 的 `version`，`scripts/sync-surfaces.mjs` 负责写回各端：

| 端 | 同步目标 |
|---|---|
| 网页 | `src/app.js` 第 1 行 `APP_VERSION`（`// @wtp-version` 标记）与页面版本徽章 |
| Obsidian 插件 | `obsidian-plugin/manifest.json` + `versions.json` + `plugin-assets/` |
| Chrome 扩展 | `extension/manifest.json` + `content.js` 的 `EXTENSION_VERSION` |
| Codex skill | `~/.codex/skills/write-then-publish-render`（可用 `WTP_SKILL_DIR` 覆盖） |

改共享前端或版本号后跑 `npm run sync`。同步脚本用 `@wtp-version` 标记做占位替换，找不到标记会报错。

### 3. 文象 Agent Studio（`agentic/`）

```
agentic/
├── backend/        # FastAPI + LangGraph，Python（uv）
│   ├── app/
│   │   ├── main.py        # API 路由 + config/jobs 持久化 + 图片代理
│   │   ├── graph.py       # LangGraph 流水线（当前编译：expert → finalize）
│   │   ├── jobs.py        # 任务队列与历史持久化（job → events 流）
│   │   ├── llm.py         # LLM 接入：本地演示 / OpenAI 兼容 / Ollama，langchain
│   │   ├── pi_agent.py    # 调用本机 Pi（`pi --mode json`）执行洗稿
│   │   ├── rss.py         # RSS/Atom 抓取（标准库，无额外依赖）
│   │   └── nodes/         # planner / experts / reviewer / finalize 各节点实现
│   └── tests/             # pytest：test_api / test_graph / test_rss / test_pi_agent
└── desktop/        # Electron 壳（electron . 启动，自动拉起后端并加载 index.html）
    ├── main.js            # 找空闲端口、启动 uvicorn 子进程、等 /api/health 就绪
    ├── preload.js
    └── renderer/          # agent-studio.js / agent-studio.css（工作台前端，独立于网页版）
```

- **流水线**：当前 `build_graph()` 编译的图是 `expert（洗稿编辑）→ finalize（提取标题/生成清单）`。`nodes/` 里还保留 `planner`、`reviewer` 等更完整流水线的实现，但**尚未接入**当前编译图。
- **洗稿执行方式**：`rewrite_provider` 为 `pi` 时走 `pi_agent.call_pi()`（本机 Pi Agent，加载 `~/.hermes/skills/futurism-fetcher` 技能），否则走 `llm.call_model()`。
- **配置与历史**：都存 `~/.config/write-then-publish-agent/`（`config.json` + `jobs.json`），不落仓库。
- **后端 API**：`/api/health`、`/api/rss/preview`、`/api/image`（代理）、`/api/config`（GET/PUT）、`/api/runs`（POST/GET/DELETE）、`/api/runs/{id}`、`/api/runs/{id}/events`（SSE 流式事件）。
- **桌面壳**：`main.js` 用 `net.createServer()` 找空闲端口，按 `WTP_BACKEND_PYTHON` → `.venv/bin/python` → `python3` 顺序找解释器启动 uvicorn，`WTP_FRONTEND_DIR=ROOT` 让后端可直接服务网页版。

## 关键注意点

- **Canvas taint / 下载失败**：`canvas.toBlob()` 在 `file://` 协议、或图片源不是 data URL 时会抛 `SecurityError`。默认头像/背景图已内联为 data URL，用户上传图也转 data URL。旧 localStorage 里的 `bgImage: "assets/..."` 路径需迁移。
- **背景渲染顺序**：先填 `settings.bgColor` 底色，再叠背景图，顺序不要颠倒。
- **头像渲染两处**：编辑器 DOM（`.profile-inline`）与 Canvas 预览页头（`buildPages`/`buildScrollPage` 的 `showHeader`），改隐藏逻辑要两处同步。
- **版本号**：改版本只改根 `package.json`，然后 `npm run sync`；不要手改各端 manifest 中的版本字段。
