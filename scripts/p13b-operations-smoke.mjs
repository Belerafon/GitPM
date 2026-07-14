#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DraftManager } from "../packages/drafts/dist/index.js";
import { GitClient } from "../packages/git-client/dist/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "gitpm-p13b-operations-"));
const port = 31_000 + Math.floor(Math.random() * 1000);

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

async function waitReady() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health/ready`);
      if (response.ok) return await response.json();
    } catch {
      // Process startup is still in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server did not become ready");
}

async function startAndStopServer() {
  const child = spawn(process.execPath, [path.join(ROOT, "apps", "server", "dist", "index.js")], {
    cwd: ROOT,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const ready = await waitReady();
  child.kill("SIGTERM");
  const stopped = await new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  if (stopped.code !== 0 && stopped.signal !== "SIGTERM") throw new Error(`server stopped with ${JSON.stringify(stopped)}: ${stderr}`);
  return ready;
}

try {
  const firstHealth = await startAndStopServer();
  const secondHealth = await startAndStopServer();

  const source = path.join(temporaryRoot, "source");
  const remote = path.join(temporaryRoot, "remote.git");
  const data = path.join(temporaryRoot, "data");
  await mkdir(source);
  await cp(path.join(ROOT, "fixtures", "schema-v1", "demo"), source, { recursive: true });
  git(source, "init", "-b", "main");
  git(source, "add", ".");
  git(source, "-c", "user.name=GitPM Operations", "-c", "user.email=operations@example.test", "commit", "-m", "operations fixture");
  git(temporaryRoot, "init", "--bare", remote);
  git(source, "remote", "add", "origin", remote);
  git(source, "push", "origin", "main");

  const runtime = () => {
    const client = new GitClient({ dataDirectory: data, remoteUrl: remote, defaultBranch: "main", allowLocalTestRemote: true });
    return new DraftManager(client, data);
  };
  const firstRuntime = runtime();
  const draft = await firstRuntime.createDraft("DRF-OPERATIONS", "42");
  const projectPath = path.join(draft.worktree_path, "projects", "P-26-MGP84K", "project.yaml");
  const original = await readFile(projectPath, "utf8");
  await writeFile(projectPath, original.replace("GitPM launch", "GitPM durable write"), "utf8");

  const restarted = runtime();
  const recovery = await restarted.recover();
  const recoveredDraft = recovery.drafts.find((item) => item.draft_id === "DRF-OPERATIONS");
  if (!recoveredDraft) throw new Error("draft was not recovered after restart");
  if (!(await readFile(projectPath, "utf8")).includes("GitPM durable write")) throw new Error("dirty write was lost on restart");
  if (!(await restarted.poll("DRF-OPERATIONS")).changedExternally) throw new Error("dirty draft was silently accepted or cleaned");
  await restarted.closeDraft("DRF-OPERATIONS", "42");
  let confirmationRejected = false;
  try { await restarted.cleanupDraft("DRF-OPERATIONS", "wrong"); } catch (error) { confirmationRejected = error?.code === "CLEANUP_CONFIRMATION_REQUIRED"; }
  if (!confirmationRejected) throw new Error("cleanup did not require exact confirmation");
  await restarted.cleanupDraft("DRF-OPERATIONS", "DRF-OPERATIONS");
  const finalRecovery = await restarted.recover();
  if (finalRecovery.drafts.some((item) => item.draft_id === "DRF-OPERATIONS")) throw new Error("explicit cleanup left draft metadata");

  console.log(JSON.stringify({
    server: { first_start: firstHealth.status, restart: secondHealth.status },
    draft: {
      recovered_after_restart: true,
      dirty_write_preserved: true,
      dirty_draft_not_auto_cleaned: true,
      wrong_cleanup_confirmation_rejected: true,
      explicit_cleanup_removed_draft: true,
    },
    result: "passed",
  }, null, 2));
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
