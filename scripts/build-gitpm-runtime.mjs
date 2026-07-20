import { spawnSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function modifiedAt(target) {
  try {
    const info = await stat(target);
    if (!info.isDirectory()) return info.mtimeMs;
    const children = await readdir(target);
    const childTimes = await Promise.all(children.map(async (child) => await modifiedAt(join(target, child))));
    return Math.max(info.mtimeMs, ...childTimes);
  } catch (error) {
    if (error?.code === "ENOENT") return Number.POSITIVE_INFINITY;
    throw error;
  }
}

const sharedInputs = [
  join(root, "tsconfig.base.json"),
  join(root, "pnpm-lock.yaml"),
];
const packageRoot = join(root, "packages");
const stale = [];
for (const entry of await readdir(packageRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const directory = join(packageRoot, entry.name);
  const packageJsonPath = join(directory, "package.json");
  let packageJson;
  try {
    packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") continue;
    throw error;
  }
  if (typeof packageJson.scripts?.build !== "string" || typeof packageJson.name !== "string") continue;
  const output = join(directory, typeof packageJson.main === "string" ? packageJson.main : "dist/index.js");
  const outputTime = await modifiedAt(output);
  const inputTime = Math.max(...await Promise.all([
    join(directory, "src"),
    packageJsonPath,
    join(directory, "tsconfig.json"),
    ...sharedInputs,
  ].map(async (input) => await modifiedAt(input))));
  if (!Number.isFinite(outputTime) || outputTime < inputTime) stale.push(packageJson.name);
}

if (stale.length === 0) {
  console.log("[GitPM] Workspace-пакеты актуальны, пересборка не требуется.");
  process.exit(0);
}

console.log(`[GitPM] Пересобираю изменённые workspace-пакеты: ${stale.join(", ")}`);
const pnpmArguments = ["pnpm", "-r", ...stale.flatMap((name) => ["--filter", name]), "--if-present", "build"];
const result = process.platform === "win32"
  ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", ["corepack", ...pnpmArguments].join(" ")], {
      cwd: root, stdio: "inherit", windowsHide: true,
    })
  : spawnSync("corepack", pnpmArguments, { cwd: root, stdio: "inherit" });
if (result.error !== undefined) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

console.log("[GitPM] Workspace-пакеты собраны.");
