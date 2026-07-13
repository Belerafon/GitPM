#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generatePerformanceFixture, taskRelativePath } from "./generate-performance-fixture.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "gitpm-p13b-"));
const fixtureRoot = path.join(temporaryRoot, "fixture");
const runs = 3;
const budgets = { cold: 5000, mutation: 1000, semantic: 3000, rss_mib: 512 };
const median = (values) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];

function git(...args) {
  return execFileSync("git", args, { cwd: fixtureRoot, encoding: "utf8", windowsHide: true }).trim();
}

function runScenario(scenario, index) {
  const data = path.join(temporaryRoot, `runtime-${scenario}-${index}`);
  const result = spawnSync(process.execPath, [path.join(ROOT, "scripts", "performance-scenario.mjs"), scenario, fixtureRoot, data], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`${scenario} run ${index} failed: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1));
}

try {
  await mkdir(fixtureRoot);
  const fixture = await generatePerformanceFixture(fixtureRoot);
  git("init", "-b", "main");
  git("add", ".");
  git("-c", "user.name=GitPM Performance", "-c", "user.email=performance@example.test", "commit", "-m", "performance fixture");
  for (let index = 1; index <= 100; index += 1) {
    const target = path.join(fixtureRoot, ...taskRelativePath(index).split("/"));
    const original = await readFile(target, "utf8");
    await writeFile(target, original.replace(`title: Task ${String(index).padStart(4, "0")}`, `title: Task ${String(index).padStart(4, "0")} modified`), "utf8");
  }

  const measurements = { cold: [], mutation: [], semantic: [] };
  for (const scenario of Object.keys(measurements)) {
    for (let index = 1; index <= runs; index += 1) measurements[scenario].push(runScenario(scenario, index));
  }
  const medians = {
    cold_ms: median(measurements.cold.map((item) => item.duration_ms)),
    mutation_ms: median(measurements.mutation.map((item) => item.duration_ms)),
    semantic_ms: median(measurements.semantic.map((item) => item.duration_ms)),
    rss_mib: median(measurements.cold.map((item) => item.rss_mib)),
  };
  const checks = {
    cold: medians.cold_ms <= budgets.cold,
    mutation: medians.mutation_ms <= budgets.mutation,
    semantic: medians.semantic_ms <= budgets.semantic,
    rss: medians.rss_mib <= budgets.rss_mib,
  };
  const report = {
    fixture,
    runner: {
      platform: process.platform,
      arch: process.arch,
      cpu_count: os.cpus().length,
      total_memory_gib: os.totalmem() / 1024 / 1024 / 1024,
      node: process.version,
      git: git("--version"),
    },
    reference_profile: { platform: "linux", arch: "x64", cpu_count: 4, total_memory_gib: 8 },
    reference_profile_match: process.platform === "linux" && process.arch === "x64",
    runs_per_scenario: runs,
    budgets,
    measurements,
    medians,
    checks,
    passed: Object.values(checks).every(Boolean),
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
