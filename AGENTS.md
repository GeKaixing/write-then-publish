# AGENTS.md — write-then-publish（文象）

## 项目概览

纯前端内容排版编辑器，面向内容创作者的本地工具。由 开星(@wsmyyzmkta) 基于 [捏捏番茄的 write-then-publish](https://github.com/fxyadela/write-then-publish) 二次定制。

**核心定位**：解决写完之后最麻烦的部分——排版、分版、预览、下载、历史保存和多格式复用。

**两种工作模式**：
- **图文卡片** — 长文本自动分页，Canvas 渲染为竖版图片，适合小红书/X 发帖
- **长文** — Markdown 预览排版，html2canvas 导出长图，适合公众号/文章草稿

两种模式可一键互转，内容不变。

## 项目结构

```
.
├── index.html           # 页面结构（HTML + 样式/脚本引用）
├── package.json         # 唯一版本源 + npm 脚本
├── scripts/
│   └── sync-surfaces.mjs # 多端版本与资源同步
├── extension/           # Chrome 自动发布扩展
├── obsidian-plugin/     # Obsidian 插件
├── vercel.json          # Vercel 静态部署配置
├── CNAME                # 自定义域名
├── src/
│   ├── app.js           # 全部业务逻辑 (~4600 行, 单文件)
│   └── styles.css       # 全部样式 (~2100 行)
├── vendor/
│   ├── html2canvas.min.js  # 长文模式导出长图
│   └── jszip.min.js        # 批量下载打包
├── assets/
│   ├── esther-buer-avatar.png  # 默认头像
│   └── bg-default.webp         # 默认背景图（已内联为 data URL 在 app.js）
├── docs/
│   ├── screenshots/     # 预览截图
│   └── xhs_ai_tech_radar/ # 小红书技术雷达文档
└── .gitignore
```

## 启动方式

```bash
cd ~/Desktop/write-then-publish
npm start                        # python3 -m http.server 5173
# 浏览器访问 http://127.0.0.1:5173/

# 或直接打开（不推荐 — file:// 下 Canvas toBlob 会抛 SecurityError）
open index.html
```

## 技术栈

- **纯前端**：HTML + CSS + Vanilla JS（无框架依赖）
- **Canvas 渲染**：图文卡片用 `<canvas>` 逐页渲染预览，`toBlob()` 导出 PNG
- **第三方库**：html2canvas（长文导出）、JSZip（批量打包）、Lucide（图标）
- **存储**：localStorage（历史记录/设置）、IndexedDB（图片/大媒体文件）
- **部署**：Vercel 静态站点（vercel.json 配置根目录输出）

## 核心架构 (app.js)

### 数据流

1. **状态管理**：全局 `state` 对象保存所有 UI 状态和临时数据
2. **表单读取**：`readForm()` 从 DOM 元素读取当前设置，返回 settings 对象
3. **渲染核心**：`render()` 根据 mode 选择渲染路径
4. **自动保存**：通过 `debounce` 机制在用户输入 140ms 后触发 `saveState()`

### 渲染管道

```
render()
  ├── 长文模式 → renderArticlePreview() → html2canvas 导出
  └── 图文模式
        ├── 普通分页 → buildPages() → renderPage() → drawPreview()
        └── 滑动截图 → buildScrollPage() → renderScrollPage() → drawPreview()
```

### 关键数据结构

- `state` — 全局状态，包含 appMode、headerMode、cardRatio、uiTheme、images、projects 等
- `settings` — `readForm()` 输出的当前配置快照，传给所有渲染函数
- `page` — 渲染中间产物：包含 avatar、badge、settings、showHeader、bounds、items[]
- `blocks` — `parseBlocks()` 将 Markdown 文本解析为 blocks 数组（text、image、spacer、table）

### 文本解析与样式

- 支撑文本样式：`# H1`、`## H2`、`**粗体**`、`*斜体*`、`> 引用`
- 行内颜色：`{{color:#2563eb|文字}}`、`{{bg:#fff3a3|文字}}`
- 图片引用：`[[image:img_id]]`
- 支持 Markdown 表格：`| col1 | col2 |`

### 图片处理

- 图片通过 `readFileAsDataURL()` 转为 data URL 存入 `state.images`
- IndexedDB 持久化存储大图片（`mediaKeyForImage()` → key: `image:{id}`）
- 支持裁剪（自定义 cropper）、宽度百分比批量调整、固定宽高裁切
- Canvas taint 防护：默认头像/背景图已内联为 data URL；用户上传图片也转为 data URL

## 已知陷阱与注意事项

### Canvas Taint / 下载失败

`canvas.toBlob()` 在以下情况会抛 `SecurityError: Tainted canvases`：

1. **file:// 协议打开页面** — 所有本地文件加载的图片都会污染 Canvas
   - 必须通过 `http://localhost:5173` 访问才能正常下载
2. **旧版 localStorage 遗留路径** — `bgImage: "assets/bg-default.webp"` 不是 data URL
   - `applyForm`/`migrateStoredState` 中有迁移检查，遇到旧值替换为 data URL
3. **默认背景/头像** — 已内联为 base64 data URL，不会污染
4. **`loadImageUntainted()`** — 对 webp blob 解码可能失败，有 fallback 到 `loadImage()`

### 背景图渲染顺序

先填 `settings.bgColor` 底色，再叠背景图。修改渲染函数时注意不要颠倒顺序。

### 头像栏

- `state.profileBarHidden = true` 默认隐藏
- 头像在**两处**渲染：编辑器 DOM（`.profile-inline`）和 Canvas 预览（`buildPages`/`buildScrollPage` 中的 `showHeader`）
- 修改隐藏逻辑时两处都要改

### 图标

使用 Lucide 图标库（通过 CDN 加载），每次动态更新 DOM 后需调用 `window.lucide.createIcons()` 重新渲染。

### 卡片比例

- 3:4 → `CANVAS_HEIGHT = 1152`（864x1152）
- 3:5 → `CANVAS_HEIGHT = 1440`（864x1440，默认）
- `CANVAS_WIDTH` 固定 864px
- 比例在设置弹窗中切换，每次 `render()` 开头设置

### 常量与默认值

- `displayName: "开星"`、`handle: "@wsmyyzmkta"`
- 默认背景图：内联 data URL（~237KB base64，直接写在 `defaultFormState().bgImage`）
- 默认头像：`assets/esther-buer-avatar.png`（`state.avatar` → `sampleAvatar`）
- 默认内容：一段示例文本 + 一张示例 SVG 插图
- 内置说明书：两个只读项目（图文卡片说明书、长文说明书），前缀 `guide_`，不可修改不可删除

### 调试技巧

```js
// 清空所有本地存储重新开始
localStorage.clear()

// 模拟旧状态测试迁移
localStorage.setItem('graphicTextLayoutState.sjwesther.v1',
  JSON.stringify({bgImage: "assets/bg-default.webp"}))

// 在 DevTools 中直接调用渲染
render()

// 检查当前项目标题
projectSlug()

// 清除 IndexedDB（媒体图片库）
indexedDB.deleteDatabase('estherBuerWriteThenPublishMedia')
```

## 修改指引

- **修改默认头像/名称**：改 `defaultFormState()` 和 `applyForm()` 中的常量
- **修改默认背景图**：改 `defaultFormState().bgImage` 中的 data URL（可用 `npm start` 后从页面获取）
- **新增文字样式**：在 `styleForBlock()` 中添加类型，在 `renderTextBlock()` 中添加绘制逻辑
- **新增设置项**：在 `readForm()` / `applyForm()` 中添加字段，在 `index.html` 中添加 DOM 元素
- **图标变更**：先用 `search_files` 在 `app.js` 中查找现有引用，再全局替换
- **样式修改**：CSS 变量集中定义在 `styles.css` 的 `:root` 中，主题通过 `[data-ui-theme="dark"]` 切换

## Obsidian 集成

- 支持连接 Obsidian 仓库根目录（File System Access API）
- 在编辑区直接粘贴 Obsidian Markdown，`![[图片.png]]` 和 `![](附件/图片.png)` 会被自动识别
- 图片按路径从本机读取，保留图片位置
- Obsidian 文件浏览器可浏览仓库文件，点击导入内容



## 版本管理

网页版、Obsidian 插件、Chrome 扩展、Codex skill 共用 `package.json` 的 `version`。

改版本或共享前端后执行：

```bash
npm run sync
```

脚本会：
- 写回 `src/app.js` 的 `APP_VERSION` 与页面版本徽章
- 更新 `obsidian-plugin/manifest.json` + `versions.json`，并同步 `plugin-assets/`
- 更新 `extension/manifest.json` 与 `extension/content.js` 的 `EXTENSION_VERSION`
- 同步 `~/.codex/skills/write-then-publish-render` 前端副本与 `VERSION` / `SKILL.md`
