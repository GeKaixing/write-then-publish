(function () {
  "use strict";

  const bridge = window.wtpBridge;
  const request = (method, payload) => bridge.postBridgeRequest(method, payload);

  function imageMimeTypeForPath(path) {
    const ext = String(path || "").toLowerCase().split(".").pop();
    const mimeByExt = {
      avif: "image/avif",
      bmp: "image/bmp",
      gif: "image/gif",
      heic: "image/heic",
      jpeg: "image/jpeg",
      jpg: "image/jpeg",
      png: "image/png",
      svg: "image/svg+xml",
      webp: "image/webp",
    };
    return mimeByExt[ext] || "application/octet-stream";
  }

  function vaultPathFromParts(parts) {
    return Array.isArray(parts) ? parts.filter(Boolean).join("/") : String(parts || "");
  }

  // 媒体库通过插件数据保存，替代网页版 IndexedDB。
  window.openMediaDatabase = () => Promise.resolve({});
  window.writeMedia = async (key, value) => {
    await request("media-put", { key, value });
  };
  window.readMedia = async (key) => {
    if (!key) return null;
    const media = await request("media-load");
    return Object.prototype.hasOwnProperty.call(media, key) ? media[key] : null;
  };

  // Obsidian 仓库直接使用插件运行所在的仓库，不再需要目录授权。
  window.loadObsidianVaultConnection = async () => {
    obsidianVault.handle = { name: window.wtpBridge.vaultName, granted: true };
    setObsidianVaultStatus(`已连接：${obsidianVault.handle.name}`, true);
    refreshObsidianBrowser();
    updateObsidianBrowserVisibility();
    switchSidebarToObsidian();
  };
  window.connectObsidianVault = () => loadObsidianVaultConnection();
  window.ensureObsidianVaultPermission = async () => true;
  window.findFileInObsidianVault = async (reference, exact = false) => {
    const parts = typeof window.vaultReferenceParts === "function" ? window.vaultReferenceParts(reference) : [];
    if (!parts.length) return null;
    const found = await request("vault-find-file", {
      path: parts.join("/"),
      name: parts[parts.length - 1],
      exact,
    });
    return found?.path || null;
  };
  window.findObsidianFileByName = async () => null;
  window.openObsidianVaultDatabase = async () => ({});
  window.readStoredObsidianVault = async () => null;
  window.saveObsidianVault = async () => undefined;

  // 目录树：用路径字符串代替 FileSystemDirectoryHandle。
  window.readVaultDirectory = async (pathOrParts) => {
    const path = typeof pathOrParts === "string" ? pathOrParts : vaultPathFromParts(pathOrParts);
    const entries = await request("vault-list", { path });
    return entries.map((entry) => ({
      name: entry.name,
      kind: entry.kind,
      path: entry.path,
      _pathParts: String(entry.path || "").split("/").filter(Boolean),
    }));
  };
  window.resolveVaultHandle = (rootHandle, pathParts) => vaultPathFromParts(pathParts);
  window.expandVaultDirectory = async (itemEl, dirEntry) => {
    const childrenContainer = vaultChildrenContainer(itemEl);
    if (!childrenContainer || !childrenContainer.hasAttribute("hidden")) return;
    if (!dirEntry.children) {
      childrenContainer.textContent = "";
      const loading = document.createElement("div");
      loading.className = "obsidian-tree-loading";
      loading.textContent = "加载中…";
      childrenContainer.append(loading);
      try {
        dirEntry.children = await readVaultDirectory(dirEntry._pathParts);
      } catch {
        childrenContainer.innerHTML = '<p class="obsidian-error">读取失败</p>';
        return;
      }
      renderVaultTree(dirEntry.children, childrenContainer, 0, dirEntry._pathParts);
    }
    childrenContainer.hidden = false;
    const toggle = itemEl.querySelector(".tree-toggle");
    if (toggle) toggle.classList.add("expanded");
  };
  window.loadObsidianFile = async (pathParts) => {
    const path = vaultPathFromParts(pathParts);
    if (!path) return;
    els.status.textContent = "正在从 Obsidian 仓库读取文件…";
    try {
      const markdown = await request("vault-read-text", { path });
      await importMarkdownFromConnectedVault(markdown, path);
    } catch (error) {
      console.error(error);
      els.status.textContent = "读取文件失败：" + error.message;
    }
  };

  // 从仓库读取图片并导入编辑器，保持网页版的数据流与重名提示。
  window.importMarkdownFromConnectedVault = async (markdown, sourcePath = "") => {
    if (!obsidianVault.handle || obsidianVault.importing) {
      return { imported: 0, unresolved: [], skipped: true };
    }
    obsidianVault.importing = true;
    invalidatePendingRender();
    els.status.textContent = "正在从 Obsidian 仓库读取图片…";
    try {
      await restoreImagesFromMedia(markdown, state.images);
      const lookup = buildImageReferenceLookup(state.images);
      const files = [];
      const sourcePaths = new Map();
      const missing = [];
      for (const reference of extractMarkdownImageReferences(markdown)) {
        if (resolveObsidianImageReference(reference, lookup, sourcePath).id) continue;
        const rawReference = String(reference || "").trim();
        const explicitPath =
          rawReference.startsWith("/") || rawReference.startsWith("./") || rawReference.startsWith("../");
        let fileData = null;
        let resolvedPath =
          typeof window.vaultReferenceFromSource === "function"
            ? window.vaultReferenceFromSource(reference, sourcePath) || reference
            : reference;
        try {
          let foundPath = await window.findFileInObsidianVault(resolvedPath, explicitPath);
          if (!foundPath && !explicitPath && resolvedPath !== reference) {
            foundPath = await window.findFileInObsidianVault(reference);
          }
          if (foundPath) {
            resolvedPath = foundPath;
            fileData = await request("vault-read-binary", { path: foundPath });
          }
        } catch {
          fileData = null;
        }
        if (!fileData) {
          missing.push(reference);
          continue;
        }
        const fileName = String(resolvedPath).split("/").filter(Boolean).pop() || "image";
        const file = new File([fileData], fileName, { type: imageMimeTypeForPath(resolvedPath) });
        files.push(file);
        sourcePaths.set(file, resolvedPath);
      }
      if (missing.length) {
        const message = `没有找到 ${missing.length} 张图片：${missing.slice(0, 3).join("、")}。请确认引用路径在仓库内存在。`;
        els.obsidianImportMenu.open = true;
        els.obsidianImportStatus.textContent = message;
        els.status.textContent = message;
        return { imported: 0, unresolved: [], missing: missing.length };
      }
      const imported = await addImageFiles(files, sourcePaths);
      const converted = convertObsidianImageReferences(markdown, state.images, sourcePath);
      if (converted.unresolved.length) {
        els.status.textContent = "发现重名图片，暂时无法自动判断该用哪一张。";
        return { imported: imported.ids.length, unresolved: converted.unresolved };
      }
      state.importSource = "obsidian";
      await switchToImportedProject(converted.content);
      els.status.textContent = `已从仓库自动读取 ${imported.ids.length} 张图片并完成导入`;
      closeObsidianImportMenu();
      return { imported: imported.ids.length, unresolved: [] };
    } catch (error) {
      console.error(error);
      els.status.textContent = "读取 Obsidian 仓库失败，请重新打开插件后再试。";
      return { imported: 0, unresolved: [], error: String(error?.message || error) };
    } finally {
      obsidianVault.importing = false;
    }
  };

  // 导出图片/压缩包到当前活动笔记所在目录。
  window.saveBlob = async (blob, filename) => {
    const data = await blob.arrayBuffer();
    const result = await request("save-blob", { filename, data });
    if (result?.path) {
      els.status.textContent = `已导出到 ${result.path}`;
    }
  };

  // 插件内媒体库就是 data.json 里的 media，直接从桥接数据恢复即可。
  window.restoreObsidianPluginMedia = async () => {
    els.status.textContent = "正在从插件数据恢复图片…";
    try {
      const media = await request("media-load");
      const entries = Object.entries(media || {}).filter(
        ([key, value]) => key.startsWith("image:") && String(value || "").startsWith("data:"),
      );
      let restored = 0;
      for (const [key, value] of entries) {
        const id = key.slice("image:".length);
        const existing = state.images[id];
        state.images[id] = {
          ...(existing || {}),
          src: value,
          storageKey: key,
          name: existing?.name || id,
          sourcePath: existing?.sourcePath || id,
          crop: existing?.crop ?? null,
          layout: existing?.layout ?? defaultNewImageLayout(),
        };
        restored += 1;
      }
      updateImageList();
      requestRender();
      els.status.textContent = `已从插件数据恢复 ${restored} 张图片`;
    } catch (error) {
      console.error(error);
      els.status.textContent = "恢复插件图片失败：" + String(error?.message || error);
    }
  };

  // 覆盖初始化完成后再次连接仓库，替换网页版启动时失败的读取。
  void loadObsidianVaultConnection();
  void bridge.postBridgeRequest("bridge-ready", {}).then(async () => {
    // 桥接就绪后只恢复当前项目媒体并重渲染；不再把整个媒体库塞进
    // state.images，避免不同文章的 cover.jpg 等重名文件互相串图。
    if (typeof window.hydrateActiveProjectMedia === "function") {
      await window.hydrateActiveProjectMedia();
    }
    if (typeof window.render === "function") {
      await window.render();
    }
    if (window.lucide) window.lucide.createIcons();
  });
})();
