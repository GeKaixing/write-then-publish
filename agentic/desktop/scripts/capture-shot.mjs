import electron from "electron";
const { app, BrowserWindow } = electron;
import fs from "node:fs";
import path from "node:path";

const port = process.env.AS_PORT || "57529";
const outDir = process.env.AS_SHOT_DIR || "/tmp";

async function snap(win, name) {
  const image = await win.webContents.capturePage();
  const file = path.join(outDir, name);
  fs.writeFileSync(file, image.toPNG());
  console.log("SHOT_OK", file);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1480,
    height: 960,
    show: false,
    backgroundColor: "#f8fafc",
  });
  const errors = [];
  win.webContents.on("console-message", (event, level, message) => {
    if (level >= 2) errors.push(message);
  });
  win.webContents.on("did-fail-load", (event, code, description) => {
    errors.push(`load:${code} ${description}`);
  });

  await win.loadURL(`http://127.0.0.1:${port}/`);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  await snap(win, "wtp-home.png");

  await win.webContents.executeJavaScript(
    'document.querySelector("#agentStudioToggleBtn")?.click()',
  );
  await new Promise((resolve) => setTimeout(resolve, 900));
  await snap(win, "wtp-agent-studio.png");

  await win.webContents.executeJavaScript(
    'document.querySelector("#asConfigPopover").hidden = false',
  );
  await new Promise((resolve) => setTimeout(resolve, 400));
  await snap(win, "wtp-agent-config.png");

  await win.webContents.executeJavaScript(
    'document.querySelector("#asConfigPopover").hidden = true',
  );
  await win.webContents.executeJavaScript(`
    (() => {
      const source = document.querySelector("#asSource");
      const goal = document.querySelector("#asGoal");
      if (source) source.value = "LangGraph 用 Send 并行分发专家任务，评审控制质量。";
      if (goal) goal.value = "写一篇多 Agent 内容流水线的实战说明";
    })()
  `);
  await win.webContents.executeJavaScript(
    'document.querySelector("#asRunBtn")?.click()',
  );
  for (let index = 0; index < 300; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const done = await win.webContents.executeJavaScript(`
      (() => {
        const final = document.querySelector(".as-final");
        const err = document.querySelector(".as-err-box");
        return Boolean(final || err);
      })()
    `);
    if (done) break;
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  await snap(win, "wtp-agent-result.png");

  console.log("CAPTURE_DONE", errors.length ? JSON.stringify(errors) : "no console errors");
  app.exit(0);
});
