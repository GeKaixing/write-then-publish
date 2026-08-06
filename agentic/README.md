# 文象 Agent Studio

把文象升级为本地单步洗稿工作台：

- 洗稿编辑：素材直接交给一名洗稿编辑完整改写成中文文章，默认由 Pi Agent 加载 `futurism-fetcher` 技能执行
- RSS 素材：抓取预览并勾选条目后，条目自动合成素材喂给洗稿编辑
- 成稿导入：洗稿完成后一键导入文象编辑器，按图文卡片模式渲染
- 本地演示：默认无需 API Key 也能跑通一次洗稿
- 历史持久化：运行记录保存在本机，重启桌面应用后仍可查看

## 启动桌面应用

```bash
cd agentic/backend
uv sync

cd ../desktop
npm install
npm start
```

应用会自动启动本地后端并打开文象窗口。点击顶部 `Agent Studio` 进入洗稿工作台。

## 单独启动后端

```bash
cd agentic/backend
uv run uvicorn app.main:app --reload
```

然后在浏览器打开 `http://127.0.0.1:8000/`。

## 模型配置

Agent Studio 支持三种接入方式：

- 本地演示：默认模式，无需 Key，适合先体验完整流程
- OpenAI 兼容：填写 `Base URL` 和 `API Key`，默认 `gpt-4o-mini`
- Ollama 本机：接入方式选 `Ollama`，模型填本机已拉取的模型名

洗稿编辑节点可以单独切换执行方式：

- `洗稿执行`：选 `当前模型` 用主模型洗稿（默认），选 `Pi Agent` 用本机 Pi 执行洗稿
- `Pi Provider`：Pi 的 provider 名称，默认 `opencode-go`
- `Pi 工具`：开放给 Pi 的只读工具列表，默认 `read,grep,find,ls`；留空表示放行全部工具
- `Pi 技能`：Pi 加载的技能目录或文件，默认 `~/.hermes/skills/futurism-fetcher`；留空不加载

Pi 复用模型配置里的 `API Key` 与 `模型`（如 `deepseek-v4-flash`），不需要单独填 `Base URL`。
如果本机尚未安装 Pi，先执行：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

配置只保存在 `~/.config/write-then-publish-agent/config.json`，运行历史保存在同目录的 `jobs.json`。

## RSS 素材

创作任务里可把素材来源切到 `RSS 自动`：

- 输入 RSS/Atom 源地址，点击 `抓取预览`，勾选需要的条目后直接运行
- 也可以只填地址不预览，运行时会自动抓取该源的最新条目
- 抓取失败不会中断任务，会记录在运行历史里并继续用手动素材

RSS 解析使用 Python 标准库，支持 RSS 2.0 和 Atom，无需额外依赖。

## 测试

```bash
cd agentic/backend
uv run pytest
```
