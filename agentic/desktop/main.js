import { app, BrowserWindow } from "electron";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const BACKEND_DIR = path.join(ROOT, "agentic", "backend");
const ICON_PNG = path.join(__dirname, "assets", "app-icon.png");
const ICON_ICNS = path.join(__dirname, "assets", "app-icon.icns");

let backendProcess = null;
let mainWindow = null;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function backendReady(port) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return true;
    } catch {
      // backend still booting
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

function startBackend(port) {
  const candidates = [
    process.env.WTP_BACKEND_PYTHON,
    path.join(BACKEND_DIR, ".venv", "bin", "python"),
    "python3",
  ].filter(Boolean);
  const python = candidates.find((candidate) => {
    if (candidate.includes(path.sep)) return true;
    try {
      return spawnSync("which", [candidate]).status === 0;
    } catch {
      return false;
    }
  });
  const args = ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(port)];
  backendProcess = spawn(python, args, {
    cwd: BACKEND_DIR,
    env: { ...process.env, WTP_FRONTEND_DIR: ROOT },
    stdio: ["ignore", "pipe", "pipe"],
  });
  backendProcess.stdout.on("data", (chunk) => {
    process.stdout.write(`[backend] ${chunk}`);
  });
  backendProcess.stderr.on("data", (chunk) => {
    process.stderr.write(`[backend] ${chunk}`);
  });
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 1120,
    minHeight: 720,
    title: "文象 Agent Studio",
    icon: process.platform === "darwin" ? ICON_ICNS : ICON_PNG,
    backgroundColor: "#f8fafc",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  mainWindow.loadURL(`http://127.0.0.1:${port}/`);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function launch() {
  const port = await freePort();
  startBackend(port);
  if (!(await backendReady(port))) {
    throw new Error("本地后端启动超时，请检查 agentic/backend 依赖是否已安装（cd agentic/backend && uv sync）");
  }
  createWindow(port);
}

app.whenReady().then(() => {
  if (process.platform === "darwin" && app.dock) {
    app.dock.setIcon(ICON_PNG);
  }
  launch().catch((error) => {
    console.error(error);
    app.exit(1);
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  if (backendProcess && !backendProcess.killed) {
    backendProcess.kill("SIGTERM");
  }
});
