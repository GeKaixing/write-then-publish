import electron from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { app, BrowserWindow } = electron;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const port = process.env.AS_PORT || "57529";
const results = [];
const errors = [];

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${detail}` : ""}`);
}

async function snap(win, name) {
  const image = await win.webContents.capturePage();
  const file = path.join("/tmp/wtp-shots", name);
  const fs = await import("node:fs");
  fs.writeFileSync(file, image.toPNG());
  console.log("SHOT_OK", file);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1480,
    height: 960,
    show: false,
    backgroundColor: "#f8fafc",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  win.webContents.on("console-message", (event, level, message) => {
    if (level >= 3) errors.push(message);
  });
  win.webContents.on("did-fail-load", (event, code, description) => {
    errors.push(`load:${code} ${description}`);
  });

  const run = (js) => win.webContents.executeJavaScript(js, true);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  await win.loadURL(`http://127.0.0.1:${port}/`);
  await run('localStorage.removeItem("wtpAgentUi.v1"); location.reload();');
  await wait(1800);

  const before = await run(`(() => {
    const root = document.querySelector("#agentStudioRoot");
    return { hidden: root ? root.hidden : null, exists: Boolean(root) };
  })()`);
  check("studio root exists and hidden by default", before.exists && before.hidden === true);

  await run('document.querySelector("#agentStudioToggleBtn").click()');
  await wait(500);

  const defaults = await run(`(() => {
    const root = document.querySelector("#agentStudioRoot");
    const left = document.querySelector("#asLeftPanel").getBoundingClientRect();
    const right = document.querySelector("#asRightPanel").getBoundingClientRect();
    const center = document.querySelector(".as-center").getBoundingClientRect();
    return {
      visible: !root.hidden,
      leftClosed: root.classList.contains("left-closed"),
      rightClosed: root.classList.contains("right-closed"),
      leftW: Math.round(left.width),
      centerW: Math.round(center.width),
      rightW: Math.round(right.width),
      columns: getComputedStyle(document.querySelector(".as-body")).gridTemplateColumns,
      status: document.querySelector("#asBackendStatus").textContent,
      model: document.querySelector("#asModelLabel").textContent,
    };
  })()`);
  check("default left open", !defaults.leftClosed && defaults.leftW > 250, `${defaults.leftW}px`);
  check("default right closed", defaults.rightClosed && defaults.rightW === 0, `${defaults.rightW}px`);
  check("center column visible", defaults.centerW > 400, `${defaults.centerW}px`);
  check("three-column grid", /300px|260px/.test(defaults.columns) && /0px/.test(defaults.columns), defaults.columns);
  check("backend connected", defaults.status.includes("已连接"), defaults.status);
  check("model badge deepseek-v4-flash", defaults.model.includes("deepseek-v4-flash"), defaults.model);

  await run('document.querySelector("#asToggleLeftBtn").click()');
  await wait(350);
  const leftAfterClose = await run(`(() => ({
    w: Math.round(document.querySelector("#asLeftPanel").getBoundingClientRect().width),
    closed: document.querySelector("#agentStudioRoot").classList.contains("left-closed"),
  }))()`);
  check("left sidebar closes", leftAfterClose.closed && leftAfterClose.w === 0, `${leftAfterClose.w}px`);

  await run('document.querySelector("#asToggleLeftBtn").click()');
  await run('document.querySelector("#asToggleRightBtn").click()');
  await wait(400);
  const rightAfterOpen = await run(`(() => ({
    w: Math.round(document.querySelector("#asRightPanel").getBoundingClientRect().width),
    closed: document.querySelector("#agentStudioRoot").classList.contains("right-closed"),
  }))()`);
  check("right sidebar opens", !rightAfterOpen.closed && rightAfterOpen.w > 300, `${rightAfterOpen.w}px`);
  await snap(win, "wtp-verify-right-open.png");

  await run('document.querySelector("[data-right-tab=\\"browser\\"]").click()');
  await wait(400);
  const browserTab = await run(`(() => ({
    browserVisible: !document.querySelector("#asBrowserPanel").hidden,
    webviewHidden: document.querySelector("#asWebview").hidden,
    webviewSrc: document.querySelector("#asWebview").src,
  }))()`);
  check(
    "browser tab uses webview in desktop app",
    browserTab.browserVisible && !browserTab.webviewHidden,
    `${browserTab.webviewSrc}`,
  );

  await run(`(() => {
    const input = document.querySelector("#asBrowserUrl");
    input.value = "http://127.0.0.1:${port}/";
    document.querySelector("#asBrowserGoBtn").click();
  })()`);
  await wait(1600);
  const webviewLoad = await run(`(() => {
    const webview = document.querySelector("#asWebview");
    return { url: webview.getURL(), title: webview.getTitle() };
  })()`);
  check(
    "webview loads navigated page",
    webviewLoad.url.startsWith(`http://127.0.0.1:${port}/`),
    webviewLoad.url,
  );

  await run('document.querySelector("#asAddFeedToggleBtn").click()');
  await wait(200);
  const feedAdd = await run(`!document.querySelector("#asFeedAddPanel").hidden`);
  check("RSS add panel toggles", feedAdd === true);
  await run('document.querySelector("#asAddFeedToggleBtn").click()');

  await run('document.querySelector("#asHistoryBtn").click()');
  await wait(500);
  const history = await run(`(() => {
    const cards = document.querySelectorAll(".as-run-card");
    return { count: cards.length, first: cards[0]?.textContent || "" };
  })()`);
  check("history lists completed run", history.count >= 1 && history.first.includes("已完成"), history.first.trim().slice(0, 60));

  await run('document.querySelector(".as-run-card")?.click()');
  await wait(500);
  await run('document.querySelector("[data-right-tab=\\"preview\\"]")?.click()');
  await wait(400);
  const openedRun = await run(`(() => {
    const final = document.querySelector(".as-final");
    const frame = document.querySelector("#asPreviewFrame");
    return {
      final: final ? final.textContent.includes("成稿与发布清单") : false,
      preview: frame ? frame.srcdoc.length : 0,
    };
  })()`);
  check("opened run renders final block", openedRun.final === true);
  check("right preview iframe has content", openedRun.preview > 300, `${openedRun.preview} chars`);
  await snap(win, "wtp-verify-result.png");

  const previewModes = await run(`(() => {
    const buttons = [...document.querySelectorAll("[data-preview-mode]")];
    return {
      count: buttons.length,
      cardsActive: buttons.find((button) => button.dataset.previewMode === "cards")?.classList.contains("active"),
      articleActive: buttons.find((button) => button.dataset.previewMode === "article")?.classList.contains("active"),
      frame: document.querySelector("#asPreviewFrame")?.srcdoc || "",
    };
  })()`);
  check(
    "preview has card and article mode buttons, cards default",
    previewModes.count === 2 && previewModes.cardsActive && !previewModes.articleActive,
    `${previewModes.count} buttons`,
  );
  check("cards preview renders canvas image", previewModes.frame.includes("data:image/png") && previewModes.frame.includes("图文卡片预览"), `${previewModes.frame.length} chars`);

  await run('document.querySelector("[data-preview-mode=\\"article\\"]")?.click()');
  await wait(600);
  const articlePreview = await run(`(() => ({
    articleActive: document.querySelector("[data-preview-mode=\\"article\\"]")?.classList.contains("active"),
    frame: document.querySelector("#asPreviewFrame")?.srcdoc || "",
  }))()`);
  check(
    "article preview mode switches to long-form HTML",
    articlePreview.articleActive && articlePreview.frame.includes("<h1") && !articlePreview.frame.includes("data:image/png"),
    `${articlePreview.frame.length} chars`,
  );
  await run('document.querySelector("[data-preview-mode=\\"cards\\"]")?.click()');
  await wait(600);
  await run('document.querySelector("[data-preview-mode=\\"article\\"]")?.click()');
  await wait(400);

  await run('document.querySelector("[data-right-tab=\\"editor\\"]")?.click()');
  await wait(300);
  const editorInitial = await run(`(async () => {
    const runId = document.querySelector(".as-run-card.active")?.dataset.runId || "";
    const response = await fetch("/api/runs/" + runId);
    const job = await response.json();
    return {
      visible: !document.querySelector("#asEditorPanel").hidden,
      editorValue: document.querySelector("#asEditorInput").value,
      resultMarkdown: job.result?.markdown || "",
    };
  })()`);
  check(
    "right editor tab auto-fills latest draft",
    editorInitial.visible && editorInitial.editorValue === editorInitial.resultMarkdown,
    `${editorInitial.editorValue.length} chars`,
  );

  await run(`(() => {
    const input = document.querySelector("#asEditorInput");
    input.value = "右侧编辑器验证\\n\\n**加粗段**";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await wait(400);
  const editorWrite = await run(`(() => ({
    mainValue: document.querySelector("#contentInput").value,
    framePreview: document.querySelector("#asPreviewFrame").srcdoc.includes("右侧编辑器验证"),
  }))()`);
  check(
    "sidebar editor writes to main editor and preview",
    editorWrite.mainValue.includes("右侧编辑器验证") && editorWrite.framePreview,
    editorWrite.mainValue.slice(0, 20),
  );

  await run(`(() => {
    const input = document.querySelector("#asEditorInput");
    input.value = "同步按钮验证";
    document.querySelector("#contentInput").value = "同步按钮验证已改";
    document.querySelector(".as-sync-editor").click();
  })()`);
  const editorSynced = await run(`(() => ({
    editorValue: document.querySelector("#asEditorInput").value,
  }))()`);
  check("sync button pulls latest main content", editorSynced.editorValue === "同步按钮验证已改", editorSynced.editorValue);

  await run(`(() => {
    const input = document.querySelector("#asEditorInput");
    input.focus();
    input.setSelectionRange(0, input.value.length);
    document.querySelector('[data-as-format="h1"]').click();
  })()`);
  const editorFormat = await run(`(() => ({
    editorValue: document.querySelector("#asEditorInput").value,
    mainValue: document.querySelector("#contentInput").value,
  }))()`);
  check(
    "sidebar markdown toolbar writes to main editor",
    editorFormat.editorValue.startsWith("# ") && editorFormat.mainValue === editorFormat.editorValue,
    editorFormat.editorValue.slice(0, 14),
  );

  const pageErrors = errors.filter((message) => !message.includes("Security Warning"));
  console.log("VERIFY_DONE", results.filter((item) => item.ok).length + "/" + results.length, pageErrors.length ? JSON.stringify(pageErrors) : "no page errors");
  app.exit(pageErrors.length || results.some((item) => !item.ok) ? 1 : 0);
});
