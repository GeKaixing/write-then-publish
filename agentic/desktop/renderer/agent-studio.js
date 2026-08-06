(function () {
  "use strict";

  const state = {
    open: false,
    backendOk: null,
    config: null,
    runs: [],
    activeRunId: null,
    activeRun: null,
    eventSource: null,
    pollTimer: null,
    events: [],
    running: false,
    sourceMode: "manual",
    feeds: loadFeeds(),
    activeFeedId: null,
    rssItems: [],
    messages: [],
    runMessageId: null,
    rightTab: "preview",
    previewMarkdown: "",
    editorTouched: false,
    previewMode: "cards",
    browserUrl: "https://example.com",
    browserFallback: false,
    ui: loadUi(),
  };

  const FEED_STORAGE_KEY = "wtpAgentRssFeeds.v1";
  const UI_STORAGE_KEY = "wtpAgentUi.v1";

  const NODE_LABELS = {
    expert: "洗稿编辑：完整改写",
    finalize: "生成成稿与清单",
  };

  const PROVIDER_LABELS = {
    demo: "本地演示",
    openai_compatible: "OpenAI 兼容",
    ollama: "Ollama 本机",
  };

  const REWRITE_LABELS = {
    llm: "当前模型",
    pi: "Pi Agent",
  };

  function providerLabel(provider) {
    return PROVIDER_LABELS[provider] || provider || "本地演示";
  }

  function rewriteLabel(provider) {
    return REWRITE_LABELS[provider] || provider || "当前模型";
  }

  function icon(name) {
    return `<i data-lucide="${name}"></i>`;
  }

  function esc(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  const REMOTE_IMAGE_RE = /!\[([^\]]*)\]\((?:<([^>]+)>|([^\s)]+))(?:\s+[^)]*)?\)/g;
  const remoteImageCache = new Map();

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  async function remoteImageDataUrl(url) {
    if (remoteImageCache.has(url)) return remoteImageCache.get(url);
    const response = await fetch(`/api/image?url=${encodeURIComponent(url)}`);
    if (!response.ok) throw new Error(`图片抓取失败 (${response.status})`);
    const blob = await response.blob();
    const dataUrl = await blobToDataUrl(blob);
    remoteImageCache.set(url, dataUrl);
    return dataUrl;
  }

  async function materializeMarkdownImages(markdown) {
    let content = String(markdown || "");
    for (const match of Array.from(content.matchAll(REMOTE_IMAGE_RE))) {
      const url = (match[2] || match[3] || "").trim();
      if (!/^https?:\/\//i.test(url)) continue;
      try {
        const dataUrl = await remoteImageDataUrl(url);
        content = content.replace(match[0], `![${match[1]}](${dataUrl})`);
      } catch {
        // 保留原地址，预览仍可尝试直接加载。
      }
    }
    return content;
  }

  async function registerRemoteImages(markdown, images = {}) {
    const registry = { ...images };
    let content = String(markdown || "");
    const idsByUrl = new Map();
    let index = 0;
    for (const match of Array.from(content.matchAll(REMOTE_IMAGE_RE))) {
      const url = (match[2] || match[3] || "").trim();
      if (!/^https?:\/\//i.test(url)) continue;
      let id = idsByUrl.get(url);
      if (!id) {
        id = window.createImportedImageId ? window.createImportedImageId(index) : `img_${index}`;
        idsByUrl.set(url, id);
        index += 1;
        try {
          const src = await remoteImageDataUrl(url);
          registry[id] = {
            src,
            name: url.split("/").pop() || "图片",
            sourcePath: url,
            crop: null,
            layout: window.defaultNewImageLayout ? window.defaultNewImageLayout() : null,
          };
        } catch {
          continue;
        }
      }
      content = content.replace(match[0], `[[image:${id}]]`);
    }
    return { content, images: registry };
  }

  function fmtTime(timestamp) {
    if (!timestamp) return "";
    const date = new Date(timestamp * 1000);
    return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    if (!response.ok) {
      let detail = "";
      try {
        const body = await response.json();
        detail = body.detail || body.error || "";
      } catch {
        detail = "";
      }
      throw new Error(detail || `请求失败 (${response.status})`);
    }
    return response.json();
  }

  function refreshIcons() {
    if (window.lucide && typeof window.lucide.createIcons === "function") {
      window.lucide.createIcons();
    }
  }

  function toast(message, kind = "ok") {
    let node = document.querySelector(".as-toast");
    if (!node) {
      node = document.createElement("div");
      node.className = "as-toast";
      document.body.appendChild(node);
    }
    node.textContent = message;
    node.dataset.kind = kind;
    node.classList.add("show");
    window.setTimeout(() => node.classList.remove("show"), 2600);
  }

  function setBackendStatus(ok, message) {
    state.backendOk = ok;
    const badge = document.querySelector("#asBackendStatus");
    if (!badge) return;
    badge.className = `as-status ${ok ? "ok" : "err"}`;
    badge.textContent = ok ? (message || "本地后端已连接") : (message || "本地后端未连接");
  }

  function loadFeeds() {
    try {
      const value = JSON.parse(localStorage.getItem(FEED_STORAGE_KEY) || "[]");
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }

  function saveFeeds() {
    try {
      localStorage.setItem(FEED_STORAGE_KEY, JSON.stringify(state.feeds));
    } catch {
      // storage unavailable
    }
  }

  function loadUi() {
    const defaults = { leftOpen: true, rightOpen: false };
    try {
      const value = JSON.parse(localStorage.getItem(UI_STORAGE_KEY) || "{}");
      return { ...defaults, ...value };
    } catch {
      return defaults;
    }
  }

  function saveUi() {
    try {
      localStorage.setItem(UI_STORAGE_KEY, JSON.stringify(state.ui));
    } catch {
      // storage unavailable
    }
  }

  function buildDom() {
    const root = document.createElement("div");
    root.id = "agentStudioRoot";
    root.hidden = true;
    root.innerHTML = `
      <header class="as-topbar">
        <div class="as-topbar-brand">
          <span class="as-logo">文</span>
          <div class="as-brand-text">
            <strong>文象 Agent Studio</strong>
            <span>洗稿工作台</span>
          </div>
        </div>
        <div class="as-topbar-center">
          <span class="as-status" id="asBackendStatus">检查后端</span>
          <button class="as-ghost-btn" id="asModelBtn" type="button" title="模型配置" aria-label="模型配置">${icon("settings")}<span id="asModelLabel">模型</span></button>
        </div>
        <div class="as-topbar-actions">
          <button class="as-ghost-btn" id="asNewChatBtn" type="button" title="新对话" aria-label="新对话">${icon("square-pen")}<span>新对话</span></button>
          <button class="as-icon-btn" id="asHistoryBtn" type="button" title="运行历史" aria-label="运行历史">${icon("history")}</button>
          <button class="as-icon-btn" id="asToggleLeftBtn" type="button" title="打开/关闭左侧栏" aria-label="打开或关闭左侧栏">${icon("panel-left-close")}</button>
          <button class="as-icon-btn" id="asToggleRightBtn" type="button" title="打开/关闭右侧栏" aria-label="打开或关闭右侧栏">${icon("panel-right-open")}</button>
          <button class="as-ghost-btn" id="asCloseBtn" type="button" title="返回编辑器" aria-label="返回编辑器">${icon("arrow-left")}<span>返回</span></button>
        </div>
      </header>
      <div class="as-body">
        <aside class="as-sidebar as-left" id="asLeftPanel" aria-label="RSS 点阅">
          <div class="as-left-head">
            <div class="as-pane-title">${icon("rss")}RSS 点阅</div>
            <button class="as-icon-btn" id="asAddFeedToggleBtn" type="button" title="添加订阅" aria-label="添加订阅">${icon("plus")}</button>
          </div>
          <div class="as-feed-add" id="asFeedAddPanel" hidden>
            <input class="as-input" id="asFeedUrl" type="url" placeholder="https://example.com/feed.xml" />
            <input class="as-input" id="asFeedName" type="text" placeholder="订阅名称（可选）" />
            <button class="as-btn" id="asFeedSaveBtn" type="button">${icon("bookmark")}订阅</button>
          </div>
          <div class="as-feed-list" id="asFeedList"></div>
          <div class="as-items-head">
            <div class="as-pane-title small" id="asFeedItemsTitle">点阅条目</div>
            <button class="as-icon-btn" id="asRefreshFeedBtn" type="button" title="刷新当前订阅" aria-label="刷新当前订阅">${icon("refresh-cw")}</button>
          </div>
          <div class="as-feed-items" id="asFeedItems"></div>
        </aside>
        <main class="as-center" aria-label="对话">
          <div class="as-chat-head">
            <div>
              <h2>对话</h2>
              <span class="as-chat-subtitle" id="asChatSubtitle">洗稿编辑 · 单步成稿</span>
            </div>
            <span class="as-run-state" id="asRunState"></span>
          </div>
          <div class="as-chat-scroll" id="asChat"></div>
          <form class="as-composer" id="asRunForm">
            <div class="as-composer-mode">
              <div class="as-segmented" id="asSourceMode">
                <button class="as-seg active" type="button" data-mode="manual">手动素材</button>
                <button class="as-seg" type="button" data-mode="rss">RSS 素材</button>
              </div>
              <span class="as-composer-hint" id="asComposerHint">粘贴素材或选择 RSS 条目</span>
            </div>
            <div id="asManualWrap">
              <textarea class="as-textarea" id="asSource" placeholder="粘贴素材、链接摘要、要点、参考文章…"></textarea>
            </div>
            <div id="asRssWrap" hidden>
              <div class="as-rss-selected-head">
                <span id="asRssSelectedText">已选 0 条 RSS 素材</span>
                <button class="as-link-btn" id="asPickRssBtn" type="button">去左侧选择</button>
              </div>
              <div class="as-rss-chips" id="asRssSelectedList"></div>
            </div>
            <div class="as-composer-options">
              <input class="as-input" id="asGoal" type="text" value="写一篇有信息增量、适合目标平台的图文" aria-label="创作目标" title="创作目标" />
              <select class="as-select" id="asPlatform" aria-label="平台" title="平台">
                <option value="小红书" selected>小红书</option>
                <option value="X">X</option>
                <option value="公众号">公众号</option>
                <option value="通用">通用</option>
              </select>
              <select class="as-select" id="asTone" aria-label="语气" title="语气">
                <option value="专业" selected>专业</option>
                <option value="轻松">轻松</option>
                <option value="故事化">故事化</option>
                <option value="犀利">犀利</option>
              </select>
              <input class="as-input" id="asWords" type="number" min="100" max="10000" value="1200" aria-label="目标字数" title="目标字数" />
              <input class="as-input" id="asRevisions" type="number" min="0" max="5" value="2" aria-label="最大修订次数" title="最大修订次数" />
              <button class="as-btn primary as-run-btn" id="asRunBtn" type="submit">${icon("play")}<span>开始运行</span></button>
            </div>
          </form>
        </main>
        <aside class="as-sidebar as-right" id="asRightPanel" aria-label="预览、浏览器与编辑器">
          <div class="as-right-head">
            <div class="as-tabs">
              <button class="active" data-right-tab="preview" type="button">预览</button>
              <button data-right-tab="browser" type="button">浏览器</button>
              <button data-right-tab="editor" type="button">编辑器</button>
            </div>
            <button class="as-icon-btn" id="asCloseRightBtn" type="button" title="关闭右侧栏" aria-label="关闭右侧栏">${icon("panel-right-close")}</button>
          </div>
          <div class="as-right-body">
            <section class="as-preview-panel" id="asPreviewPanel">
              <div class="as-preview-toolbar">
                <div class="as-tabs as-preview-modes" role="group" aria-label="预览模式">
                  <button class="active" data-preview-mode="cards" type="button">预览图文</button>
                  <button data-preview-mode="article" type="button">预览长文</button>
                </div>
                <button class="as-btn as-copy-md" type="button" disabled>${icon("copy")}复制</button>
                <button class="as-btn as-import-editor" type="button" disabled>${icon("import")}导入编辑器</button>
              </div>
              <div class="as-preview-wrap">
                <iframe id="asPreviewFrame" title="成稿预览" sandbox="allow-same-origin allow-popups"></iframe>
              </div>
            </section>
            <section class="as-browser-panel" id="asBrowserPanel" hidden>
              <div class="as-browser-bar">
                <button class="as-icon-btn" id="asBrowserBackBtn" type="button" title="后退" aria-label="后退">${icon("arrow-left")}</button>
                <button class="as-icon-btn" id="asBrowserForwardBtn" type="button" title="前进" aria-label="前进">${icon("arrow-right")}</button>
                <button class="as-icon-btn" id="asBrowserReloadBtn" type="button" title="刷新" aria-label="刷新">${icon("rotate-cw")}</button>
                <input class="as-input" id="asBrowserUrl" type="text" aria-label="浏览器地址" placeholder="输入网址后回车" />
                <button class="as-icon-btn" id="asBrowserGoBtn" type="button" title="打开" aria-label="打开">${icon("corner-down-left")}</button>
              </div>
              <div class="as-browser-body">
                <webview id="asWebview" class="as-webview" allowpopups></webview>
                <iframe id="asBrowserFallback" class="as-browser-fallback" hidden title="内置浏览器"></iframe>
              </div>
            </section>
            <section class="as-editor-panel" id="asEditorPanel" hidden>
              <div class="as-editor-toolbar">
                <button class="as-icon-btn" data-as-format="h1" type="button" title="大标题" aria-label="大标题">H1</button>
                <button class="as-icon-btn" data-as-format="h2" type="button" title="小标题" aria-label="小标题">H2</button>
                <button class="as-icon-btn" data-as-format="bold" type="button" title="加粗" aria-label="加粗">${icon("bold")}</button>
                <button class="as-icon-btn" data-as-format="italic" type="button" title="斜体" aria-label="斜体">${icon("italic")}</button>
                <button class="as-icon-btn" data-as-format="quote" type="button" title="重点引用" aria-label="重点引用">${icon("quote")}</button>
                <span class="as-editor-toolbar-spacer"></span>
                <button class="as-btn as-sync-editor" type="button" title="从主编辑器同步最新内容">${icon("refresh-cw")}同步</button>
              </div>
              <textarea class="as-editor-input" id="asEditorInput" spellcheck="false" placeholder="在右侧编辑 Markdown 内容，修改会实时同步到主编辑器与预览。"></textarea>
            </section>
          </div>
        </aside>
      </div>
      <div class="as-popover as-config-popover" id="asConfigPopover" hidden>
        <div class="as-popover-head">
          <strong>模型配置</strong>
          <button class="as-icon-btn" id="asConfigCloseBtn" type="button" title="关闭" aria-label="关闭">${icon("x")}</button>
        </div>
        <form class="as-config-form" id="asConfigForm">
          <div class="as-row">
            <label class="as-field">
              <span>接入方式</span>
              <select class="as-select" id="asProvider">
                <option value="demo">本地演示（无需 Key）</option>
                <option value="openai_compatible" selected>OpenAI 兼容</option>
                <option value="ollama">Ollama 本机</option>
              </select>
            </label>
            <label class="as-field">
              <span>模型</span>
              <input class="as-input" id="asModel" type="text" value="gpt-4o-mini" />
            </label>
          </div>
          <label class="as-field">
            <span>Base URL</span>
            <input class="as-input" id="asBaseUrl" type="text" placeholder="https://api.openai.com/v1" />
          </label>
          <label class="as-field">
            <span>API Key <small>只保存在本机配置</small></span>
            <input class="as-input" id="asApiKey" type="password" autocomplete="off" />
          </label>
          <div class="as-row">
            <label class="as-field">
              <span>洗稿执行</span>
              <select class="as-select" id="asRewriteProvider">
                <option value="llm" selected>当前模型</option>
                <option value="pi">Pi Agent</option>
              </select>
            </label>
            <label class="as-field as-pi-field" id="asPiProviderField" hidden>
              <span>Pi Provider</span>
              <input class="as-input" id="asPiProvider" type="text" value="opencode-go" />
            </label>
          </div>
          <label class="as-field as-pi-field" id="asPiToolsField" hidden>
            <span>Pi 工具 <small>逗号分隔，留空放行全部</small></span>
            <input class="as-input" id="asPiTools" type="text" value="read,grep,find,ls" />
          </label>
          <label class="as-field as-pi-field" id="asPiSkillField" hidden>
            <span>Pi 技能 <small>目录或文件，留空不加载</small></span>
            <input class="as-input" id="asPiSkill" type="text" value="~/.hermes/skills/futurism-fetcher" />
          </label>
          <div class="as-row">
            <label class="as-field">
              <span>Temperature</span>
              <input class="as-input" id="asTemperature" type="number" min="0" max="1.5" step="0.1" value="0.7" />
            </label>
            <div class="as-popover-actions">
              <button class="as-btn primary" id="asSaveConfigBtn" type="submit">${icon("save")}保存配置</button>
            </div>
          </div>
        </form>
      </div>
      <div class="as-popover as-history-popover" id="asHistoryPopover" hidden>
        <div class="as-popover-head">
          <strong>运行历史</strong>
          <div class="as-popover-head-actions">
            <button class="as-icon-btn" id="asClearHistoryBtn" type="button" title="清空运行历史" aria-label="清空运行历史">${icon("trash-2")}</button>
            <button class="as-icon-btn" id="asHistoryCloseBtn" type="button" title="关闭" aria-label="关闭">${icon("x")}</button>
          </div>
        </div>
        <div class="as-history-list" id="asHistoryList"></div>
      </div>
    `;
    document.body.appendChild(root);

    document.querySelector("#asCloseBtn").addEventListener("click", close);
    document.querySelector("#asToggleLeftBtn").addEventListener("click", () => setUi({ leftOpen: !state.ui.leftOpen }));
    document.querySelector("#asToggleRightBtn").addEventListener("click", () => setUi({ rightOpen: !state.ui.rightOpen }));
    document.querySelector("#asCloseRightBtn").addEventListener("click", () => setUi({ rightOpen: false }));
    document.querySelector("#asNewChatBtn").addEventListener("click", newChat);
    document.querySelector("#asHistoryBtn").addEventListener("click", toggleHistoryPopover);
    document.querySelector("#asHistoryCloseBtn").addEventListener("click", hideHistoryPopover);
    document.querySelector("#asClearHistoryBtn").addEventListener("click", clearHistory);
    document.querySelector("#asModelBtn").addEventListener("click", toggleConfigPopover);
    document.querySelector("#asConfigCloseBtn").addEventListener("click", hideConfigPopover);
    document.querySelector("#asConfigForm").addEventListener("submit", saveConfig);
    document.querySelector("#asRewriteProvider").addEventListener("change", updateRewriteFields);
    document.querySelector("#asRunForm").addEventListener("submit", startRun);
    document.querySelector("#asAddFeedToggleBtn").addEventListener("click", toggleFeedAdd);
    document.querySelector("#asFeedSaveBtn").addEventListener("click", addFeed);
    document.querySelector("#asRefreshFeedBtn").addEventListener("click", refreshActiveFeed);
    document.querySelector("#asPickRssBtn").addEventListener("click", () => setUi({ leftOpen: true }));
    document.querySelector("#asBrowserBackBtn").addEventListener("click", () => browserCommand("back"));
    document.querySelector("#asBrowserForwardBtn").addEventListener("click", () => browserCommand("forward"));
    document.querySelector("#asBrowserReloadBtn").addEventListener("click", () => browserCommand("reload"));
    document.querySelector("#asBrowserGoBtn").addEventListener("click", () => navigateBrowser(document.querySelector("#asBrowserUrl").value));
    document.querySelector("#asBrowserUrl").addEventListener("keydown", (event) => {
      if (event.key === "Enter") navigateBrowser(document.querySelector("#asBrowserUrl").value);
    });
    document.querySelectorAll("#asSourceMode .as-seg").forEach((btn) => {
      btn.addEventListener("click", () => setSourceMode(btn.dataset.mode));
    });
    document.querySelectorAll("[data-right-tab]").forEach((btn) => {
      btn.addEventListener("click", () => setRightTab(btn.dataset.rightTab));
    });
    const editorPanel = document.querySelector("#asEditorPanel");
    const editorInput = document.querySelector("#asEditorInput");
    if (editorPanel) {
      editorPanel.addEventListener("click", (event) => {
        const button = event.target.closest("button");
        if (!button) return;
        if (button.classList.contains("as-sync-editor")) {
          syncEditorFromMain(true);
          state.editorTouched = true;
        } else if (button.dataset.asFormat) formatSidebarSelection(button.dataset.asFormat);
      });
    }
    if (editorInput) {
      editorInput.addEventListener("input", () => {
        state.editorTouched = true;
        writeEditorToMain(editorInput.value);
      });
      editorInput.addEventListener("keydown", (event) => {
        const isModifier = (event.metaKey || event.ctrlKey) && !event.altKey;
        const key = event.key.toLowerCase();
        if (isModifier && key === "b") {
          event.preventDefault();
          formatSidebarSelection("bold");
        } else if (isModifier && key === "i") {
          event.preventDefault();
          formatSidebarSelection("italic");
        }
      });
    }
    const previewPanel = document.querySelector("#asPreviewPanel");
    if (previewPanel) {
      previewPanel.addEventListener("click", (event) => {
        const button = event.target.closest("[data-preview-mode]");
        if (button) setPreviewMode(button.dataset.previewMode);
      });
    }
    document.querySelector("#agentStudioToggleBtn").addEventListener("click", toggle);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        hideConfigPopover();
        hideHistoryPopover();
      }
    });
    const chatEl = document.querySelector("#asChat");
    chatEl.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      if (button.classList.contains("as-copy-md")) copyMarkdown();
      else if (button.classList.contains("as-import-editor")) importIntoEditor();
    });
    root.addEventListener("click", (event) => {
      if (event.target.closest(".as-popover") || event.target.closest("#asModelBtn") || event.target.closest("#asHistoryBtn")) return;
      hideConfigPopover();
      hideHistoryPopover();
    });
    setupWebview();
  }

  function open() {
    if (state.open) return;
    state.open = true;
    const root = document.querySelector("#agentStudioRoot");
    root.hidden = false;
    document.querySelector("#agentStudioToggleBtn").classList.add("active");
    if (!state.activeFeedId && state.feeds.length) {
      state.activeFeedId = state.feeds[0].id;
    }
    setUi({ leftOpen: state.ui.leftOpen, rightOpen: state.ui.rightOpen });
    renderFeeds();
    renderFeedItems();
    renderRssSelected();
    renderChat();
    renderRight();
    refreshIcons();
    checkBackend().then(() => {
      loadConfig();
      loadHistory();
      if (state.activeRunId) refreshRun(state.activeRunId);
    });
    if (activeFeed() && !activeFeed().items.length) {
      fetchFeed(activeFeed());
    }
  }

  function close() {
    if (!state.open) return;
    state.open = false;
    document.querySelector("#agentStudioRoot").hidden = true;
    document.querySelector("#agentStudioToggleBtn").classList.remove("active");
    refreshIcons();
  }

  function toggle() {
    if (state.open) close();
    else open();
  }

  function isDesktopApp() {
    return Boolean(window.agentDesktop && window.agentDesktop.platform);
  }

  function setUi(patch) {
    Object.assign(state.ui, patch);
    saveUi();
    const root = document.querySelector("#agentStudioRoot");
    if (!root) return;
    root.classList.toggle("left-closed", !state.ui.leftOpen);
    root.classList.toggle("right-closed", !state.ui.rightOpen);
    updatePanelButtons();
    if (state.ui.rightOpen) renderRight();
    refreshIcons();
  }

  function updatePanelButtons() {
    const leftBtn = document.querySelector("#asToggleLeftBtn");
    const rightBtn = document.querySelector("#asToggleRightBtn");
    if (leftBtn) leftBtn.innerHTML = icon(state.ui.leftOpen ? "panel-left-close" : "panel-left-open");
    if (rightBtn) rightBtn.innerHTML = icon(state.ui.rightOpen ? "panel-right-close" : "panel-right-open");
  }

  async function checkBackend() {
    try {
      await api("/api/health");
      setBackendStatus(true, "本地后端已连接");
      return true;
    } catch {
      setBackendStatus(false, "本地后端未连接");
      return false;
    }
  }

  async function loadConfig() {
    if (!state.backendOk) {
      const ok = await checkBackend();
      if (!ok) return;
    }
    try {
      const config = await api("/api/config");
      state.config = config;
      document.querySelector("#asProvider").value = config.provider || "openai_compatible";
      document.querySelector("#asModel").value = config.model || "gpt-4o-mini";
      document.querySelector("#asBaseUrl").value = config.base_url || "";
      document.querySelector("#asApiKey").value = config.api_key || "";
      document.querySelector("#asTemperature").value = config.temperature ?? 0.7;
      document.querySelector("#asRewriteProvider").value = config.rewrite_provider || "llm";
      document.querySelector("#asPiProvider").value = config.pi_provider || "opencode-go";
      document.querySelector("#asPiTools").value =
        config.pi_tools === "" ? "" : config.pi_tools || "read,grep,find,ls";
      document.querySelector("#asPiSkill").value =
        config.pi_skill === "" ? "" : config.pi_skill || "~/.hermes/skills/futurism-fetcher";
      updateRewriteFields();
      renderModelBadge();
    } catch (error) {
      setBackendStatus(false, error.message);
    }
  }

  function renderModelBadge() {
    const label = document.querySelector("#asModelLabel");
    if (!label) return;
    const model = state.config?.model || "gpt-4o-mini";
    const rewrite =
      state.config?.rewrite_provider === "pi" ? " · 洗稿 Pi" : "";
    label.textContent = `${providerLabel(state.config?.provider || "openai_compatible")} · ${model}${rewrite}`;
  }

  function updateRewriteFields() {
    const isPi = document.querySelector("#asRewriteProvider")?.value === "pi";
    ["#asPiProviderField", "#asPiToolsField", "#asPiSkillField"].forEach((selector) => {
      const field = document.querySelector(selector);
      if (field) field.style.display = isPi ? "" : "none";
    });
  }

  function readConfigForm() {
    return {
      provider: document.querySelector("#asProvider").value,
      model: document.querySelector("#asModel").value.trim(),
      base_url: document.querySelector("#asBaseUrl").value.trim(),
      api_key: document.querySelector("#asApiKey").value.trim(),
      temperature: Number(document.querySelector("#asTemperature").value) || 0.7,
      rewrite_provider: document.querySelector("#asRewriteProvider").value,
      pi_provider: document.querySelector("#asPiProvider").value.trim() || "opencode-go",
      pi_tools: document.querySelector("#asPiTools").value.trim(),
      pi_skill: document.querySelector("#asPiSkill").value.trim(),
    };
  }

  async function saveConfig(event) {
    event.preventDefault();
    const payload = readConfigForm();
    try {
      state.config = await api("/api/config", {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      renderModelBadge();
      hideConfigPopover();
      toast("模型配置已保存到本机");
    } catch (error) {
      toast(error.message, "err");
    }
  }

  function toggleConfigPopover() {
    const popover = document.querySelector("#asConfigPopover");
    hideHistoryPopover();
    popover.hidden = !popover.hidden;
    if (!popover.hidden && !state.config) loadConfig();
  }

  function hideConfigPopover() {
    const popover = document.querySelector("#asConfigPopover");
    if (popover) popover.hidden = true;
  }

  function toggleHistoryPopover() {
    const popover = document.querySelector("#asHistoryPopover");
    hideConfigPopover();
    popover.hidden = !popover.hidden;
    if (!popover.hidden) loadHistory();
  }

  function hideHistoryPopover() {
    const popover = document.querySelector("#asHistoryPopover");
    if (popover) popover.hidden = true;
  }

  function setSourceMode(mode) {
    state.sourceMode = mode;
    document.querySelectorAll("#asSourceMode .as-seg").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.mode === mode);
    });
    const isRss = mode === "rss";
    document.querySelector("#asManualWrap").hidden = isRss;
    document.querySelector("#asRssWrap").hidden = !isRss;
    document.querySelector("#asComposerHint").textContent = isRss ? "在左侧勾选条目，自动作为素材" : "粘贴素材或选择 RSS 条目";
    refreshIcons();
  }

  function activeFeed() {
    return state.feeds.find((feed) => feed.id === state.activeFeedId) || state.feeds[0] || null;
  }

  function toggleFeedAdd() {
    const panel = document.querySelector("#asFeedAddPanel");
    panel.hidden = !panel.hidden;
    if (!panel.hidden) document.querySelector("#asFeedUrl").focus();
  }

  function addFeed() {
    const url = document.querySelector("#asFeedUrl").value.trim();
    if (!url) {
      toast("请先填写 RSS 地址", "err");
      return;
    }
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      toast("RSS 地址格式不正确", "err");
      return;
    }
    const name = document.querySelector("#asFeedName").value.trim() || parsed.hostname;
    const feed = {
      id: `feed_${Date.now()}`,
      name,
      url: parsed.href,
      items: [],
      readIds: [],
      loading: false,
      error: "",
    };
    state.feeds.push(feed);
    saveFeeds();
    state.activeFeedId = feed.id;
    document.querySelector("#asFeedUrl").value = "";
    document.querySelector("#asFeedName").value = "";
    document.querySelector("#asFeedAddPanel").hidden = true;
    renderFeeds();
    fetchFeed(feed);
  }

  function removeFeed(feedId) {
    if (!window.confirm("取消订阅这个 RSS 源？")) return;
    state.feeds = state.feeds.filter((feed) => feed.id !== feedId);
    state.rssItems = state.rssItems.filter((item) => item._feedId !== feedId);
    if (state.activeFeedId === feedId) {
      state.activeFeedId = state.feeds[0]?.id || null;
    }
    saveFeeds();
    renderFeeds();
    renderFeedItems();
    renderRssSelected();
  }

  async function fetchFeed(feed) {
    if (!feed) return;
    feed.loading = true;
    feed.error = "";
    renderFeedItems();
    try {
      const data = await api(`/api/rss/preview?url=${encodeURIComponent(feed.url)}&limit=30`);
      feed.items = data.items || [];
    } catch (error) {
      feed.items = [];
      feed.error = error.message;
    } finally {
      feed.loading = false;
      saveFeeds();
      renderFeeds();
      renderFeedItems();
      refreshIcons();
    }
  }

  function refreshActiveFeed() {
    const feed = activeFeed();
    if (!feed) {
      toast("请先添加 RSS 订阅", "err");
      return;
    }
    fetchFeed(feed);
  }

  function renderFeeds() {
    const list = document.querySelector("#asFeedList");
    if (!list) return;
    const feeds = state.feeds;
    if (!feeds.length) {
      list.innerHTML = `<div class="as-side-empty">${icon("rss")}还没有订阅源<br>点击右上角 + 添加 RSS。</div>`;
      refreshIcons();
      return;
    }
    list.innerHTML = feeds.map((feed) => {
      const active = feed.id === state.activeFeedId;
      const unread = feed.items.filter((item) => !isRead(feed, item)).length;
      return `
        <div class="as-feed-row ${active ? "active" : ""}" data-feed-id="${esc(feed.id)}">
          <button class="as-feed-main" type="button" data-feed-action="open">
            <span class="as-feed-name">${esc(feed.name || feed.url)}</span>
            <span class="as-feed-url">${esc(feed.url)}</span>
          </button>
          ${unread ? `<span class="as-feed-count">${unread}</span>` : ""}
          <button class="as-icon-btn as-feed-delete" type="button" data-feed-action="delete" title="取消订阅" aria-label="取消订阅">${icon("x")}</button>
        </div>
      `;
    }).join("");
    list.querySelectorAll("[data-feed-action]").forEach((button) => {
      const row = button.closest(".as-feed-row");
      const feedId = row.dataset.feedId;
      button.addEventListener("click", () => {
        if (button.dataset.feedAction === "delete") removeFeed(feedId);
        else activateFeed(feedId);
      });
    });
    refreshIcons();
  }

  function activateFeed(feedId) {
    state.activeFeedId = feedId;
    const feed = activeFeed();
    renderFeeds();
    if (feed && !feed.items.length) fetchFeed(feed);
    else renderFeedItems();
  }

  function itemReadId(item) {
    return item.link || item.guid || item.title || "";
  }

  function isRead(feed, item) {
    const id = itemReadId(item);
    return Boolean(id && feed.readIds.includes(id));
  }

  function markRead(feed, item) {
    const id = itemReadId(item);
    if (id && !feed.readIds.includes(id)) {
      feed.readIds.push(id);
      saveFeeds();
      renderFeeds();
      renderFeedItems();
    }
  }

  function renderFeedItems() {
    const list = document.querySelector("#asFeedItems");
    const title = document.querySelector("#asFeedItemsTitle");
    if (!list || !title) return;
    const feed = activeFeed();
    if (!feed) {
      title.textContent = "点阅条目";
      list.innerHTML = `<div class="as-side-empty">添加订阅后，条目会显示在这里。</div>`;
      refreshIcons();
      return;
    }
    title.textContent = `点阅 · ${feed.name}`;
    if (feed.loading) {
      list.innerHTML = `<div class="as-side-empty">${icon("loader-circle")}正在抓取条目…</div>`;
      refreshIcons();
      return;
    }
    if (feed.error) {
      list.innerHTML = `<div class="as-side-empty" style="color:var(--as-red,#d9534f);">${esc(feed.error)}</div>`;
      refreshIcons();
      return;
    }
    if (!feed.items.length) {
      list.innerHTML = `<div class="as-side-empty">这个源暂时没有可用条目。</div>`;
      refreshIcons();
      return;
    }
    list.innerHTML = feed.items.map((item, index) => {
      const read = isRead(feed, item);
      const key = itemKey(feed.id, item);
      const selected = state.rssItems.some((entry) => entry._key === key);
      const meta = [item.published, item.author].filter(Boolean).join(" · ");
      return `
        <div class="as-feed-item ${read ? "read" : ""}" data-index="${index}">
          <label class="as-feed-check" title="用于创作">
            <input type="checkbox" data-item-index="${index}" ${selected ? "checked" : ""} />
          </label>
          <button class="as-feed-item-main" type="button" data-item-index="${index}">
            ${item.image ? `<img class="as-feed-item-thumb" src="${esc(item.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : ""}
            <span class="as-feed-item-title">${esc(item.title || "未命名条目")}</span>
            ${meta ? `<span class="as-feed-item-meta">${esc(meta)}</span>` : ""}
            ${item.summary ? `<span class="as-feed-item-summary">${esc(item.summary)}</span>` : ""}
          </button>
        </div>
      `;
    }).join("");
    list.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
      checkbox.addEventListener("change", () => {
        const item = feed.items[Number(checkbox.dataset.itemIndex)];
        toggleRssItem(item, checkbox.checked, feed);
      });
    });
    list.querySelectorAll(".as-feed-item-main").forEach((button) => {
      button.addEventListener("click", () => {
        const item = feed.items[Number(button.dataset.itemIndex)];
        openRssItem(feed, item);
      });
    });
    refreshIcons();
  }

  const STATUS_LABELS = {
    queued: "排队中",
    running: "运行中",
    completed: "已完成",
    failed: "失败",
  };

  function statusLabel(status) {
    return STATUS_LABELS[status] || status || "未知";
  }

  function itemKey(feedId, item) {
    return `${feedId}::${item.link || item.guid || item.title || ""}`;
  }

  function toggleRssItem(item, checked, feed) {
    const key = itemKey(feed.id, item);
    if (checked) {
      if (!state.rssItems.some((entry) => entry._key === key)) {
        state.rssItems.push({ ...item, _feedId: feed.id, _key: key });
      }
      markRead(feed, item);
    } else {
      state.rssItems = state.rssItems.filter((entry) => entry._key !== key);
    }
    renderRssSelected();
    renderFeedItems();
  }

  function openRssItem(feed, item) {
    markRead(feed, item);
    if (item.link) {
      state.rightTab = "browser";
      setUi({ rightOpen: true });
      navigateBrowser(item.link);
    }
  }

  function renderRssSelected() {
    const list = document.querySelector("#asRssSelectedList");
    const text = document.querySelector("#asRssSelectedText");
    if (!list || !text) return;
    text.textContent = `已选 ${state.rssItems.length} 条 RSS 素材`;
    list.innerHTML = state.rssItems.length
      ? state.rssItems
          .map((item, index) => {
            const label = String(item.title || item.link || "未命名条目");
            return `<button class="as-chip" type="button" data-remove-index="${index}" title="移除素材">${esc(label)}${icon("x")}</button>`;
          })
          .join("")
      : `<span class="as-rss-empty">还没有勾选条目</span>`;
    list.querySelectorAll("[data-remove-index]").forEach((chip) => {
      chip.addEventListener("click", () => {
        state.rssItems.splice(Number(chip.dataset.removeIndex), 1);
        renderRssSelected();
        renderFeedItems();
      });
    });
    refreshIcons();
  }

  function activeMarkdown() {
    return state.previewMarkdown || state.activeRun?.result?.markdown || "";
  }

  function renderChat() {
    const chat = document.querySelector("#asChat");
    if (!chat) return;
    const runState = document.querySelector("#asRunState");
    if (runState) {
      runState.textContent = state.running
        ? "运行中"
        : state.activeRun
          ? statusLabel(state.activeRun.status)
          : "";
      runState.classList.toggle("running", state.running);
    }
    if (!state.messages.length && !state.activeRun) {
      chat.innerHTML = `
        <div class="as-chat-empty">
          <div class="as-chat-empty-icon">${icon("workflow")}</div>
          <strong>洗稿工作台</strong>
          <span>素材一次交给洗稿编辑，Pi Agent 按 Futurism 技能直接改写成稿。</span>
          <span class="as-chat-empty-sub">在左侧点阅 RSS，勾选素材，或在下方粘贴手动素材后开始运行。</span>
        </div>
      `;
      refreshIcons();
      return;
    }
    chat.innerHTML = state.messages
      .map((message) => {
        if (message.kind === "user") return renderUserMessage(message);
        if (message.kind === "run") {
          const run =
            message.runId === state.activeRunId
              ? state.activeRun
              : state.runs.find((item) => item.id === message.runId);
          return run ? renderRunBlock(run) : "";
        }
        return "";
      })
      .join("");
    refreshIcons();
    chat.scrollTop = chat.scrollHeight;
  }

  function renderUserMessage(message) {
    return `
      <div class="as-user-msg">
        <div class="as-user-head">
          <span class="as-user-avatar">${icon("user")}</span>
          <span class="as-user-meta">${esc(message.platform || "素材")} · ${esc(message.tone || "")} · ${esc(message.goal || "创作目标")}</span>
        </div>
        <div class="as-user-text">${esc(message.text)}</div>
      </div>
    `;
  }

  function renderRunBlock(run) {
    const status = run.status || "queued";
    const goal = run.request?.goal || run.goal || "创作任务";
    const platform = run.request?.platform || run.platform || "";
    const tone = run.request?.tone || "";
    const words = run.request?.word_count || "";
    const model = run.config?.model || run.model || "";
    const events = run.events || [];
    return `
      <div class="as-run-msg" data-run-id="${esc(run.id)}">
        <div class="as-run-head">
          <div class="as-run-title-wrap">
            <div class="as-run-title">${icon("bot")}<strong>${esc(run.result?.title || "洗稿任务")}</strong></div>
            <span class="as-run-goal">${esc(goal)}</span>
          </div>
          <span class="as-badge ${status}">${icon(statusIcon(status))}${esc(statusLabel(status))}</span>
        </div>
        <div class="as-run-meta">${[platform, tone, words ? `${words} 字` : "", model].filter(Boolean).join(" · ")}</div>
        <div class="as-run-body">
          ${renderTimeline(events, status)}
          ${run.result ? renderFinalBlock(run.result) : ""}
          ${run.error ? `<div class="as-err-box">${icon("triangle-alert")}${esc(run.error)}</div>` : ""}
        </div>
      </div>
    `;
  }

  function statusIcon(status) {
    if (status === "completed") return "check-circle-2";
    if (status === "failed") return "circle-alert";
    if (status === "running") return "loader-circle";
    return "clock";
  }

  function renderTimeline(events, status) {
    if (!events || !events.length) {
      return status === "running" || status === "queued"
        ? `<div class="as-timeline"><div class="as-timeline-item pending"><span class="as-timeline-dot">${icon("loader-circle")}</span><span class="as-timeline-title">正在准备洗稿…</span></div></div>`
        : "";
    }
    const items = [];
    events.forEach((event) => {
      if (event.type === "status") {
        if (event.status === "running") {
          items.push(timelineItem("play", "洗稿已启动", "素材已进入洗稿编辑"));
        }
        return;
      }
      if (event.type === "rss") {
        if (event.status === "fetching") items.push(timelineItem("rss", "抓取 RSS 素材", esc(event.url || "")));
        else if (event.status === "ok") items.push(timelineItem("check", "RSS 素材已就绪", `已读取 ${event.count || 0} 条条目作为素材`));
        else if (event.status === "error") items.push(timelineItem("triangle-alert", "RSS 抓取失败", esc(event.error || ""), "error"));
        return;
      }
      if (event.type === "node") {
        const data = event.data || {};
        const node = event.node;
        if (node === "expert") {
          (data.drafts || []).forEach((draft) => {
            items.push(
              timelineItem(
                "pen-line",
                `洗稿编辑：完整改写`,
                `完成「${esc(draft.section || "全文")}」`,
              ),
            );
          });
        } else if (node === "finalize") {
          const final = data.final || {};
          items.push(
            timelineItem(
              "list-checks",
              "成稿与发布清单",
              `字数 ${final.word_count || 0}`,
            ),
          );
        }
      }
    });
    if (!items.length) return "";
    return `<div class="as-timeline">${items.join("")}</div>`;
  }

  function timelineItem(iconName, title, detail, tone = "") {
    return `
      <div class="as-timeline-item ${tone}">
        <span class="as-timeline-dot">${icon(iconName)}</span>
        <div class="as-timeline-content">
          <div class="as-timeline-title">${title}</div>
          ${detail ? `<div class="as-timeline-detail">${detail}</div>` : ""}
        </div>
      </div>
    `;
  }

  function renderFinalBlock(final) {
    const review = final.review || {};
    const scores = Object.entries(review.scores || {});
    const checklist = Array.isArray(final.checklist) ? final.checklist : [];
    return `
      <div class="as-final">
        <div class="as-final-head">${icon("sparkles")}<strong>成稿与发布清单</strong></div>
        <div class="as-final-body">
          <h3>${esc(final.title || "未命名内容")}</h3>
          <div class="as-final-meta">${[final.platform ? `平台：${esc(final.platform)}` : "", `字数：${final.word_count || 0}`, `修订：${final.revisions || 0} 次`].filter(Boolean).join(" · ")}</div>
          ${scores.length ? `<div class="as-review-scores">${scores.map(([key, value]) => `<span class="as-score">${esc(key)}<strong>${esc(value)}</strong></span>`).join("")}</div>` : ""}
          ${review.summary ? `<p class="as-review-summary">${esc(review.summary)}</p>` : ""}
          ${review.issues?.length ? `<ul class="as-issues">${review.issues.map((issue) => `<li>${esc(issue)}</li>`).join("")}</ul>` : ""}
          ${checklist.length ? `<div class="as-checklist">${checklist.map((item) => `<div class="as-check ${item.ok ? "ok" : "no"}">${icon(item.ok ? "check" : "x")}${esc(item.label)}</div>`).join("")}</div>` : ""}
          <div class="as-final-actions">
            <button class="as-btn as-copy-md" type="button">${icon("copy")}复制 Markdown</button>
            <button class="as-btn as-import-editor" type="button">${icon("import")}导入编辑器</button>
          </div>
        </div>
      </div>
    `;
  }

  function renderRight() {
    if (!state.ui.rightOpen) return;
    if (state.rightTab === "browser") renderBrowser(state.browserUrl);
    else if (state.rightTab === "editor") syncEditorFromMain();
    else renderPreview(activeMarkdown());
  }

  function setRightTab(tab) {
    state.rightTab = tab === "browser" || tab === "editor" ? tab : "preview";
    document.querySelectorAll("[data-right-tab]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.rightTab === state.rightTab);
    });
    const preview = document.querySelector("#asPreviewPanel");
    const browser = document.querySelector("#asBrowserPanel");
    const editor = document.querySelector("#asEditorPanel");
    if (preview) preview.hidden = state.rightTab !== "preview";
    if (browser) browser.hidden = state.rightTab !== "browser";
    if (editor) editor.hidden = state.rightTab !== "editor";
    renderRight();
  }

  function syncEditorFromMain(forceMain = false) {
    const input = document.querySelector("#asEditorInput");
    const contentInput = document.querySelector("#contentInput");
    if (!input || !contentInput) return;
    let next = contentInput.value;
    if (!forceMain && !state.editorTouched) {
      const draft = activeMarkdown();
      if (draft) next = draft;
    }
    if (input.value === next) return;
    input.value = next;
  }

  function writeEditorToMain(text) {
    const contentInput = document.querySelector("#contentInput");
    if (!contentInput) return;
    if (contentInput.value === text) return;
    contentInput.value = text;
    contentInput.dispatchEvent(new Event("input", { bubbles: true }));
    state.previewMarkdown = text;
    renderPreview(text);
  }

  function formatSidebarSelection(kind) {
    const input = document.querySelector("#asEditorInput");
    if (!input) return;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const selected = input.value.slice(start, end) || "文字";
    let next = selected;
    let cursorOffset = null;

    if (kind === "bold") {
      next = `**${selected}**`;
      cursorOffset = selected === "文字" ? 2 : null;
    } else if (kind === "italic") {
      next = `*${selected}*`;
      cursorOffset = selected === "文字" ? 1 : null;
    } else if (kind === "h1" || kind === "h2" || kind === "quote") {
      const prefix = kind === "h1" ? "# " : kind === "h2" ? "## " : "> ";
      const lineStart = input.value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
      input.value = `${input.value.slice(0, lineStart)}${prefix}${input.value.slice(lineStart)}`;
      input.focus();
      input.setSelectionRange(start + prefix.length, end + prefix.length);
      writeEditorToMain(input.value);
      return;
    }

    input.value = `${input.value.slice(0, start)}${next}${input.value.slice(end)}`;
    if (cursorOffset !== null) {
      input.focus();
      input.setSelectionRange(start + cursorOffset, start + cursorOffset + selected.length);
    } else {
      input.focus();
      input.setSelectionRange(start + next.length, start + next.length);
    }
    writeEditorToMain(input.value);
  }

  function previewDocument(markdown) {
    return `<!doctype html><html><head><meta charset="utf-8"><style>
      body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:#1f2733;background:#fff;margin:0;padding:28px 32px 48px;line-height:1.7;font-size:15px;max-width:760px;}
      h1{font-size:26px;line-height:1.35;margin:0 0 14px;}
      h2{font-size:20px;margin:26px 0 10px;}
      h3{font-size:17px;margin:22px 0 8px;}
      p{margin:10px 0;}
      blockquote{border-left:3px solid #d7dee8;margin:14px 0;padding:2px 14px;color:#59636e;background:#f7f9fc;}
      code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;background:#f1f4f8;padding:1px 5px;border-radius:5px;}
      pre{background:#0f172a;color:#e6edf3;padding:14px 16px;border-radius:8px;overflow:auto;}
      pre code{background:transparent;color:inherit;padding:0;}
      a{color:#2563eb;text-decoration:none;}
      a:hover{text-decoration:underline;}
      table{border-collapse:collapse;margin:14px 0;width:100%;}
      th,td{border:1px solid #dce2ea;padding:7px 10px;text-align:left;font-size:14px;}
      th{background:#f7f9fc;}
      ul,ol{padding-left:22px;margin:10px 0;}
      li{margin:4px 0;}
      hr{border:0;border-top:1px solid #dce2ea;margin:22px 0;}
      img{max-width:100%;border-radius:8px;}
    </style></head><body>${markdownToHtml(markdown)}</body></html>`;
  }

  function markdownToHtml(markdown) {
    const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
    const html = [];
    let inCode = false;
    let paragraph = [];

    const flushParagraph = () => {
      if (!paragraph.length) return;
      html.push(`<p>${paragraph.join("<br>")}</p>`);
      paragraph = [];
    };

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const codeFence = line.match(/^```/);
      if (codeFence) {
        flushParagraph();
        if (inCode) {
          html.push("</code></pre>");
          inCode = false;
        } else {
          html.push("<pre><code>");
          inCode = true;
        }
        continue;
      }
      if (inCode) {
        html.push(esc(line));
        continue;
      }
      const trimmed = line.trim();
      if (!trimmed) {
        flushParagraph();
        continue;
      }
      const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
      if (heading) {
        flushParagraph();
        const level = heading[1].length;
        html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
        continue;
      }
      if (/^> /.test(trimmed)) {
        flushParagraph();
        const quote = [];
        while (index < lines.length && /^> ?/.test(lines[index].trim())) {
          quote.push(inlineMarkdown(lines[index].trim().replace(/^> ?/, "")));
          index += 1;
        }
        index -= 1;
        html.push(`<blockquote>${quote.join("<br>")}</blockquote>`);
        continue;
      }
      if (/^([-*+]|\d+[.)])\s+/.test(trimmed)) {
        flushParagraph();
        const listTag = /^[-*+]/.test(trimmed) ? "ul" : "ol";
        const items = [];
        while (index < lines.length && /^([-*+]|\d+[.)])\s+/.test(lines[index].trim())) {
          items.push(`<li>${inlineMarkdown(lines[index].trim().replace(/^([-*+]|\d+[.)])\s+/, ""))}</li>`);
          index += 1;
        }
        index -= 1;
        html.push(`<${listTag}>${items.join("")}</${listTag}>`);
        continue;
      }
      const tableMatch = trimmed.match(/^\|/);
      const nextIsSeparator = lines[index + 1] && /^\|?[\s:-]+\|/.test(lines[index + 1].trim());
      if (tableMatch && nextIsSeparator) {
        flushParagraph();
        const header = splitTableRow(trimmed);
        index += 1;
        const rows = [];
        while (index + 1 < lines.length && /^\|/.test(lines[index + 1].trim())) {
          rows.push(splitTableRow(lines[index + 1].trim()));
          index += 1;
        }
        html.push(`<table><thead><tr>${header.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
        continue;
      }
      if (/^([-*_])(?:\s*\1){2,}\s*$/.test(trimmed)) {
        flushParagraph();
        html.push("<hr>");
        continue;
      }
      paragraph.push(inlineMarkdown(trimmed));
    }
    if (inCode) html.push("</code></pre>");
    flushParagraph();
    return html.join("\n");
  }

  function splitTableRow(line) {
    return line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
  }

  function inlineMarkdown(text) {
    return esc(text)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/!\[([^\]]*)\]\((?:<([^>]+)>|([^\s)]+))(?:\s+[^)]*)?\)/g, '<img src="$2$3" alt="$1" loading="lazy">')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }

  async function renderPreview(markdown) {
    const frame = document.querySelector("#asPreviewFrame");
    const copyBtn = document.querySelector(".as-copy-md");
    const importBtn = document.querySelector(".as-import-editor");
    if (!frame) return;
    const hasContent = Boolean(markdown && markdown.trim());
    if (copyBtn) copyBtn.disabled = !hasContent;
    if (importBtn) importBtn.disabled = !hasContent;
    if (!hasContent) {
      frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;color:#8a94a3;background:#fafbfc;font-size:14px;}</style></head><body>运行完成后，成稿预览会显示在这里</body></html>`;
      return;
    }
    const renderSeq = (state.previewRenderSeq = (state.previewRenderSeq || 0) + 1);
    const html = state.previewMode === "cards"
      ? await previewCards(markdown)
      : previewDocument(await materializeMarkdownImages(markdown));
    if (renderSeq !== state.previewRenderSeq) return;
    frame.srcdoc = html;
  }

  function setPreviewMode(mode) {
    const next = mode === "article" ? "article" : "cards";
    if (state.previewMode === next) return;
    state.previewMode = next;
    document.querySelectorAll("[data-preview-mode]").forEach((button) => {
      button.classList.toggle("active", button.dataset.previewMode === state.previewMode);
    });
    void renderPreview(activeMarkdown());
  }

  async function previewCards(markdown) {
    if (typeof window.readForm !== "function" || typeof window.buildPages !== "function" || typeof window.renderPage !== "function") {
      return previewDocument(markdown);
    }
    const prepared = await registerRemoteImages(markdown, window.readForm().images);
    const settings = { ...window.readForm(), content: prepared.content, images: prepared.images };
    const previousHeight = window.CANVAS_HEIGHT;
    try {
      window.CANVAS_HEIGHT = window.getCardHeight
        ? window.getCardHeight(settings.cardRatio)
        : window.CANVAS_HEIGHT;
      const pages = await window.buildPages(settings);
      const canvases = pages.map((page, index) => window.renderPage(page, index, pages.length));
      const cards = canvases
        .map((canvas, index) => {
          const dataUrl = canvas.toDataURL("image/png");
          return `
            <figure class="as-card">
              <img src="${dataUrl}" alt="图文卡片第 ${index + 1} 页">
              <figcaption>第 ${index + 1} / ${canvases.length} 页 · ${canvas.width}×${canvas.height}</figcaption>
            </figure>`;
        })
        .join("");
      return `<!doctype html><html><head><meta charset="utf-8"><style>
        body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;margin:0;padding:20px;background:#eef1f5;color:#1f2733;}
        .as-card-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;max-width:640px;margin:0 auto 12px;padding:0 4px;font-size:12px;color:#59636e;}
        .as-card-head strong{font-size:14px;color:#1f2733;}
        .as-card{margin:0 auto 22px;max-width:640px;}
        .as-card img{display:block;width:100%;height:auto;border-radius:8px;box-shadow:0 8px 24px rgba(23,32,47,.14);background:#fff;}
        .as-card figcaption{margin-top:8px;text-align:center;font-size:12px;color:#8a94a3;}
      </style></head><body>
        <div class="as-card-head"><strong>图文卡片预览</strong><span>${canvases.length} 张 · ${settings.cardRatio || ""}</span></div>
        ${cards || "<p style=\"text-align:center;color:#8a94a3;\">暂无卡片内容</p>"}
      </body></html>`;
    } catch {
      return previewDocument(markdown);
    } finally {
      window.CANVAS_HEIGHT = previousHeight;
    }
  }

  function normalizeUrl(url) {
    const trimmed = String(url || "").trim();
    if (!trimmed) return "";
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) return trimmed;
    return `https://${trimmed}`;
  }

  function renderBrowser(url) {
    const input = document.querySelector("#asBrowserUrl");
    if (input && input.value !== url) input.value = url;
    const webview = document.querySelector("#asWebview");
    const fallback = document.querySelector("#asBrowserFallback");
    if (!webview || !fallback) return;
    const useFallback = state.browserFallback || !isDesktopApp();
    webview.hidden = useFallback;
    fallback.hidden = !useFallback;
    if (useFallback) {
      if (fallback.src !== url) fallback.src = url;
    } else if (webview.src !== url) {
      webview.src = url;
    }
  }

  function navigateBrowser(url) {
    const normalized = normalizeUrl(url);
    if (!normalized) return;
    state.browserUrl = normalized;
    renderBrowser(normalized);
  }

  function browserCommand(action) {
    const webview = document.querySelector("#asWebview");
    const fallback = document.querySelector("#asBrowserFallback");
    const useFallback = state.browserFallback || !isDesktopApp();
    if (!useFallback && webview) {
      if (action === "back") webview.goBack();
      else if (action === "forward") webview.goForward();
      else if (action === "reload") webview.reload();
      return;
    }
    if (fallback?.contentWindow) {
      if (action === "back") fallback.contentWindow.history.back();
      else if (action === "forward") fallback.contentWindow.history.forward();
      else if (action === "reload") fallback.src = fallback.src;
    }
  }

  function setupWebview() {
    const webview = document.querySelector("#asWebview");
    const fallback = document.querySelector("#asBrowserFallback");
    if (!webview || !fallback) return;
    state.browserFallback = !isDesktopApp();
    webview.hidden = state.browserFallback;
    fallback.hidden = !state.browserFallback;
    if (state.browserFallback) {
      if (state.browserUrl) renderBrowser(state.browserUrl);
      return;
    }
    const syncUrl = (event) => {
      if (!event.url) return;
      state.browserUrl = event.url;
      const input = document.querySelector("#asBrowserUrl");
      if (input) input.value = event.url;
    };
    webview.addEventListener("did-navigate", syncUrl);
    webview.addEventListener("did-navigate-in-page", syncUrl);
  }

  function readRunPayload() {
    const goal = document.querySelector("#asGoal").value.trim();
    const platform = document.querySelector("#asPlatform").value;
    const tone = document.querySelector("#asTone").value;
    const wordCount = Number(document.querySelector("#asWords").value) || 1200;
    const revisions = Number(document.querySelector("#asRevisions").value) || 2;
    if (state.sourceMode === "rss") {
      if (!state.rssItems.length) {
        toast("请先在左侧勾选 RSS 条目", "err");
        return null;
      }
      return {
        source_material: "",
        rss_url: activeFeed()?.url || "",
        rss_limit: 8,
        rss_items: state.rssItems.map((item) => {
          const { _key, _feedId, ...rest } = item;
          return rest;
        }),
        goal,
        platform,
        tone,
        word_count: wordCount,
        max_revisions: revisions,
      };
    }
    const manual = document.querySelector("#asSource").value.trim();
    if (!manual) {
      toast("请先粘贴素材，或在左侧勾选 RSS 条目", "err");
      return null;
    }
    return {
      source_material: manual,
      rss_url: "",
      rss_limit: 8,
      rss_items: [],
      goal,
      platform,
      tone,
      word_count: wordCount,
      max_revisions: revisions,
    };
  }

  async function startRun(event) {
    event.preventDefault();
    if (state.running) return;
    if (!state.backendOk) {
      const ok = await checkBackend();
      if (!ok) {
        toast("本地后端未连接，请检查后端服务", "err");
        return;
      }
    }
    const payload = readRunPayload();
    if (!payload) return;
    if (state.config) payload.config = state.config;
    let run;
    try {
      run = await api("/api/runs", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    } catch (error) {
      toast(error.message, "err");
      return;
    }
    const displayText =
      state.sourceMode === "rss"
        ? `选择 ${payload.rss_items.length} 条 RSS 素材：${payload.rss_items
            .slice(0, 3)
            .map((item) => item.title)
            .filter(Boolean)
            .join("、")}${payload.rss_items.length > 3 ? " 等" : ""}`
        : payload.source_material.slice(0, 240) + (payload.source_material.length > 240 ? "…" : "");
    state.activeRunId = run.id;
    state.activeRun = run;
    state.previewMarkdown = "";
    state.editorTouched = false;
    state.running = true;
    state.messages.push({ kind: "user", text: displayText, goal: payload.goal, platform: payload.platform, tone: payload.tone });
    state.messages.push({ kind: "run", runId: run.id });
    document.querySelector("#asSource").value = "";
    renderRssSelected();
    renderChat();
    renderRight();
    subscribe(run.id);
    startPolling(run.id);
    loadHistory();
  }

  function handleRunEvent(runId, eventData) {
    if (runId !== state.activeRunId || !state.activeRun) return;
    state.activeRun.events = state.activeRun.events || [];
    state.activeRun.events.push(eventData);
    if (eventData.type === "status") state.activeRun.status = eventData.status;
    if (eventData.type === "node") state.activeRun.status = "running";
    if (eventData.type === "result") {
      state.activeRun.status = "completed";
      state.activeRun.result = eventData.result;
      state.editorTouched = false;
      state.running = false;
      stopPolling();
    }
    if (eventData.type === "error") {
      state.activeRun.status = "failed";
      state.activeRun.error = eventData.error;
      state.running = false;
      stopPolling();
    }
    renderChat();
    renderRight();
  }

  function subscribe(runId) {
    if (state.eventSource) {
      state.eventSource.close();
      state.eventSource = null;
    }
    const source = new EventSource(`/api/runs/${runId}/events`);
    state.eventSource = source;
    source.addEventListener("status", (event) => handleRunEvent(runId, JSON.parse(event.data)));
    source.addEventListener("rss", (event) => handleRunEvent(runId, JSON.parse(event.data)));
    source.addEventListener("node", (event) => handleRunEvent(runId, JSON.parse(event.data)));
    source.addEventListener("result", (event) => handleRunEvent(runId, JSON.parse(event.data)));
    source.addEventListener("error", (event) => {
      try {
        handleRunEvent(runId, JSON.parse(event.data));
      } catch {
        // stream-level error
      }
    });
    source.onerror = () => {
      if (source !== state.eventSource) return;
      source.close();
      state.eventSource = null;
      refreshRun(runId);
    };
  }

  function startPolling(runId) {
    stopPolling();
    state.pollTimer = window.setInterval(() => {
      if (runId !== state.activeRunId) {
        stopPolling();
        return;
      }
      refreshRun(runId);
    }, 2000);
  }

  function stopPolling() {
    if (state.pollTimer) {
      window.clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  async function refreshRun(runId) {
    try {
      const run = await api(`/api/runs/${runId}`);
      if (runId === state.activeRunId) {
        state.activeRun = run;
        state.running = run.status === "queued" || run.status === "running";
        if (run.status === "completed") state.editorTouched = false;
        if (run.status === "completed" || run.status === "failed") stopPolling();
        renderChat();
        renderRight();
      }
      loadHistory();
    } catch {
      // run may have been cleared
    }
  }

  async function openRun(runId) {
    let run;
    try {
      run = await api(`/api/runs/${runId}`);
    } catch (error) {
      toast(error.message, "err");
      return;
    }
    hideHistoryPopover();
    state.activeRunId = runId;
    state.activeRun = run;
    state.previewMarkdown = "";
    state.editorTouched = false;
    state.running = run.status === "queued" || run.status === "running";
    if (!state.messages.some((message) => message.kind === "run" && message.runId === runId)) {
      state.messages.push({ kind: "run", runId });
    }
    renderChat();
    renderRight();
    if (state.running) {
      subscribe(runId);
      startPolling(runId);
    } else {
      stopPolling();
      loadHistory();
    }
  }

  function newChat() {
    stopPolling();
    if (state.eventSource) {
      state.eventSource.close();
      state.eventSource = null;
    }
    state.activeRunId = null;
    state.activeRun = null;
    state.running = false;
    state.messages = [];
    state.previewMarkdown = "";
    state.editorTouched = false;
    state.rssItems = [];
    const source = document.querySelector("#asSource");
    if (source) source.value = "";
    renderRssSelected();
    renderChat();
    renderRight();
    toast("已新建对话");
  }

  async function copyMarkdown() {
    const markdown = activeMarkdown();
    if (!markdown) {
      toast("还没有可复制的成稿", "err");
      return;
    }
    try {
      await navigator.clipboard.writeText(markdown);
      toast("Markdown 已复制");
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = markdown;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
      toast("Markdown 已复制");
    }
  }

  async function importIntoEditor() {
    const markdown = activeMarkdown();
    if (!markdown) {
      toast("还没有可导入的成稿", "err");
      return;
    }
    if (await markdownToEditor(markdown)) {
      toast("已导入编辑器，可返回排版");
    } else {
      toast("编辑器未就绪，请先回到主页面", "err");
    }
  }

  async function markdownToEditor(markdown) {
    const contentInput = document.querySelector("#contentInput");
    if (!contentInput) return false;
    const currentImages = typeof window.readForm === "function" ? window.readForm().images : {};
    const prepared = await registerRemoteImages(markdown, currentImages);
    let data = { content: prepared.content, images: prepared.images };
    if (typeof window.readForm === "function") {
      data = { ...window.readForm(), content: prepared.content, images: prepared.images };
    }
    if (typeof window.applyForm === "function") window.applyForm(data);
    if (typeof window.render === "function") window.render();
    syncEditorFromMain();
    return true;
  }

  async function loadHistory() {
    if (!state.backendOk) return;
    try {
      state.runs = await api("/api/runs");
      renderHistory();
    } catch {
      // backend temporarily unavailable
    }
  }

  function renderHistory() {
    const list = document.querySelector("#asHistoryList");
    if (!list) return;
    if (!state.runs.length) {
      list.innerHTML = `<div class="as-empty">还没有运行记录<br>完成一次洗稿后会出现在这里。</div>`;
      refreshIcons();
      return;
    }
    list.innerHTML = state.runs
      .map((run) => {
        const active = run.id === state.activeRunId;
        return `
          <button class="as-run-card ${active ? "active" : ""}" type="button" data-run-id="${esc(run.id)}">
            <div class="as-run-row">
              <span class="as-run-title">${esc(run.title || run.goal || "未命名任务")}</span>
              <span class="as-badge ${run.status}">${esc(statusLabel(run.status))}</span>
            </div>
            <div class="as-run-meta">${[run.platform, run.model, fmtTime(run.created_at)].filter(Boolean).join(" · ")}</div>
          </button>
        `;
      })
      .join("");
    list.querySelectorAll("[data-run-id]").forEach((button) => {
      button.addEventListener("click", () => openRun(button.dataset.runId));
    });
    refreshIcons();
  }

  async function clearHistory() {
    try {
      await api("/api/runs", { method: "DELETE" });
      state.runs = [];
      renderHistory();
      toast("运行历史已清空");
    } catch (error) {
      toast(error.message, "err");
    }
  }

  function init() {
    buildDom();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
