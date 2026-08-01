import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION_MARKER = "@wtp-version";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}


function replaceOnce(source, pattern, replacement, label) {
  if (!pattern.test(source)) {
    throw new Error(`${label}: 找不到匹配 ${pattern}`);
  }
  return source.replace(pattern, replacement);
}

function writeIfChanged(path, next) {
  const previous = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (previous === next) return false;
  ensureDir(dirname(path));
  writeFileSync(path, next);
  return true;
}

function parseTargets(argv) {
  const raw = argv.find((arg) => arg.startsWith("--targets="));
  if (!raw) return new Set(["version", "web", "obsidian", "extension", "skill"]);
  const items = raw
    .slice("--targets=".length)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!items.length) {
    throw new Error("--targets 不能为空");
  }
  return new Set(items);
}

function loadVersion() {
  const pkg = readJson(join(root, "package.json"));
  const version = String(pkg.version || "").trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`package.json version 非法: ${version}`);
  }
  return version;
}

function syncWebVersion(version) {
  const appPath = join(root, "src/app.js");
  let appJs = readFileSync(appPath, "utf8");
  appJs = replaceOnce(
    appJs,
    /const APP_VERSION = "[^"]+"; \/\/ @wtp-version/,
    `const APP_VERSION = "${version}"; // ${VERSION_MARKER}`,
    "src/app.js APP_VERSION",
  );
  writeIfChanged(appPath, appJs);

  const indexPath = join(root, "index.html");
  let indexHtml = readFileSync(indexPath, "utf8");
  if (indexHtml.includes('id="appVersion"')) {
    indexHtml = replaceOnce(
      indexHtml,
      /id="appVersion" class="app-version">v[^<]+<\/span>/,
      `id="appVersion" class="app-version">v${version}</span>`,
      "index.html appVersion badge",
    );
    writeIfChanged(indexPath, indexHtml);
  }

  console.log(`web 版本 -> ${version}`);
}

function stripWebOnlyPublishUi(html) {
  const toolbarStart = html.indexOf('<div class="publish-toolbar"');
  const mainbarMarker = '<div class="preview-mainbar">';
  const mainbarStart = html.indexOf(mainbarMarker);
  if (toolbarStart !== -1 && mainbarStart !== -1 && mainbarStart > toolbarStart) {
    html = html.slice(0, toolbarStart) + html.slice(mainbarStart);
  }
  if (toolbarStart !== -1 && (mainbarStart === -1 || mainbarStart < toolbarStart)) {
    throw new Error("找不到发布工具栏结束标记：preview-mainbar");
  }
  const statusStart = html.indexOf('<span id="extensionStatus"');
  if (statusStart !== -1) {
    const statusEnd = html.indexOf("</span>", statusStart);
    if (statusEnd !== -1) {
      html = html.slice(0, statusStart) + html.slice(statusEnd + "</span>".length);
    }
  }
  return html;
}

function syncObsidian(version) {
  const target = join(root, "obsidian-plugin", "plugin-assets");
  const files = [
    ["index.html", "index.html"],
    ["src/styles.css", "src/styles.css"],
    ["src/app.js", "src/app.js"],
    ["vendor/html2canvas.min.js", "vendor/html2canvas.min.js"],
    ["vendor/jszip.min.js", "vendor/jszip.min.js"],
    ["assets/esther-buer-avatar.png", "img/esther-buer-avatar.png"],
  ];

  const appJs = readFileSync(join(root, "src/app.js"), "utf8");
  if (!appJs.includes('const sampleAvatar = "assets/esther-buer-avatar.png";')) {
    throw new Error('src/app.js 缺少 sampleAvatar 标记');
  }

  const indexHtml = readFileSync(join(root, "index.html"), "utf8");
  for (const marker of [
    'href="src/styles.css',
    '<script src="vendor/jszip.min.js"></script>',
    "cdn.jsdelivr.net/npm/lucide",
    '<script src="vendor/html2canvas.min.js"></script>',
    '<script src="src/app.js',
  ]) {
    if (!indexHtml.includes(marker)) {
      throw new Error(`index.html 缺少标记：${marker}`);
    }
  }

  for (const [source, destination] of files) {
    const from = join(root, source);
    const to = join(target, destination);
    ensureDir(dirname(to));
    if (source === "index.html") {
      writeFileSync(to, stripWebOnlyPublishUi(readFileSync(from, "utf8")));
    } else {
      copyFileSync(from, to);
    }
    console.log(`同步 ${source} -> obsidian-plugin/plugin-assets/${destination}`);
  }

  const manifestPath = join(root, "obsidian-plugin/manifest.json");
  const manifest = readJson(manifestPath);
  const minAppVersion = String(manifest.minAppVersion || "1.4.0");
  manifest.version = version;
  writeJson(manifestPath, manifest);

  const versionsPath = join(root, "obsidian-plugin/versions.json");
  const versions = existsSync(versionsPath) ? readJson(versionsPath) : {};
  versions[version] = minAppVersion;
  writeJson(versionsPath, versions);

  console.log(`obsidian 版本 -> ${version} (minAppVersion ${minAppVersion})`);
}

function syncExtension(version) {
  const manifestPath = join(root, "extension/manifest.json");
  const manifest = readJson(manifestPath);
  manifest.version = version;
  writeJson(manifestPath, manifest);

  const contentPath = join(root, "extension/content.js");
  let content = readFileSync(contentPath, "utf8");
  content = replaceOnce(
    content,
    /const EXTENSION_VERSION = "[^"]+"; \/\/ @wtp-version/,
    `const EXTENSION_VERSION = "${version}"; // ${VERSION_MARKER}`,
    "extension/content.js EXTENSION_VERSION",
  );
  writeIfChanged(contentPath, content);

  console.log(`extension 版本 -> ${version}`);
}

function resolveSkillRoot() {
  const envPath = process.env.WTP_SKILL_DIR;
  if (envPath) return envPath;
  return join(homedir(), ".codex/skills/write-then-publish-render");
}

function syncSkill(version) {
  const skillRoot = resolveSkillRoot();
  if (!existsSync(skillRoot)) {
    console.warn(`跳过 skill：目录不存在 ${skillRoot}`);
    return;
  }

  const appTarget = join(skillRoot, "assets/app");
  ensureDir(appTarget);

  // 完整同步前端运行时，避免 skill 副本落后。
  const runtimeFiles = [
    "index.html",
    "src/app.js",
    "src/styles.css",
    "vendor/html2canvas.min.js",
    "vendor/jszip.min.js",
    "assets/esther-buer-avatar.png",
  ];

  for (const rel of runtimeFiles) {
    const from = join(root, rel);
    const to = join(appTarget, rel);
    if (!existsSync(from)) {
      throw new Error(`skill 同步缺少源文件：${rel}`);
    }
    ensureDir(dirname(to));
    copyFileSync(from, to);
    console.log(`同步 ${rel} -> ${relative(skillRoot, to)}`);
  }

  // 可选：若 skill 仓库内有 VERSION 文件则同步
  const versionFile = join(skillRoot, "VERSION");
  writeIfChanged(versionFile, `${version}\n`);

  const skillMdPath = join(skillRoot, "SKILL.md");
  if (existsSync(skillMdPath)) {
    let skillMd = readFileSync(skillMdPath, "utf8");
    if (skillMd.startsWith("---\n")) {
      if (/^version:\s*.+$/m.test(skillMd)) {
        skillMd = skillMd.replace(/^version:\s*.+$/m, `version: ${version}`);
      } else {
        skillMd = skillMd.replace("---\n", `---\nversion: ${version}\n`, 1);
      }
    } else {
      skillMd = `<!-- write-then-publish version: ${version} -->\n` + skillMd.replace(
        /^<!-- write-then-publish version: .* -->\n/m,
        "",
      );
    }
    writeIfChanged(skillMdPath, skillMd);
  }

  console.log(`skill 版本 -> ${version} (${skillRoot})`);
}

function main() {
  const targets = parseTargets(process.argv.slice(2));
  const version = loadVersion();
  console.log(`统一版本源 package.json = ${version}`);

  // version/web 总是先写回源树，避免副本拿到旧版本
  if (targets.has("version") || targets.has("web") || targets.has("all")) {
    syncWebVersion(version);
  } else if ([...targets].some((t) => ["obsidian", "extension", "skill"].includes(t))) {
    // 副本同步前确保源树版本已对齐
    syncWebVersion(version);
  }

  if (targets.has("obsidian") || targets.has("all")) syncObsidian(version);
  if (targets.has("extension") || targets.has("all")) syncExtension(version);
  if (targets.has("skill") || targets.has("all")) syncSkill(version);

  // 默认全量
  if (![...targets].some((t) => ["version", "web", "obsidian", "extension", "skill", "all"].includes(t))) {
    throw new Error(`未知 targets: ${[...targets].join(",")}`);
  }

  console.log("版本与多端同步完成。");
}

main();
