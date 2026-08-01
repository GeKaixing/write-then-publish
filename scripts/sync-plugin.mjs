// 兼容旧命令：转发到统一同步脚本
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync(
  process.execPath,
  [join(root, "scripts/sync-surfaces.mjs"), "--targets=obsidian"],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
