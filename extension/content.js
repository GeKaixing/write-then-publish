"use strict";

const TASK_STORAGE_KEY = "wtpPendingPublishTask";
const PAGE_TASK_KEY = "wtp_pending_publish";
const TASK_TTL_MS = 15 * 60 * 1000;
const ROUTE_POLL_MS = 500;

const EXTENSION_HOSTS = new Set(["localhost", "127.0.0.1", "hiesther.com", "www.hiesther.com"]);
const EXTENSION_VERSION = "1.1.0"; // @wtp-version

if (EXTENSION_HOSTS.has(location.hostname)) {
  document.documentElement.dataset.wtpExtensionReady = "1";
  document.documentElement.dataset.wtpExtensionVersion = EXTENSION_VERSION;
  document.dispatchEvent(new CustomEvent("wtp-extension-ready", { bubbles: true }));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isExtensionContextValid() {
  try {
    return Boolean(chrome.runtime?.id);
  } catch (error) {
    return false;
  }
}

function markExtensionDisconnected() {
  try {
    document.documentElement.dataset.wtpExtensionReady = "";
    document.dispatchEvent(new CustomEvent("wtp-extension-ready", { bubbles: true }));
  } catch (error) {
    // 页面可能正在关闭，忽略
  }
}

function readPageTask() {
  try {
    const raw = window.localStorage.getItem(PAGE_TASK_KEY);
    if (!raw) return null;
    const task = JSON.parse(raw);
    if (!task || !["xhs", "wechat", "douyin", "xiaoheihe"].includes(task.platform)) return null;
    if (!Array.isArray(task.images) || !task.images.length) return null;
    if (Date.now() - (Number(task.createdAt) || 0) > TASK_TTL_MS) {
      window.localStorage.removeItem(PAGE_TASK_KEY);
      return null;
    }
    return task;
  } catch (error) {
    console.warn("读取发布任务失败", error);
    return null;
  }
}

function notifyApp(type, detail) {
  const payload = detail || {};
  try {
    window.dispatchEvent(new CustomEvent(type, { detail: payload }));
  } catch (error) {
    // 页面可能正在关闭
    return;
  }
  if (!payload.taskId || !isExtensionContextValid()) return;
  try {
    chrome.runtime.sendMessage({ type: "WTP_PUBLISH_COMPLETE", ...payload }, () => {
      try {
        if (chrome.runtime.lastError) {
          // 平台页或后台刷新后无法回传时，源页面仍可通过任务状态自行判断
        }
      } catch (error) {
        // 扩展上下文可能在回调期间失效
      }
    });
  } catch (error) {
    console.warn("扩展上下文已失效，无法回传结果", error);
    markExtensionDisconnected();
  }
}

function waitForElement(getter, { timeout = 30000, interval = 300, message = "未找到目标元素" } = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const element = getter();
      if (element) {
        clearInterval(timer);
        resolve(element);
        return;
      }
      if (Date.now() - startedAt >= timeout) {
        clearInterval(timer);
        reject(new Error(message));
      }
    }, interval);
  });
}

function waitForElementSoft(getter, options = {}) {
  return waitForElement(getter, options).catch(() => null);
}

function setFileInput(input, files) {
  const transfer = new DataTransfer();
  files.forEach((file) => transfer.items.add(file));
  input.files = transfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
  input.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
}

function dataUrlToBlob(dataUrl) {
  const commaIndex = dataUrl.indexOf(",");
  const meta = commaIndex >= 0 ? dataUrl.slice(0, commaIndex) : "";
  const mime = /^data:([^;,]+)/.exec(meta)?.[1] || "image/png";
  const base64 = commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : "";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mime });
}

async function dataUrlsToFiles(task) {
  const files = [];
  for (const [index, dataUrl] of task.images.entries()) {
    try {
      let blob;
      try {
        const response = await fetch(dataUrl);
        blob = await response.blob();
      } catch (error) {
        blob = dataUrlToBlob(dataUrl);
      }
      if (blob && blob.size > 0) {
        files.push(new File([blob], `publish-image-${index + 1}.png`, { type: blob.type || "image/png" }));
      }
    } catch (error) {
      console.warn(`第 ${index + 1} 张图片读取失败`, error);
    }
  }
  return files;
}

function setNativeInputValue(input, value) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
  if (descriptor?.set) descriptor.set.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
  input.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
  input.focus();
  input.blur();
}

function dispatchEditorInputEvents(element, value) {
  const inputEvent = typeof InputEvent === "function"
    ? new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: value })
    : new Event("input", { bubbles: true, cancelable: true });
  element.dispatchEvent(inputEvent);
  ["keydown", "keypress", "keyup", "change"].forEach((type) => {
    element.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
  });
}

function setContentEditableText(element, value) {
  element.focus();
  element.innerText = value;
  dispatchEditorInputEvents(element, value);
}

function setContentEditableHtml(element, html) {
  element.focus();
  element.innerHTML = html;
  dispatchEditorInputEvents(element, html);
  if (element.ownerDocument?.body) {
    element.ownerDocument.body.dispatchEvent(new Event("keyup", { bubbles: true, cancelable: true }));
  }
}

function fillTextElement(element, value) {
  if (!element || value == null || value === "") return;
  if (element.isContentEditable) setContentEditableText(element, value);
  else setNativeInputValue(element, value);
}

function truncateText(text, maxLength) {
  const value = String(text || "").trim();
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function textToParagraphHtml(text) {
  return String(text || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join("");
}

function isXhsPublishPage() {
  return location.hostname.endsWith("xiaohongshu.com") && location.pathname === "/publish/publish";
}

function isWechatHomePage() {
  return location.hostname === "mp.weixin.qq.com" && location.pathname === "/cgi-bin/home";
}

function isWechatEditorPage() {
  return (
    location.hostname === "mp.weixin.qq.com" &&
    location.pathname === "/cgi-bin/appmsg" &&
    new URLSearchParams(location.search).get("action") === "edit"
  );
}

function isDouyinUploadPage() {
  return location.hostname === "creator.douyin.com" && location.pathname === "/creator-micro/content/upload";
}

function isDouyinHomePage() {
  return location.hostname === "creator.douyin.com" && location.pathname === "/creator-micro/home";
}

function isDouyinPostImagePage() {
  return location.hostname === "creator.douyin.com" && location.pathname === "/creator-micro/content/post/image";
}

function isXiaoheiheEditorPage() {
  return (
    (location.hostname === "www.xiaoheihe.cn" || location.hostname === "xiaoheihe.cn") &&
    location.pathname.startsWith("/creator/editor/") &&
    location.pathname.includes("/image_text")
  );
}

function douyinTab() {
  const container = document.querySelector('#root [class*="tab-container-"]');
  if (!container) return null;
  return Array.from(container.querySelectorAll('[class*="tab-item-"]')).find(
    (element) => element.textContent.trim() === "发布图文",
  );
}

function douyinTabActive(element) {
  return Array.from(element.classList).some((name) => name.startsWith("active-"));
}

function xhsTitleElement() {
  return document.querySelector(".title-container input.d-text")
    || document.querySelector(".title-container textarea")
    || document.querySelector('.title-container [contenteditable="true"]')
    || document.querySelector('input[placeholder*="标题"]')
    || document.querySelector('textarea[placeholder*="标题"]');
}

function xhsDescriptionElement() {
  return document.querySelector(".desc-container textarea")
    || document.querySelector('.desc-container [contenteditable="true"]')
    || document.querySelector('textarea[placeholder*="描述"]')
    || document.querySelector('textarea[placeholder*="正文"]')
    || document.querySelector('textarea[placeholder*="这一刻"]');
}

function douyinTitleElement() {
  return document.querySelector('textarea[placeholder*="标题"]')
    || document.querySelector('input[type="text"][placeholder*="标题"]')
    || document.querySelector('input[placeholder*="标题"]');
}

function douyinDescriptionElement(titleElement) {
  const direct = document.querySelector('textarea[placeholder*="描述"]')
    || document.querySelector('textarea[placeholder*="分享"]')
    || document.querySelector('textarea[placeholder*="正文"]');
  if (direct) return direct;
  return Array.from(document.querySelectorAll("textarea")).find(
    (element) => element !== titleElement && !String(element.getAttribute("placeholder") || "").includes("标题"),
  );
}

function wechatTitleElement() {
  return document.querySelector('.title-editor-overlay [name="title"] [contenteditable="true"]')
    || document.querySelector("#title")
    || document.querySelector('input[placeholder*="标题"]');
}

function wechatUploadInputSelectors() {
  return [
    ".js_upload_btn_container.weui-desktop-upload-input__wrp.webuploader-container input",
    ".js_upload_btn_container.weui-desktop-upload-input__wrp input",
    ".js_upload_btn_container.webuploader-container input",
    '.js_upload_btn_container input[type="file"]',
    '.weui-desktop-upload-input__wrp input[type="file"]',
    'input[type="file"][multiple][accept*="image"]',
    'input[type="file"][accept*="image"]',
  ];
}

function findWechatUploadInput() {
  for (const selector of wechatUploadInputSelectors()) {
    const element = document.querySelector(selector);
    if (element) return { element, selector };
  }
  return null;
}

function wechatUploadedCount() {
  return document.querySelectorAll(
    '.weui-desktop-upload__thumb, .pic_item, [class*="upload_thumb"], [class*="pic_item"], [class*="upload__thumb"]',
  ).length;
}

function wechatUploadFeedback() {
  const selectors = [
    "#js_toast",
    ".js_toast",
    '[class*="weui-desktop-toast"]',
    '[class*="upload_error"]',
    ".js_tips",
    '[class*="mod_tips"]',
  ];
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    const text = element?.textContent?.trim();
    if (text) return text.slice(0, 120);
  }
  return "";
}

function describeWechatUploadCandidates() {
  const fileInputs = Array.from(document.querySelectorAll('input[type="file"]')).map((input) => ({
    accept: input.accept,
    multiple: input.multiple,
    className: String(input.className || "").slice(0, 80),
    parentClass: String(input.parentElement?.className || "").slice(0, 80),
  }));
  return JSON.stringify({ fileInputs, iframeCount: document.querySelectorAll("iframe").length });
}

function wechatBodyTarget() {
  const frame = document.querySelector("iframe#js_editor")
    || document.querySelector("iframe#ueditor_0")
    || document.querySelector('.editor_iframe iframe');
  if (frame?.contentDocument?.body) return { element: frame.contentDocument.body, frame };
  return {
    element: document.querySelector('.js_editor_content[contenteditable="true"]')
      || document.querySelector('.js_editor_content')
      || document.querySelector('.editor_iframe [contenteditable="true"]'),
    frame: null,
  };
}

async function triggerWechatUpload(files) {
  const firstFound = await waitForElement(findWechatUploadInput, {
    timeout: 30000,
    message: "未找到公众号图片上传输入框",
  });
  const attempts = 3;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const found = findWechatUploadInput() || firstFound;
    if (!found?.element) break;
    setFileInput(found.element, files);
    for (let check = 0; check < 5; check += 1) {
      await delay(1500);
      if (wechatUploadedCount() >= files.length) return;
      const feedback = wechatUploadFeedback();
      if (/上传失败|失败|错误/.test(feedback)) {
        throw new Error(`公众号图片上传失败：${feedback}`);
      }
    }
  }
  const feedback = wechatUploadFeedback();
  const uploaded = wechatUploadedCount();
  throw new Error(feedback
    ? `公众号图片上传失败：${feedback}`
    : `公众号图片上传失败：已触发上传但未检测到成功（${uploaded}/${files.length}）`);
}

async function fillWechat(task) {
  const files = await dataUrlsToFiles(task);
  if (!files.length) throw new Error("没有可上传的图片");
  try {
    await triggerWechatUpload(files);
  } catch (error) {
    if (error.message === "未找到公众号图片上传输入框") {
      throw new Error(`未找到公众号图片上传输入框（${describeWechatUploadCandidates()}）`);
    }
    throw error;
  }
  const titleInput = await waitForElementSoft(wechatTitleElement, { timeout: 20000 });
  if (titleInput) fillTextElement(titleInput, task.title);
  if (task.description) {
    const body = await waitForElementSoft(() => wechatBodyTarget().element, { timeout: 20000 });
    if (body) {
      const target = wechatBodyTarget();
      if (target.frame?.contentWindow) target.frame.contentWindow.focus();
      setContentEditableHtml(body, textToParagraphHtml(task.description));
    }
    const digest = await waitForElementSoft(
      () => document.querySelector('textarea[name="digest"]')
        || document.querySelector('input[name="digest"]')
        || document.querySelector('.js_digest'),
      { timeout: 5000 },
    );
    if (digest) fillTextElement(digest, truncateText(task.description, 120));
  }
  await delay(800);
}

async function fillDouyin(task) {
  const tab = await waitForElement(douyinTab, { message: "未找到抖音发布图文 tab" });
  if (!douyinTabActive(tab)) {
    tab.click();
    await delay(800);
  }
  const uploadInput = await waitForElement(
    () => document.querySelector('.semi-tabs-pane-motion-overlay input[type="file"][accept*="image"]'),
    { message: "未找到抖音图文上传输入框" },
  );
  const files = await dataUrlsToFiles(task);
  if (!files.length) throw new Error("没有可上传的图片");
  setFileInput(uploadInput, files);
  const titleInput = await waitForElementSoft(douyinTitleElement, { timeout: 20000 });
  if (titleInput) fillTextElement(titleInput, task.title);
  const descriptionInput = await waitForElementSoft(() => douyinDescriptionElement(titleInput), { timeout: 20000 });
  if (descriptionInput) fillTextElement(descriptionInput, truncateText(task.description, 1000));
  await delay(800);
}

async function fillXhs(task) {
  const uploadInput = await waitForElement(() => document.querySelector(".upload-input"), {
    message: "未找到小红书图片上传输入框",
  });
  const files = await dataUrlsToFiles(task);
  if (!files.length) throw new Error("没有可上传的图片");
  setFileInput(uploadInput, files);
  const titleInput = await waitForElementSoft(xhsTitleElement, { timeout: 20000 });
  if (titleInput) fillTextElement(titleInput, task.title);
  const descriptionInput = await waitForElementSoft(xhsDescriptionElement, { timeout: 20000 });
  if (descriptionInput) fillTextElement(descriptionInput, truncateText(task.description, 1000));
  await delay(800);
}

function xiaoheiheImageWrapper() {
  return document.querySelector(".editor-image-text__image-seletor.editor__image-wrapper")
    || document.querySelector(".editor-image-text__image-seletor .editor__image-wrapper")
    || document.querySelector(".editor__image-wrapper");
}

function xiaoheiheUploadedCount() {
  return document.querySelectorAll(".editor-image-text__image-seletor .editor-image-wrapper__box-image img").length;
}

function xiaoheiheUploadFeedback() {
  if (document.querySelector(".website-login-mask, .website-login")) {
    return "请先登录小黑盒后再发布";
  }
  const selectors = [".hb-toast", '[class*="toast"]', '[class*="message"]', '[class*="error"]'];
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    const text = element?.textContent?.trim();
    if (text && /失败|错误|最多|超出|请先登录|请登录/.test(text)) return text.slice(0, 120);
  }
  return "";
}

async function fillXiaoheihe(task) {
  if (document.querySelector(".website-login-mask, .website-login")) {
    throw new Error("小黑盒需要先登录后再发布");
  }
  const imageWrapper = await waitForElement(xiaoheiheImageWrapper, {
    timeout: 30000,
    message: "未找到小黑盒图片上传区域",
  });
  if (document.querySelector(".website-login-mask, .website-login")) {
    throw new Error("小黑盒需要先登录后再发布");
  }
  const titleInput = await waitForElementSoft(
    () => document.querySelector(".editor-title__container .ProseMirror"),
    { timeout: 20000 },
  );
  if (titleInput) fillTextElement(titleInput, truncateText(task.title, 30));
  const bodyInput = await waitForElementSoft(
    () => document.querySelector(".image-text__edit-content--inner .ProseMirror"),
    { timeout: 20000 },
  );
  if (bodyInput && task.description) {
    setContentEditableHtml(bodyInput, textToParagraphHtml(task.description));
  }
  const files = await dataUrlsToFiles(task);
  if (!files.length) throw new Error("没有可上传的图片");
  if (files.length > 9) throw new Error("小黑盒图文最多上传 9 张图片，请拆分后再发布");
  const transfer = new DataTransfer();
  files.forEach((file) => transfer.items.add(file));
  let dropEvent;
  try {
    dropEvent = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer });
  } catch (error) {
    dropEvent = new Event("drop", { bubbles: true, cancelable: true });
    dropEvent.dataTransfer = transfer;
  }
  const startedCount = xiaoheiheUploadedCount();
  imageWrapper.dispatchEvent(dropEvent);
  const targetCount = startedCount + files.length;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    await delay(1000);
    if (xiaoheiheUploadedCount() >= targetCount) {
      await delay(500);
      return;
    }
    const feedback = xiaoheiheUploadFeedback();
    if (feedback) throw new Error(`小黑盒图片上传失败：${feedback}`);
  }
  const feedback = xiaoheiheUploadFeedback();
  throw new Error(feedback
    ? `小黑盒图片上传失败：${feedback}`
    : `小黑盒图片上传失败：已触发上传但未检测到成功（${xiaoheiheUploadedCount()}/${files.length}）`);
}

async function markRunning(task) {
  if (!isExtensionContextValid()) {
    markExtensionDisconnected();
    return null;
  }
  try {
    const stored = await chrome.storage.local.get(TASK_STORAGE_KEY);
    const current = stored[TASK_STORAGE_KEY];
    if (!current || current.id !== task.id) return null;
    if (current.status === "running" && Date.now() - (Number(current.updatedAt) || 0) < 60000) return null;
    const running = { ...current, status: "running", updatedAt: Date.now() };
    await chrome.storage.local.set({ [TASK_STORAGE_KEY]: running });
    return running;
  } catch (error) {
    console.warn("读取发布任务状态失败", error);
    markExtensionDisconnected();
    return null;
  }
}

async function clearTask(task) {
  if (isExtensionContextValid()) {
    try {
      await chrome.storage.local.remove(TASK_STORAGE_KEY);
    } catch (error) {
      console.warn("清理发布任务失败", error);
    }
  } else {
    markExtensionDisconnected();
  }
  try {
    window.localStorage.removeItem(PAGE_TASK_KEY);
  } catch (error) {
    // 平台页面没有 localhost 数据时忽略
  }
  notifyApp("wtp-publish-complete", { platform: task.platform, taskId: task.id, ok: true });
}

async function runTask(task) {
  try {
    const running = await markRunning(task);
    if (!running) return;
    if (task.platform === "xhs") await fillXhs(running);
    else if (task.platform === "wechat") await fillWechat(running);
    else if (task.platform === "douyin") await fillDouyin(running);
    else if (task.platform === "xiaoheihe") await fillXiaoheihe(running);
    await clearTask(running);
  } catch (error) {
    console.error(`${task.platform} 自动填写失败`, error);
    notifyApp("wtp-publish-complete", {
      platform: task.platform,
      taskId: task.id,
      ok: false,
      error: error.message,
    });
  }
}

try {
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "WTP_PUBLISH_COMPLETE") {
      window.dispatchEvent(new CustomEvent("wtp-publish-complete", { detail: message }));
    }
  });
} catch (error) {
  console.warn("注册消息监听失败", error);
  markExtensionDisconnected();
}

let pendingTaskTimer = null;

async function handlePendingTask() {
  if (!isExtensionContextValid()) {
    markExtensionDisconnected();
    if (pendingTaskTimer) clearInterval(pendingTaskTimer);
    return;
  }
  try {
    const stored = await chrome.storage.local.get(TASK_STORAGE_KEY);
    const task = stored[TASK_STORAGE_KEY];
    if (!task) return;
    if (Date.now() - (Number(task.createdAt) || 0) > TASK_TTL_MS) {
      await chrome.storage.local.remove(TASK_STORAGE_KEY);
      return;
    }
    if (task.platform === "xhs" && isXhsPublishPage()) {
      await runTask(task);
      return;
    }
    if (task.platform === "wechat") {
      if (isWechatHomePage()) {
        const token = new URLSearchParams(location.search).get("token");
        if (token) {
          const editorUrl = `https://mp.weixin.qq.com/cgi-bin/appmsg?${new URLSearchParams({
            t: "media/appmsg_edit_v2",
            action: "edit",
            isNew: "1",
            type: "77",
            createType: "8",
            token,
            lang: "zh_CN",
            timestamp: String(Date.now()),
          })}`;
          location.href = editorUrl;
        }
        return;
      }
      if (isWechatEditorPage()) {
        await runTask(task);
      }
      return;
    }
    if (task.platform === "douyin") {
      if (isDouyinHomePage()) {
        location.href = "https://creator.douyin.com/creator-micro/content/upload?default-tab=3";
        return;
      }
      if (isDouyinUploadPage() || isDouyinPostImagePage()) {
        await runTask(task);
      }
      return;
    }
    if (task.platform === "xiaoheihe" && isXiaoheiheEditorPage()) {
      await runTask(task);
      return;
    }
  } catch (error) {
    console.warn("读取发布任务失败", error);
    markExtensionDisconnected();
    if (pendingTaskTimer) clearInterval(pendingTaskTimer);
  }
}

window.addEventListener("wtp-publish-request", async () => {
  try {
    const task = readPageTask();
    if (!task) return;
    window.localStorage.removeItem(PAGE_TASK_KEY);
    window.dispatchEvent(new CustomEvent("wtp-publish-request-accepted", {
      detail: { platform: task.platform, taskId: task.id },
    }));
    if (!isExtensionContextValid()) {
      markExtensionDisconnected();
      return;
    }
    await chrome.storage.local.set({ [TASK_STORAGE_KEY]: { ...task, status: "pending" } });
    if (!isExtensionContextValid()) return;
    chrome.runtime.sendMessage(
      { type: "WTP_OPEN_PLATFORM", platform: task.platform, taskId: task.id },
      (response) => {
        try {
          if (chrome.runtime.lastError) {
            console.warn("打开平台页失败", chrome.runtime.lastError.message);
            window.dispatchEvent(new CustomEvent("wtp-publish-complete", {
              detail: { platform: task.platform, taskId: task.id, ok: false, error: "扩展后台未响应，请刷新扩展后重试" },
            }));
          } else if (response && response.ok === false) {
            window.dispatchEvent(new CustomEvent("wtp-publish-complete", {
              detail: { platform: task.platform, taskId: task.id, ok: false, error: response.error || "打开平台页失败" },
            }));
          }
        } catch (error) {
          // 扩展上下文可能在回调期间失效
        }
      },
    );
  } catch (error) {
    console.warn("发布请求处理失败", error);
    markExtensionDisconnected();
  }
});

function checkPendingTask() {
  handlePendingTask().catch(() => {
    markExtensionDisconnected();
    if (pendingTaskTimer) clearInterval(pendingTaskTimer);
  });
}

checkPendingTask();
pendingTaskTimer = setInterval(checkPendingTask, 1500);
