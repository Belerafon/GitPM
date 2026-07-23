import { spawn, spawnSync } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const host = "127.0.0.1";
const port = 32100 + Math.floor(Math.random() * 1000);
const baseUrl = `http://${host}:${port}`;
const correlationId = "p00-smoke-correlation";
const logs = [];
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "gitpm-smoke-"));
const repository = path.join(temporaryRoot, "source");
const runtimeData = path.join(temporaryRoot, "data");
await cp(path.join(process.cwd(), "fixtures", "schema-v1", "demo"), repository, { recursive: true });
for (const args of [["init", "-b", "main"], ["add", "."], ["-c", "user.name=GitPM Smoke", "-c", "user.email=smoke@localhost", "commit", "-m", "Initialize smoke fixture"]]) {
  const result = spawnSync("git", args, { cwd: repository, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`Unable to prepare smoke repository: ${result.stderr}`);
}
const server = spawn(process.execPath, ["apps/server/dist/index.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    GITPM_DATA_DIR: runtimeData,
    GITPM_REPOSITORY_PATH: repository,
    HOST: host,
    LOG_LEVEL: "info",
    PORT: String(port),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

server.stdout.setEncoding("utf8");
server.stderr.setEncoding("utf8");
server.stdout.on("data", (chunk) => logs.push(chunk));
server.stderr.on("data", (chunk) => logs.push(chunk));

async function request(path) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { "x-correlation-id": correlationId },
  });
  const body = await response.json();
  if (!response.ok || body.status !== "ok" || body.correlation_id !== correlationId) {
    throw new Error(`${path} failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function waitUntilListening() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(`server exited early (${server.exitCode})\n${logs.join("")}`);
    }
    try {
      await fetch(`${baseUrl}/health/live`);
      return;
    } catch {
      await delay(100);
    }
  }
  throw new Error(`server did not listen in time\n${logs.join("")}`);
}

try {
  await waitUntilListening();
  const live = await request("/health/live");
  const ready = await request("/health/ready");
  await delay(50);

  const records = logs
    .join("")
    .split(/\r?\n/u)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  const correlated = records.find((record) => record.correlation_id === correlationId);
  if (correlated === undefined) {
    throw new Error(`correlation ID is absent from structured logs\n${logs.join("")}`);
  }

  process.stdout.write(`${JSON.stringify({ live, ready, sanitized_log: correlated })}\n`);
} finally {
  if (server.exitCode === null) {
    const exited = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await Promise.race([exited, delay(5_000)]);
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}
