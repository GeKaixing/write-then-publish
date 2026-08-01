const { Plugin, ItemView, Notice } = require("obsidian");

const VIEW_TYPE = "write-then-publish-view";

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  if (typeof Buffer !== "undefined") {
    return Buffer.from(binary, "binary").toString("base64");
  }
  return btoa(binary);
}

function sanitizeFileName(filename) {
  const base = String(filename || "export")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 96);
  return base || "export";
}

module.exports = class WriteThenPublishPlugin extends Plugin {
  async onload() {
    this.data = (await this.loadData()) || {};
    if (!this.data.storage) this.data.storage = {};
    if (!this.data.media) this.data.media = {};

    this.editorView = null;
    this._assetCache = {};
    this._editorHtml = null;
    this._saveTimer = null;

    this.registerView(VIEW_TYPE, (leaf) => {
      const view = new WriteThenPublishView(leaf, this);
      this.editorView = view;
      return view;
    });

    this.addCommand({
      id: "open-write-then-publish",
      name: "打开「写了就发」",
      callback: () => {
        void this.activateView();
      },
    });

    this.addCommand({
      id: "import-active-note",
      name: "将当前笔记导入「写了就发」",
      callback: () => {
        void this.importActiveNote();
      },
    });
  }

  async onunload() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
      try {
        await this.saveData(this.data);
      } catch {
        // Best-effort flush when the plugin is disabled.
      }
    }
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  async importActiveNote() {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      new Notice("请先打开一个 Obsidian 笔记");
      return;
    }
    if (!this.editorView) {
      await this.activateView();
    }
    if (!this.editorView) {
      new Notice("「写了就发」面板没有成功打开");
      return;
    }
    const markdown = await this.app.vault.read(activeFile);
    if (this.editorView) {
      try {
        await this.editorView.awaitBridgeReady();
        const result = await this.editorView.requestImport(markdown);
        const imported = Number(result?.imported) || 0;
        const unresolved = (result?.unresolved || []).length;
        new Notice(
          `已将「${activeFile.basename}」导入写了就发：${imported} 张图片${unresolved ? `，${unresolved} 个引用未解析` : ""}`,
        );
      } catch (error) {
        new Notice(`导入失败：${String(error?.message || error)}`);
      }
      return;
    }
    new Notice(`已将「${activeFile.basename}」导入写了就发`);
  }

  scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      void this.saveData(this.data);
    }, 400);
  }

  pluginBasePath() {
    return `.obsidian/plugins/${this.manifest?.id || "write-then-publish"}`;
  }

  assetDir() {
    return `${this.pluginBasePath()}/plugin-assets`;
  }

  async readAssetText(relPath) {
    const cacheKey = `text:${relPath}`;
    if (this._assetCache[cacheKey] !== undefined) return this._assetCache[cacheKey];
    const text = await this.app.vault.adapter.read(`${this.assetDir()}/${relPath}`);
    this._assetCache[cacheKey] = text;
    return text;
  }

  async readAssetDataUrl(relPath, mimeType) {
    const cacheKey = `data:${relPath}`;
    if (this._assetCache[cacheKey] !== undefined) return this._assetCache[cacheKey];
    const buffer = await this.app.vault.adapter.readBinary(`${this.assetDir()}/${relPath}`);
    const dataUrl = `data:${mimeType};base64,${arrayBufferToBase64(buffer)}`;
    this._assetCache[cacheKey] = dataUrl;
    return dataUrl;
  }

  async buildEditorHtml() {
    if (this._editorHtml) return this._editorHtml;

    const [indexHtml, css, appJs, jszipJs, html2canvasJs, lucideJs, bridgeJs, overridesJs, avatarDataUrl] =
      await Promise.all([
        this.readAssetText("index.html"),
        this.readAssetText("src/styles.css"),
        this.readAssetText("src/app.js"),
        this.readAssetText("vendor/jszip.min.js"),
        this.readAssetText("vendor/html2canvas.min.js"),
        this.readAssetText("vendor/lucide.min.js"),
        this.readAssetText("bridge.js"),
        this.readAssetText("overrides.js"),
        this.readAssetDataUrl("img/esther-buer-avatar.png", "image/png"),
      ]);

    const patchedAppJs = appJs.replace(
      'const sampleAvatar = "assets/esther-buer-avatar.png";',
      `const sampleAvatar = ${JSON.stringify(avatarDataUrl)};`,
    );
    if (patchedAppJs === appJs) {
      throw new Error("无法定位默认头像常量，插件资源与网页版不同步");
    }

    const init = {
      storage: this.data.storage || {},
      vaultName: this.app.vault.getName(),
    };

    let html = indexHtml;
    html = html.replace(/<link\s+rel="stylesheet"\s+href="src\/styles\.css[^>]*>/i, `<style>\n${css}\n</style>`);
    html = html.replace('<script src="vendor/jszip.min.js"></script>', `<script>\n${jszipJs}\n</script>`);
    html = html.replace(
      /<script\s+src="https:\/\/cdn\.jsdelivr\.net\/npm\/lucide[^>]*>\s*<\/script>/i,
      `<script>\n${lucideJs}\n</script>`,
    );
    html = html.replace('<script src="vendor/html2canvas.min.js"></script>', `<script>\n${html2canvasJs}\n</script>`);
    html = html.replace(
      /<script\s+src="src\/app\.js[^>]*>\s*<\/script>/i,
      [
        `<script>window.__PLUGIN_INIT__ = ${JSON.stringify(init)};</script>`,
        `<script>\n${bridgeJs}\n</script>`,
        `<script>\n${patchedAppJs}\n</script>`,
        `<script>\n${overridesJs}\n</script>`,
      ].join("\n"),
    );

    this._editorHtml = html;
    return html;
  }

  async listVaultDirectory(path) {
    const adapter = this.app.vault.adapter;
    let listed;
    try {
      listed = await adapter.list(path || "");
    } catch {
      try {
        listed = await adapter.list(".");
      } catch {
        return [];
      }
    }

    const result = [];
    const pathParts = (value) => String(value || "").split("/").filter(Boolean);
    const isHidden = (parts) => parts.some((part) => part.startsWith("."));

    for (const filePath of listed.files || []) {
      const parts = pathParts(filePath);
      if (isHidden(parts)) continue;
      if (!parts[parts.length - 1].toLowerCase().endsWith(".md")) continue;
      result.push({ name: parts[parts.length - 1], kind: "file", path: filePath });
    }
    for (const dirPath of listed.folders || []) {
      const parts = pathParts(dirPath);
      if (isHidden(parts)) continue;
      result.push({ name: parts[parts.length - 1], kind: "directory", path: dirPath });
    }
    return result;
  }

  async findFileInVault(referencePath, referenceName) {
    const parts = String(referencePath || "").replace(/^\/+/, "").split("/").filter(Boolean);
    const name = String(referenceName || "").split("/").pop();
    if (!name) return null;
    const direct = parts.join("/");
    try {
      if (direct && (await this.app.vault.adapter.exists(direct))) return { path: direct };
    } catch {
      // Fall back to recursive filename search.
    }
    const found = await this.searchVaultForFileName("", name);
    return found ? { path: found } : null;
  }

  async searchVaultForFileName(dir, name) {
    const adapter = this.app.vault.adapter;
    let listed;
    try {
      listed = await adapter.list(dir || "");
    } catch {
      return null;
    }
    const target = String(name).toLowerCase();
    const fullPath = (value) => {
      let path = String(value || "").split("/").filter(Boolean).join("/");
      const dirParts = String(dir || "").split("/").filter(Boolean);
      if (!dirParts.length) return path;
      if (path === dir || path.startsWith(`${dir}/`)) return path;
      return `${dir}/${path}`;
    };
    for (const filePath of (listed.files || []).map(fullPath)) {
      const parts = String(filePath).split("/").filter(Boolean);
      if (parts.some((part) => part.startsWith("."))) continue;
      if (parts[parts.length - 1].toLowerCase() === target) return filePath;
    }
    for (const dirPath of (listed.folders || []).map(fullPath)) {
      const parts = String(dirPath).split("/").filter(Boolean);
      if (parts.some((part) => part.startsWith("."))) continue;
      const found = await this.searchVaultForFileName(dirPath, name);
      if (found) return found;
    }
    return null;
  }

  async saveBlobToVault(payload) {
    const filename = sanitizeFileName(payload?.filename);
    const data = payload?.data;
    if (!data) throw new Error("没有收到导出数据");

    const activeFile = this.app.workspace.getActiveFile();
    const folder = activeFile?.parent?.path || "";
    const targetPath = folder ? `${folder}/${filename}` : filename;
    const adapter = this.app.vault.adapter;

    if (folder && !(await adapter.exists(folder))) {
      await adapter.mkdir(folder);
    }
    await adapter.writeBinary(targetPath, data);
    new Notice(`已导出到 ${targetPath}`);
    return { path: targetPath };
  }
};

class WriteThenPublishView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.iframe = null;
    this.frameLoaded = false;
    this.pendingMessages = [];
    this.bridgeReady = false;
    this.bridgeReadyWaiters = [];
    this.responseCallbacks = new Map();
    this.nextRequestId = 1;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "写了就发";
  }

  getIcon() {
    return "layout-grid";
  }

  async onOpen() {
    const container = this.contentEl || this.containerEl.children[1];
    container.empty();
    container.addClass("wtp-editor-view");
    this.frameLoaded = false;
    this.bridgeReady = false;
    this.bridgeReadyWaiters = [];
    this.responseCallbacks.clear();

    const style = container.createEl("style");
    style.textContent = `
      .wtp-editor-view { height: 100%; overflow: hidden; }
      .wtp-editor-view .wtp-editor-frame {
        width: 100%;
        height: 100%;
        border: 0;
        display: block;
        background: #fff;
      }
    `;

    const iframe = container.createEl("iframe", { cls: "wtp-editor-frame" });
    iframe.addEventListener("load", () => {
      this.frameLoaded = true;
      const pending = this.pendingMessages;
      this.pendingMessages = [];
      for (const message of pending) this.postMessage(message);
    });
    this.iframe = iframe;
    this.registerDomEvent(window, "message", (event) => this.handleMessage(event));

    const html = await this.plugin.buildEditorHtml();
    if (!iframe.isConnected) return;
    iframe.srcdoc = html;
  }

  onClose() {
    this.iframe = null;
    this.frameLoaded = false;
    this.bridgeReady = false;
    this.bridgeReadyWaiters = [];
    this.responseCallbacks.clear();
    if (this.plugin.editorView === this) this.plugin.editorView = null;
    if (this.plugin._saveTimer) {
      clearTimeout(this.plugin._saveTimer);
      this.plugin._saveTimer = null;
      void this.plugin.saveData(this.plugin.data);
    }
    this.plugin._editorHtml = null;
  }

  postMessage(message, callback = null) {
    if (!this.iframe) return;
    if (callback) {
      const id = message.id || this.nextRequestId++;
      message.id = id;
      this.responseCallbacks.set(id, callback);
    }
    if (!this.frameLoaded) {
      this.pendingMessages.push(message);
      return;
    }
    this.iframe.contentWindow.postMessage(message, "*");
  }

  markBridgeReady() {
    this.bridgeReady = true;
    const waiters = this.bridgeReadyWaiters;
    this.bridgeReadyWaiters = [];
    for (const resolve of waiters) resolve();
  }

  awaitBridgeReady() {
    if (this.bridgeReady) return Promise.resolve();
    return new Promise((resolve) => this.bridgeReadyWaiters.push(resolve));
  }

  requestImport(markdown) {
    return new Promise((resolve, reject) => {
      this.postMessage(
        { type: "wtp-bridge-in", method: "import-markdown", payload: { markdown } },
        (result) => {
          if (result.ok) resolve(result.result);
          else reject(new Error(result.error || "导入失败"));
        },
      );
    });
  }

  handleMessage(event) {
    if (!this.iframe || event.source !== this.iframe.contentWindow) return;
    const message = event.data;
    if (!message || typeof message !== "object") return;

    if (message.type === "wtp-bridge-response" && message.id) {
      const callback = this.responseCallbacks.get(message.id);
      if (callback) {
        this.responseCallbacks.delete(message.id);
        callback({ ok: Boolean(message.ok), result: message.result, error: message.error });
      }
      return;
    }

    if (message.type !== "wtp-bridge" || !message.id) return;

    void this.dispatch(message)
      .then((result) => {
        event.source.postMessage(
          { type: "wtp-bridge-response", id: message.id, ok: true, result },
          "*",
        );
      })
      .catch((error) => {
        event.source.postMessage(
          {
            type: "wtp-bridge-response",
            id: message.id,
            ok: false,
            error: String(error?.message || error),
          },
          "*",
        );
      });
  }

  async dispatch(message) {
    const payload = message.payload || {};
    switch (message.method) {
      case "bridge-ready":
        this.markBridgeReady();
        return { ok: true };
      case "storage-set-all":
        this.plugin.data.storage = payload || {};
        this.plugin.scheduleSave();
        return { ok: true };
      case "media-put":
        this.plugin.data.media[payload.key] = payload.value;
        this.plugin.scheduleSave();
        return { ok: true };
      case "media-remove":
        delete this.plugin.data.media[payload.key];
        this.plugin.scheduleSave();
        return { ok: true };
      case "media-load":
        return this.plugin.data.media || {};
      case "vault-list":
        return this.plugin.listVaultDirectory(payload.path || "");
      case "vault-find-file":
        return this.plugin.findFileInVault(payload?.path, payload?.name);
      case "vault-read-text":
        return this.app.vault.adapter.read(payload.path);
      case "vault-read-binary":
        return this.app.vault.adapter.readBinary(payload.path);
      case "import-markdown":
        return { ok: true, message: "请使用「将当前笔记导入写了就发」命令" };
      case "save-blob":
        return this.plugin.saveBlobToVault(payload);
      default:
        throw new Error(`未知的插件桥接方法: ${message.method}`);
    }
  }
}
