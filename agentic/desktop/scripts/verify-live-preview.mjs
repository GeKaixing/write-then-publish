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
  await wait(1500);
  await run('document.querySelector("#agentStudioToggleBtn").click()');
  await wait(400);

  const originalConfig = await run(`(async () => {
    const response = await fetch("/api/config");
    return await response.json();
  })()`);

  await run(`(async () => {
    document.querySelector("#asModelBtn").click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    document.querySelector("#asProvider").value = "demo";
    document.querySelector("#asModel").value = "demo";
    document.querySelector("#asBaseUrl").value = "";
    document.querySelector("#asApiKey").value = "";
    document.querySelector("#asTemperature").value = "0.7";
    document.querySelector("#asConfigForm").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 300));
  })()`);

  await run(`(() => {
    const source = document.querySelector("#asSource");
    source.value = "多 Agent 流水线：规划大脑拆解任务，三个专家并行写作，评审控制质量，LangGraph 的 Send 机制负责并行分发。";
    document.querySelector("#asGoal").value = "写一篇多 Agent 创作方法说明";
    document.querySelector("#asRunForm").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  })()`);
  await wait(50);
  const runId = await run('document.querySelector(".as-run-msg")?.dataset.runId || ""');
  await run('document.querySelector("#asCloseBtn").click()');

  let statusText = "";
  let backendStatus = "queued";
  for (let index = 0; index < 60; index += 1) {
    await wait(500);
    backendStatus = await run(`(async () => {
      const response = await fetch("/api/runs/${runId}");
      const job = await response.json();
      return job.status;
    })()`);
    if (backendStatus === "completed" || backendStatus === "failed") break;
  }
  await run('document.querySelector("#agentStudioToggleBtn").click()');
  await run('document.querySelector("#asToggleRightBtn").click()');
  await wait(400);

  const state = await run(`(() => {
    const frame = document.querySelector("#asPreviewFrame");
    const doc = frame.contentDocument || frame.contentWindow?.document;
    const text = doc ? doc.body.innerText : "";
    return {
      runState: document.querySelector("#asRunState").textContent.trim(),
      previewBody: text.slice(0, 120),
      placeholder: text.includes("运行完成后，成稿预览会显示在这里"),
      finalBlock: Boolean(document.querySelector(".as-final")),
      rightOpen: !document.querySelector("#agentStudioRoot").classList.contains("right-closed"),
    };
  })()`);
  check("backend run completed", backendStatus === "completed", `${backendStatus} ${runId}`);
  check("right panel opens after reopen", state.rightOpen === true);
  check("chat final block rendered", state.finalBlock === true);
  check("preview no longer placeholder", state.placeholder === false, state.previewBody);
  check("preview has generated content", state.previewBody.length > 20, state.previewBody);

  await run('document.querySelector("[data-right-tab=\\"editor\\"]")?.click()');
  await wait(300);
  const editorState = await run(`(async () => {
    const response = await fetch("/api/runs/${runId}");
    const job = await response.json();
    return {
      editorValue: document.querySelector("#asEditorInput").value,
      resultMarkdown: job.result?.markdown || "",
    };
  })()`);
  check(
    "sidebar editor auto-fills final draft",
    editorState.editorValue === editorState.resultMarkdown && editorState.resultMarkdown.length > 0,
    `${editorState.resultMarkdown.length} chars`,
  );

  await run(`(async () => {
    await fetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(${JSON.stringify(originalConfig)}),
    });
  })()`);

  const pageErrors = errors.filter((message) => !message.includes("Security Warning"));
  console.log("VERIFY_LIVE_DONE", results.filter((item) => item.ok).length + "/" + results.length, pageErrors.length ? JSON.stringify(pageErrors) : "no page errors");
  app.exit(pageErrors.length || results.some((item) => !item.ok) ? 1 : 0);
});
