import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "obsidian-plugin", "plugin-assets");

const files = [
  ["index.html", "index.html"],
  ["src/styles.css", "src/styles.css"],
  ["src/app.js", "src/app.js"],
  ["vendor/html2canvas.min.js", "vendor/html2canvas.min.js"],
  ["vendor/jszip.min.js", "vendor/jszip.min.js"],
  ["assets/esther-buer-avatar.png", "img/esther-buer-avatar.png"],
];

function assertMarker(file, marker) {
  if (!file.includes(marker)) {
    throw new Error(`找不到替换标记：${marker}`);
  }
}

const appJs = readFileSync(join(root, "src/app.js"), "utf8");
assertMarker(appJs, 'const sampleAvatar = "assets/esther-buer-avatar.png";');

const indexHtml = readFileSync(join(root, "index.html"), "utf8");
for (const marker of [
  'href="src/styles.css',
  '<script src="vendor/jszip.min.js"></script>',
  "cdn.jsdelivr.net/npm/lucide",
  '<script src="vendor/html2canvas.min.js"></script>',
  '<script src="src/app.js',
]) {
  assertMarker(indexHtml, marker);
}

for (const [source, destination] of files) {
  const from = join(root, source);
  const to = join(target, destination);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  console.log(`同步 ${source} -> obsidian-plugin/plugin-assets/${destination}`);
}

console.log("插件资源同步完成。");
