(function () {
  "use strict";

  const init = window.__PLUGIN_INIT__ || {};
  const bridgeRequests = new Map();
  let nextRequestId = 1;
  let storageSyncTimer = null;

  const appStorageKeys = [
    "graphicTextLayoutState.sjwesther.v1",
    "graphicTextLayoutProjects.sjwesther.v1",
    "writeThenPublishPanelLayout.sjwesther.v1",
  ];

  const storage = new Map();
  const seed = (init.storage && typeof init.storage === "object") ? init.storage : {};
  for (const key of Object.keys(seed)) {
    storage.set(key, String(seed[key]));
  }

  function postBridgeRequest(method, payload) {
    return new Promise((resolve, reject) => {
      const id = nextRequestId++;
      bridgeRequests.set(id, { resolve, reject });
      window.parent.postMessage({ type: "wtp-bridge", id, method, payload }, "*");
      window.setTimeout(() => {
        if (!bridgeRequests.has(id)) return;
        bridgeRequests.delete(id);
        reject(new Error(`桥接请求超时：${method}`));
      }, 30000);
    });
  }

  function syncStorageSoon() {
    window.clearTimeout(storageSyncTimer);
    storageSyncTimer = window.setTimeout(() => {
      storageSyncTimer = null;
      const payload = {};
      for (const [key, value] of storage) {
        if (appStorageKeys.includes(key)) payload[key] = value;
      }
      void postBridgeRequest("storage-set-all", payload).catch((error) => {
        console.warn("写入插件存储失败", error);
      });
    }, 350);
  }

  const appLocalStorage = {
    getItem(key) {
      return storage.has(String(key)) ? storage.get(String(key)) : null;
    },
    setItem(key, value) {
      storage.set(String(key), String(value));
      syncStorageSoon();
    },
    removeItem(key) {
      storage.delete(String(key));
      syncStorageSoon();
    },
    clear() {
      for (const key of appStorageKeys) storage.delete(key);
      syncStorageSoon();
    },
    key(index) {
      return Array.from(storage.keys())[index] ?? null;
    },
    get length() {
      return storage.size;
    },
  };

  Object.defineProperty(window, "localStorage", {
    configurable: true,
    get() {
      return appLocalStorage;
    },
  });

  Object.defineProperty(window, "indexedDB", {
    configurable: true,
    get() {
      return undefined;
    },
  });

  window.wtpBridge = {
    postBridgeRequest,
    vaultName: init.vaultName || "当前仓库",
  };

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || typeof message !== "object") return;

    if (message.type === "wtp-bridge-response" && bridgeRequests.has(message.id)) {
      const request = bridgeRequests.get(message.id);
      bridgeRequests.delete(message.id);
      if (message.ok) {
        request.resolve(message.result);
      } else {
        request.reject(new Error(message.error || "桥接请求失败"));
      }
      return;
    }

    if (message.type === "wtp-bridge-in" && message.method === "import-markdown") {
      const id = message.id;
      const payload = message.payload || {};
      const respond = (ok, result) => {
        window.parent.postMessage(
          { type: "wtp-bridge-response", id, ok, result, error: ok ? undefined : String(result) },
          "*",
        );
      };
      Promise.resolve()
        .then(() => {
          const importer = window.importMarkdownFromConnectedVault;
          if (typeof importer !== "function") {
            respond(false, "编辑器尚未初始化完成");
            return;
          }
          return importer(String(payload.markdown || ""));
        })
        .then((result) => respond(true, result || { imported: 0, unresolved: [] }))
        .catch((error) => respond(false, String(error?.message || error)));
    }
  });
})();
