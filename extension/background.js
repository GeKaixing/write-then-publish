"use strict";

const PLATFORM_URLS = {
  xhs: "https://creator.xiaohongshu.com/publish/publish?from=menu&target=image",
  wechat: "https://mp.weixin.qq.com/",
  douyin: "https://creator.douyin.com/creator-micro/content/upload?default-tab=3",
  xiaoheihe: "https://www.xiaoheihe.cn/creator/editor/draft/image_text",
};

const APP_TAB_PREFIX = "wtpAppTab:";

function appTabKey(taskId) {
  return `${APP_TAB_PREFIX}${taskId}`;
}

async function rememberAppTab(taskId, tabId) {
  try {
    await chrome.storage.local.set({ [appTabKey(taskId)]: tabId });
  } catch (error) {
    console.warn("保存源页面标签页失败", error.message);
  }
}

async function forgetAppTab(taskId) {
  try {
    await chrome.storage.local.remove(appTabKey(taskId));
  } catch (error) {
    console.warn("清理源页面标签页失败", error.message);
  }
}

async function loadAppTab(taskId) {
  try {
    const stored = await chrome.storage.local.get(appTabKey(taskId));
    return stored[appTabKey(taskId)] || null;
  } catch (error) {
    console.warn("读取源页面标签页失败", error.message);
    return null;
  }
}

const PLATFORM_URL_PATTERNS = [
  "https://creator.xiaohongshu.com/*",
  "https://mp.weixin.qq.com/*",
  "https://creator.douyin.com/*",
  "https://www.xiaoheihe.cn/*",
];

async function reloadStalePlatformTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: PLATFORM_URL_PATTERNS });
    for (const tab of tabs) {
      if (tab.id == null) continue;
      try {
        await chrome.tabs.reload(tab.id);
      } catch (error) {
        console.warn("刷新平台标签页失败", error.message);
      }
    }
  } catch (error) {
    console.warn("查找平台标签页失败", error.message);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  reloadStalePlatformTabs();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  try {
    if (!message) return;
    if (message.type === "WTP_OPEN_PLATFORM") {
      const url = PLATFORM_URLS[message.platform];
      if (!url) {
        sendResponse({ ok: false, error: "unknown platform" });
        return;
      }
      if (message.taskId && sender.tab?.id) {
        rememberAppTab(message.taskId, sender.tab.id);
      }
      try {
        chrome.tabs.create({ url, active: true }, (tab) => {
          try {
            sendResponse({ ok: true, tabId: tab?.id });
          } catch (error) {
            console.warn("回传打开平台结果失败", error.message);
          }
        });
      } catch (error) {
        console.warn("打开平台页失败", error.message);
        try {
          sendResponse({ ok: false, error: error.message });
        } catch (sendError) {
          // 扩展上下文可能在回调期间失效
        }
      }
      return true;
    }
    if (message.type === "WTP_PUBLISH_COMPLETE" && message.taskId) {
      loadAppTab(message.taskId).then((appTabId) => {
        if (!appTabId) return;
        try {
          chrome.tabs.sendMessage(appTabId, message, () => {
            try {
              if (chrome.runtime.lastError) {
                console.warn("无法回传发布结果到源页面", chrome.runtime.lastError.message);
              }
            } catch (error) {
              // 扩展上下文可能在回调期间失效
            }
          });
        } catch (error) {
          console.warn("回传发布结果失败", error.message);
        }
        forgetAppTab(message.taskId);
      });
    }
  } catch (error) {
    console.warn("处理扩展消息失败", error.message);
  }
});
