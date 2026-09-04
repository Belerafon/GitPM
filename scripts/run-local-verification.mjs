import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { stepAffectedByPaths } from "./verification-change-impact.mjs";

const execFileAsync = promisify(execFile);

const corepack = process.platform === "win32" ? "corepack.cmd" : "corepack";
const git = process.platform === "win32" ? "git.exe" : "git";

const fullSteps = [
  { name: "clean", command: corepack, args: ["pnpm", "clean"], timeoutMinutes: 5 },
  { name: "build", command: corepack, args: ["pnpm", "build"], timeoutMinutes: 15 },
  { name: "lint", command: corepack, args: ["pnpm", "lint"], timeoutMinutes: 10 },
  { name: "typecheck", command: corepack, args: ["pnpm", "typecheck:after-build"], timeoutMinutes: 10 },
  { name: "tests", command: corepack, args: ["pnpm", "test"], timeoutMinutes: 30 },
  { name: "e2e", command: corepack, args: ["pnpm", "e2e"], timeoutMinutes: 20 },
  { name: "smoke", command: corepack, args: ["pnpm", "smoke"], timeoutMinutes: 5 },
  { name: "schemas", command: corepack, args: ["pnpm", "schema:verify"], timeoutMinutes: 5 },
  { name: "security report", command: process.execPath, args: ["scripts/security-spike-report.mjs"], timeoutMinutes: 5 },
  { name: "planning", command: corepack, args: ["pnpm", "planning:verify"], timeoutMinutes: 5 },
];

const guidanceFiles = [
  "packages/drafts/src/direct-guidance.ts",
  "packages/drafts/src/worktree-guidance.ts",
  "packages/drafts/src/guidance.test.ts",
];

const diffCheck = { name: "diff whitespace", command: git, args: ["diff", "--check"], timeoutMinutes: 2 };

function pnpmStep(name, args, timeoutMinutes = 10) {
  return { name, command: corepack, args: ["pnpm", ...args], timeoutMinutes };
}

function sourceProfile({ buildFilters, lintPaths, testScript, webTypecheck = false, extraSteps = [] }) {
  const filterArguments = buildFilters.flatMap((filter) => ["--filter", `${filter}...`]);
  return [
    pnpmStep("build affected packages", [...filterArguments, "build"], 15),
    pnpmStep("lint affected sources", ["exec", "eslint", ...lintPaths, "--max-warnings", "0"]),
    ...(webTypecheck ? [pnpmStep("typecheck web", ["--filter", "@gitpm/web", "typecheck"])] : []),
    pnpmStep("thematic tests", [testScript], 30),
    ...extraSteps,
    diffCheck,
  ];
}

const profiles = {
  full: fullSteps,
  guidance: [
    { name: "build guidance dependencies", command: corepack, args: ["pnpm", "--filter", "@gitpm/drafts...", "build"], timeoutMinutes: 10 },
    { name: "lint guidance", command: corepack, args: ["pnpm", "exec", "eslint", ...guidanceFiles, "--max-warnings", "0"], timeoutMinutes: 5 },
    { name: "guidance tests", command: corepack, args: ["pnpm", "exec", "vitest", "run", "packages/drafts/src/guidance.test.ts"], timeoutMinutes: 5 },
    diffCheck,
  ],
  web: sourceProfile({
    buildFilters: ["@gitpm/web"],
    lintPaths: ["apps/web"],
    testScript: "test:web",
    webTypecheck: true,
  }),
  server: sourceProfile({
    buildFilters: ["@gitpm/server"],
    lintPaths: ["apps/server"],
    testScript: "test:server",
  }),
  cli: sourceProfile({
    buildFilters: ["@gitpm/cli"],
    lintPaths: ["apps/cli"],
    testScript: "test:cli",
  }),
  repository: sourceProfile({
    buildFilters: ["@gitpm/domain", "@gitpm/validation"],
    lintPaths: [
      "packages/contracts",
      "packages/domain",
      "packages/repository-format",
      "packages/shared",
      "packages/task-hierarchy",
      "packages/validation",
    ],
    testScript: "test:repository",
    extraSteps: [pnpmStep("schema contracts", ["schema:verify"], 5)],
  }),
  "planning-domain": sourceProfile({
    buildFilters: ["@gitpm/workload", "@gitpm/time-entries"],
    lintPaths: [
      "packages/calendar",
      "packages/scheduling",
      "packages/time-entries",
      "packages/workload",
    ],
    testScript: "test:planning-domain",
  }),
  workflow: sourceProfile({
    buildFilters: ["@gitpm/agent", "@gitpm/logging"],
    lintPaths: [
      "packages/agent",
      "packages/changes",
      "packages/drafts",
      "packages/git-client",
      "packages/gitlab",
      "packages/history",
      "packages/logging",
      "packages/publishing",
      "packages/security",
    ],
    testScript: "test:workflow",
    extraSteps: [
      { name: "security report", command: process.execPath, args: ["scripts/security-spike-report.mjs"], timeoutMinutes: 5 },
    ],
  }),
  export: sourceProfile({
    buildFilters: ["@gitpm/export"],
    lintPaths: ["packages/export"],
    testScript: "test:export",
  }),
  tooling: [
    pnpmStep("lint tooling", ["exec", "eslint", "scripts", "playwright.config.ts", "--max-warnings", "0"]),
    pnpmStep("tooling tests", ["test:tooling"]),
    pnpmStep("planning validators", ["planning:verify"], 5),
    diffCheck,
  ],
  "e2e-ui": [
    pnpmStep("build browser runtime", ["--filter", "@gitpm/server...", "--filter", "@gitpm/web...", "build"], 15),
    pnpmStep("UI browser tests", ["e2e:ui"], 20),
    diffCheck,
  ],
  "e2e-workflow": [
    pnpmStep("build browser runtime", ["--filter", "@gitpm/server...", "--filter", "@gitpm/web...", "build"], 15),
    pnpmStep("workflow browser tests", ["e2e:workflow"], 20),
    diffCheck,
  ],
  docs: [diffCheck],
};

const installStep = {
  name: "frozen install",
  command: corepack,
  args: ["pnpm", "install", "--frozen-lockfile"],
  timeoutMinutes: 15,
};

function positiveNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

export function formatDuration(milliseconds) {
  const totalSeconds = Math.round(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

export function parseArguments(arguments_) {
  let profile = "full";
  let install = false;
  let resume = false;
  let lowImpact = false;
  let reportPath;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--install") {
      install = true;
      continue;
    }
    if (argument === "--profile") {
      profile = arguments_[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (argument === "--resume") {
      resume = true;
      continue;
    }
    if (argument === "--low-impact") {
      lowImpact = true;
      continue;
    }
    if (argument === "--report") {
      reportPath = arguments_[index + 1] ?? "";
      index += 1;
      if (!reportPath) throw new Error("Verification report path must not be empty");
      continue;
    }
    throw new Error(`Unknown verification option: ${argument}`);
  }
  if (!(profile in profiles)) throw new Error(`Unknown verification profile: ${profile}`);
  return { profile, install, resume, lowImpact, reportPath };
}

export function verificationPlan(options) {
  return [
    ...(options.install ? [installStep] : []),
    ...profiles[options.profile],
  ].map((step) => ({ ...step, args: [...step.args] }));
}

function displayCommand(step) {
  return [step.command, ...step.args].map((part) => /\s/u.test(part) ? JSON.stringify(part) : part).join(" ");
}

async function terminateProcessTree(child) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", resolve);
      killer.once("close", resolve);
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

async function runStep(step, position, total, settings) {
  const startedAt = Date.now();
  const resourceStart = systemSample();
  const timeoutMinutes = positiveNumber(
    process.env.GITPM_VERIFY_TIMEOUT_MINUTES,
    step.timeoutMinutes,
    1,
    180,
  );
  console.log(`\n[verify] START ${position}/${total} ${step.name}`);
  console.log(`[verify] command: ${displayCommand(step)}`);
  console.log(`[verify] timeout: ${timeoutMinutes}m`);

  const child = spawn(step.command, step.args, {
    cwd: process.cwd(),
    detached: process.platform !== "win32",
    env: settings.environment,
    shell: process.platform === "win32" && step.command.endsWith(".cmd"),
    stdio: "inherit",
    windowsHide: true,
  });
  settings.onChild(child);
  console.log(`[verify] pid: ${child.pid ?? "not-started"}`);

  let timedOut = false;
  const heartbeat = setInterval(() => {
    console.log(`[verify] RUNNING ${step.name}; pid=${child.pid ?? "unknown"}; elapsed=${formatDuration(Date.now() - startedAt)}`);
  }, settings.heartbeatMilliseconds);
  heartbeat.unref();

  const timeout = setTimeout(() => {
    timedOut = true;
    console.error(`[verify] TIMEOUT ${step.name} after ${formatDuration(Date.now() - startedAt)}; terminating pid=${child.pid ?? "unknown"}`);
    void terminateProcessTree(child);
  }, timeoutMinutes * 60_000);
  timeout.unref();

  const result = await new Promise((resolve) => {
    child.once("error", (error) => resolve({ code: 1, error }));
    child.once("close", (code, signal) => resolve({ code: code ?? 1, signal }));
  });
  settings.onChild(undefined);
  clearInterval(heartbeat);
  clearTimeout(timeout);
  const durationMilliseconds = Date.now() - startedAt;

  if (result.error) console.error(`[verify] ERROR ${step.name}: ${result.error.message}`);
  if (timedOut) result.code = 124;
  if (result.code === 0) {
    console.log(`[verify] PASS ${step.name} in ${formatDuration(durationMilliseconds)}`);
  } else {
    console.error(`[verify] FAIL ${step.name} in ${formatDuration(durationMilliseconds)}; exit=${result.code}${result.signal ? `; signal=${result.signal}` : ""}`);
  }
  return {
    name: step.name,
    command: displayCommand(step),
    status: result.code === 0 ? "passed" : "failed",
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMilliseconds,
    code: result.code,
    system: systemDelta(resourceStart, systemSample()),
  };
}

function printSummary(results, totalStartedAt) {
  console.log("\n[verify] SUMMARY");
  for (const result of results) {
    console.log(`[verify] ${result.cached ? "CACHED" : result.code === 0 ? "PASS" : "FAIL"} ${result.name}: ${formatDuration(result.durationMilliseconds)}`);
  }
  console.log(`[verify] TOTAL ${formatDuration(Date.now() - totalStartedAt)}`);
}

function systemSample() {
  const cpus = os.cpus();
  return {
    cpuIdle: cpus.reduce((total, cpu) => total + cpu.times.idle, 0),
    cpuTotal: cpus.reduce((total, cpu) => total + Object.values(cpu.times).reduce((sum, value) => sum + value, 0), 0),
    freeMemoryBytes: os.freemem(),
  };
}

function systemDelta(start, end) {
  const total = end.cpuTotal - start.cpuTotal;
  const idle = end.cpuIdle - start.cpuIdle;
  return {
    averageCpuPercent: total > 0 ? Math.round((1 - idle / total) * 1000) / 10 : 0,
    freeMemoryBytesAtStart: start.freeMemoryBytes,
    freeMemoryBytesAtEnd: end.freeMemoryBytes,
  };
}

async function workspaceSnapshot() {
  const { stdout } = await execFileAsync(git, ["ls-files", "-co", "--exclude-standard", "-z"], {
    cwd: process.cwd(),
    encoding: "buffer",
    maxBuffer: 32 * 1024 * 1024,
  });
  const files = {};
  for (const relativePath of stdout.toString("utf8").split("\0").filter(Boolean).sort()) {
    try {
      const fileStat = await stat(path.resolve(relativePath));
      if (!fileStat.isFile()) continue;
      const contents = await readFile(path.resolve(relativePath));
      files[relativePath.replaceAll("\\", "/")] = createHash("sha256").update(contents).digest("hex");
    } catch (error) {
      if (!(error instanceof Error) || !Reflect.has(error, "code") || error.code !== "ENOENT") throw error;
    }
  }
  const fingerprint = createHash("sha256");
  for (const [file, digest] of Object.entries(files)) fingerprint.update(`${file}\0${digest}\0`);
  return { fingerprint: fingerprint.digest("hex"), files };
}

function changedSnapshotPaths(previous, current) {
  const names = new Set([...Object.keys(previous?.files ?? {}), ...Object.keys(current.files)]);
  return [...names].filter((name) => previous?.files?.[name] !== current.files[name]).sort();
}

function safeProfileName(profile) {
  return profile.replaceAll(/[^a-z0-9-]/giu, "-");
}

function defaultReportPath(profile) {
  const timestamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  return path.resolve(".tmp", "verification-reports", `${timestamp}-${safeProfileName(profile)}.json`);
}

function checkpointPath(profile) {
  return path.resolve(".tmp", "verification-checkpoints", `${safeProfileName(profile)}.json`);
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error instanceof Error && Reflect.has(error, "code") && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file).catch(async () => {
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await unlink(temporary).catch(() => undefined);
  });
}

function cachedResult(step, previous) {
  return {
    name: step.name,
    command: displayCommand(step),
    status: "passed",
    cached: true,
    cachedFrom: previous.finishedAt,
    durationMilliseconds: 0,
    code: 0,
  };
}

export async function runVerification(options) {
  const plan = verificationPlan(options);
  const heartbeatSeconds = positiveNumber(
    process.env.GITPM_VERIFY_HEARTBEAT_SECONDS,
    30,
    5,
    300,
  );
  const settings = {
    heartbeatMilliseconds: heartbeatSeconds * 1000,
    environment: {
      ...process.env,
      ...(options.lowImpact && !process.env.GITPM_TEST_WORKERS ? { GITPM_TEST_WORKERS: "2" } : {}),
      ...(options.lowImpact && !process.env.GITPM_E2E_WORKERS ? { GITPM_E2E_WORKERS: "1" } : {}),
    },
    onChild: (child) => {
      activeChild = child;
    },
  };
  const results = [];
  const totalStartedAt = Date.now();
  const snapshot = await workspaceSnapshot();
  const checkpointFile = checkpointPath(options.profile);
  const previousReport = options.resume ? await readJson(checkpointFile) : undefined;
  const changedPaths = previousReport ? changedSnapshotPaths(previousReport.snapshot, snapshot) : [];
  const reportFile = options.reportPath ? path.resolve(options.reportPath) : defaultReportPath(options.profile);
  const report = {
    schema: "gitpm-verification-report@1",
    profile: options.profile,
    result: "running",
    startedAt: new Date(totalStartedAt).toISOString(),
    finishedAt: undefined,
    durationMilliseconds: undefined,
    options: { install: options.install, resume: options.resume, lowImpact: options.lowImpact },
    environment: {
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      logicalCpus: os.availableParallelism(),
      totalMemoryBytes: os.totalmem(),
      testWorkers: settings.environment.GITPM_TEST_WORKERS ?? "default",
      e2eWorkers: settings.environment.GITPM_E2E_WORKERS ?? "default",
    },
    snapshot,
    changedPathsSinceCheckpoint: changedPaths,
    steps: results,
  };
  let activeChild;

  const stop = async (signal) => {
    console.error(`\n[verify] received ${signal}; terminating the active process tree`);
    if (activeChild) await terminateProcessTree(activeChild);
    process.exitCode = 130;
  };
  const onSigInt = () => { void stop("SIGINT"); };
  const onSigTerm = () => { void stop("SIGTERM"); };
  process.once("SIGINT", onSigInt);
  process.once("SIGTERM", onSigTerm);

  try {
    console.log(`[verify] profile=${options.profile}; steps=${plan.length}; heartbeat=${heartbeatSeconds}s; low-impact=${options.lowImpact}`);
    console.log(`[verify] report=${reportFile}`);
    if (options.resume && !previousReport) console.log(`[verify] no checkpoint found at ${checkpointFile}; running the complete plan`);
    if (previousReport) console.log(`[verify] resuming checkpoint; changed paths=${changedPaths.length}`);
    await writeJson(reportFile, report);
    for (let index = 0; index < plan.length; index += 1) {
      const step = plan[index];
      const previous = previousReport?.steps?.find((candidate) => candidate.name === step.name && candidate.status === "passed");
      if (previous && !stepAffectedByPaths(step.name, changedPaths)) {
        const result = cachedResult(step, previous);
        results.push(result);
        console.log(`\n[verify] CACHED ${index + 1}/${plan.length} ${step.name}; unchanged since ${previous.finishedAt}`);
        await writeJson(reportFile, report);
        continue;
      }
      const result = await runStep(step, index + 1, plan.length, settings);
      results.push(result);
      await writeJson(reportFile, report);
      if (result.code !== 0) break;
    }
  } finally {
    activeChild = undefined;
    process.removeListener("SIGINT", onSigInt);
    process.removeListener("SIGTERM", onSigTerm);
    report.finishedAt = new Date().toISOString();
    report.durationMilliseconds = Date.now() - totalStartedAt;
    report.result = results.length === plan.length && results.every((result) => result.code === 0) ? "passed" : "failed";
    await writeJson(reportFile, report);
    await writeJson(checkpointFile, report);
    printSummary(results, totalStartedAt);
    console.log(`[verify] REPORT ${reportFile}`);
  }
  return results.at(-1)?.code ?? 1;
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    process.exitCode = await runVerification(options);
  } catch (error) {
    console.error(`[verify] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
