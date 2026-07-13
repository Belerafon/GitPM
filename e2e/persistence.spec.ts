import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, request as playwrightRequest, test } from "@playwright/test";
import { E2E_TASK_ID, cleanupDrafts, taskDocument, type EntityResult } from "./helpers.js";

const isWindows = process.platform === "win32";
const workspace = process.cwd();
const persistencePort = 3101;
const persistenceUrl = `http://127.0.0.1:${persistencePort}`;
const persistenceData = path.join(workspace, ".tmp", "playwright-persistence");
const persistenceRepository = path.join(persistenceData, "source");
const persistenceRuntimeData = path.join(persistenceData, "data");
const execFileAsync = promisify(execFile);

interface RunningServer {
  readonly child: ChildProcess;
  readonly output: () => string;
}

async function startServer(): Promise<RunningServer> {
  let captured = "";
  const child = spawn("corepack", ["pnpm", "--filter", "@gitpm/server", "exec", "tsx", "src/index.ts"], {
    cwd: workspace,
    detached: !isWindows,
    env: {
      ...process.env,
      GITPM_REPOSITORY_PATH: persistenceRepository,
      GITPM_DATA_DIR: persistenceRuntimeData,
      HOST: "127.0.0.1",
      PORT: String(persistencePort),
    },
    shell: isWindows,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout?.on("data", (chunk: Buffer) => { captured += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk: Buffer) => { captured += chunk.toString("utf8"); });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early (${child.exitCode}):\n${captured}`);
    try {
      const response = await fetch(`${persistenceUrl}/health/ready`);
      if (response.ok) return { child, output: () => captured };
    } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await stopServer({ child, output: () => captured });
  throw new Error(`Server did not become ready:\n${captured}`);
}

async function stopServer(server: RunningServer): Promise<void> {
  const pid = server.child.pid;
  if (pid === undefined || server.child.exitCode !== null) return;
  if (isWindows) {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    try { process.kill(-pid, "SIGTERM"); } catch { /* already stopped */ }
  }
  await Promise.race([
    new Promise<void>((resolve) => server.child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
}

test("creates the default local draft and recovers its dirty files after a real server restart", async () => {
  await rm(persistenceData, { recursive: true, force: true });
  await mkdir(persistenceData, { recursive: true });
  await cp(path.join(workspace, "fixtures", "schema-v1", "demo"), persistenceRepository, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main"], { cwd: persistenceRepository, windowsHide: true });
  await execFileAsync("git", ["add", "."], { cwd: persistenceRepository, windowsHide: true });
  await execFileAsync("git", ["-c", "user.name=GitPM E2E", "-c", "user.email=e2e@localhost", "commit", "-m", "Initialize persistence fixture"], { cwd: persistenceRepository, windowsHide: true });
  let server: RunningServer | undefined;
  let api = await playwrightRequest.newContext({ baseURL: persistenceUrl });
  try {
    server = await startServer();
    const initialDraftsResponse = await api.get("/api/drafts");
    const initialDrafts = await initialDraftsResponse.json() as Array<{ draft_id: string; fingerprint: string }>;
    expect(initialDrafts).toEqual([expect.objectContaining({ draft_id: "DRF-LOCAL" })]);
    const draft = initialDrafts[0];
    if (draft === undefined) throw new Error("Default local draft was not created");
    const createdResponse = await api.post("/api/drafts/DRF-LOCAL/entities/tasks", {
      data: { expected_fingerprint: draft.fingerprint, document: taskDocument() },
    });
    expect(createdResponse.status(), await createdResponse.text()).toBe(201);
    const created = await createdResponse.json() as EntityResult;
    expect(created.document.id).toBe(E2E_TASK_ID);

    await api.dispose();
    await stopServer(server);
    server = await startServer();
    api = await playwrightRequest.newContext({ baseURL: persistenceUrl });

    const session = await api.get("/api/auth/session");
    expect(await session.json()).toMatchObject({ mode: "repository", repository: { name: "source" }, role: "Maintainer" });
    const drafts = await api.get("/api/drafts");
    expect(await drafts.json()).toEqual([expect.objectContaining({ draft_id: "DRF-LOCAL", state: "open" })]);
    const task = await api.get(`/api/drafts/DRF-LOCAL/entities/tasks/${E2E_TASK_ID}`);
    expect(task.status(), await task.text()).toBe(200);
    expect(await task.json()).toMatchObject({ document: { id: E2E_TASK_ID, title: "E2E task" } });
    const changes = await api.get("/api/drafts/DRF-LOCAL/changes");
    expect(await changes.json()).toMatchObject({ changed_files_count: 1 });

    await cleanupDrafts(api);
  } finally {
    await api.dispose();
    if (server !== undefined) await stopServer(server);
    await rm(persistenceData, { recursive: true, force: true });
  }
});
