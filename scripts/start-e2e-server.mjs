import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const isWindows = process.platform === "win32";
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDirectory = path.join(workspace, ".tmp", "playwright-local");
const repository = path.join(dataDirectory, "source");
const runtimeData = path.join(dataDirectory, "data");
await rm(dataDirectory, { recursive: true, force: true });
await mkdir(dataDirectory, { recursive: true });
await cp(path.join(workspace, "fixtures", "schema-v1", "demo"), repository, { recursive: true });
for (const args of [["init", "-b", "main"], ["add", "."], ["-c", "user.name=GitPM E2E", "-c", "user.email=e2e@localhost", "commit", "-m", "Initialize E2E fixture"]]) {
  const result = spawnSync("git", args, { cwd: repository, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`Unable to prepare E2E repository: ${result.stderr}`);
}

const child = spawn("corepack", ["pnpm", "--filter", "@gitpm/server", "exec", "tsx", "src/index.ts"], {
  cwd: workspace,
  detached: !isWindows,
  env: {
    ...process.env,
    GITPM_REPOSITORY_PATH: repository,
    GITPM_DATA_DIR: runtimeData,
    HOST: "127.0.0.1",
    PORT: "3100",
  },
  shell: isWindows,
  stdio: "inherit",
  windowsHide: true,
});

let stopping = false;

function terminate() {
  if (child.pid === undefined || child.killed) return;
  if (isWindows) {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* already stopped */ }
  }
}

async function stop(code) {
  if (stopping) return;
  stopping = true;
  terminate();
  await rm(dataDirectory, { recursive: true, force: true });
  process.exit(code);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => { void stop(0); });
}

child.once("error", (error) => {
  console.error(`[e2e] server failed to start: ${error.message}`);
  void stop(1);
});
child.once("exit", (code) => {
  if (!stopping) void stop(code ?? 1);
});
