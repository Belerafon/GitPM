import { execFile, spawn } from "node:child_process";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const git = process.platform === "win32" ? "git.exe" : "git";
const corepack = process.platform === "win32" ? "corepack.cmd" : "corepack";

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function lockPath() {
  const { stdout } = await execFileAsync(git, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: process.cwd() });
  return path.join(stdout.trim(), "gitpm-playwright.lock");
}

async function acquireLock(target) {
  const waitMinutes = Number(process.env.GITPM_E2E_LOCK_TIMEOUT_MINUTES || 60);
  const deadline = Date.now() + (Number.isFinite(waitMinutes) ? waitMinutes : 60) * 60_000;
  let lastNotice = 0;
  await mkdir(path.dirname(target), { recursive: true });
  while (Date.now() < deadline) {
    try {
      const handle = await open(target, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, cwd: process.cwd(), acquiredAt: new Date().toISOString() }));
      return handle;
    } catch (error) {
      if (!(error instanceof Error) || !Reflect.has(error, "code") || error.code !== "EEXIST") throw error;
      let owner;
      try {
        owner = JSON.parse(await readFile(target, "utf8"));
      } catch {
        owner = undefined;
      }
      if (!owner || !processAlive(owner.pid)) {
        await unlink(target).catch(() => undefined);
        continue;
      }
      if (Date.now() - lastNotice >= 30_000 || lastNotice === 0) {
        console.log(`[e2e-lock] waiting for pid=${owner.pid}; cwd=${owner.cwd ?? "unknown"}`);
        lastNotice = Date.now();
      }
      await delay(2_000);
    }
  }
  throw new Error(`Timed out waiting for the repository Playwright lock: ${target}`);
}

const target = await lockPath();
const handle = await acquireLock(target);
let child;
const release = async () => {
  await handle.close().catch(() => undefined);
  await unlink(target).catch(() => undefined);
};
const forwardSignal = (signal) => {
  if (child?.pid) child.kill(signal);
};
process.once("SIGINT", () => forwardSignal("SIGINT"));
process.once("SIGTERM", () => forwardSignal("SIGTERM"));

try {
  console.log(`[e2e-lock] acquired ${target}`);
  const args = ["pnpm", "exec", "playwright", "test", ...process.argv.slice(2)];
  child = spawn(corepack, args, {
    cwd: process.cwd(),
    env: process.env,
    shell: process.platform === "win32",
    stdio: "inherit",
    windowsHide: true,
  });
  process.exitCode = await new Promise((resolve) => {
    child.once("error", () => resolve(1));
    child.once("close", (code) => resolve(code ?? 1));
  });
} finally {
  await release();
  console.log("[e2e-lock] released");
}
