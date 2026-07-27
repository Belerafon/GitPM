import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

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

const profiles = {
  full: fullSteps,
  guidance: [
    { name: "build guidance dependencies", command: corepack, args: ["pnpm", "--filter", "@gitpm/drafts...", "build"], timeoutMinutes: 10 },
    { name: "lint guidance", command: corepack, args: ["pnpm", "exec", "eslint", ...guidanceFiles, "--max-warnings", "0"], timeoutMinutes: 5 },
    { name: "guidance tests", command: corepack, args: ["pnpm", "exec", "vitest", "run", "packages/drafts/src/guidance.test.ts"], timeoutMinutes: 5 },
    { name: "diff whitespace", command: git, args: ["diff", "--check"], timeoutMinutes: 2 },
  ],
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
    throw new Error(`Unknown verification option: ${argument}`);
  }
  if (!(profile in profiles)) throw new Error(`Unknown verification profile: ${profile}`);
  return { profile, install };
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
    env: process.env,
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
  return { name: step.name, durationMilliseconds, code: result.code };
}

function printSummary(results, totalStartedAt) {
  console.log("\n[verify] SUMMARY");
  for (const result of results) {
    console.log(`[verify] ${result.code === 0 ? "PASS" : "FAIL"} ${result.name}: ${formatDuration(result.durationMilliseconds)}`);
  }
  console.log(`[verify] TOTAL ${formatDuration(Date.now() - totalStartedAt)}`);
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
    onChild: (child) => {
      activeChild = child;
    },
  };
  const results = [];
  const totalStartedAt = Date.now();
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
    console.log(`[verify] profile=${options.profile}; steps=${plan.length}; heartbeat=${heartbeatSeconds}s`);
    for (let index = 0; index < plan.length; index += 1) {
      const result = await runStep(plan[index], index + 1, plan.length, settings);
      results.push(result);
      if (result.code !== 0) break;
    }
  } finally {
    activeChild = undefined;
    process.removeListener("SIGINT", onSigInt);
    process.removeListener("SIGTERM", onSigTerm);
    printSummary(results, totalStartedAt);
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
