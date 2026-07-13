#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ChangesService } from "../packages/changes/dist/index.js";
import { GitClient } from "../packages/git-client/dist/index.js";
import { validateRepository } from "../packages/validation/dist/index.js";
import { taskRelativePath } from "./generate-performance-fixture.mjs";

const [scenario, fixtureRoot, dataRoot] = process.argv.slice(2);
if (!scenario || !fixtureRoot || !dataRoot) throw new Error("usage: performance-scenario.mjs <cold|mutation|semantic> <fixture> <data>");
const root = path.resolve(fixtureRoot);
const data = path.resolve(dataRoot);
const now = () => performance.now();
const rssMiB = () => process.memoryUsage().rss / 1024 / 1024;

async function cold() {
  const started = now();
  const report = await validateRepository(root);
  const duration_ms = now() - started;
  if (!report.valid) throw new Error(`generated fixture is invalid: ${report.errors[0]?.code ?? "unknown"}`);
  return { scenario, duration_ms, rss_mib: rssMiB(), document_count: report.documentCount };
}

async function mutation() {
  await validateRepository(root);
  const target = path.join(root, ...taskRelativePath(150).split("/"));
  const original = await readFile(target, "utf8");
  const updated = original.replace("title: Task 0150", "title: Task 0150 updated");
  const started = now();
  await writeFile(target, updated, "utf8");
  const report = await validateRepository(root);
  const duration_ms = now() - started;
  await writeFile(target, original, "utf8");
  if (!report.valid) throw new Error(`mutation validation failed: ${report.errors[0]?.code ?? "unknown"}`);
  return { scenario, duration_ms, rss_mib: rssMiB(), document_count: report.documentCount };
}

async function semantic() {
  const git = new GitClient({ dataDirectory: data, remoteUrl: root, defaultBranch: "main", allowLocalTestRemote: true });
  const drafts = { getDraft: async () => ({ worktree_path: root }) };
  const changes = new ChangesService(drafts, git);
  const started = now();
  const report = await changes.semantic("DRF-PERFORMANCE");
  const duration_ms = now() - started;
  if (report.counts.updated !== 100) throw new Error(`expected 100 semantic updates, received ${report.counts.updated}`);
  return { scenario, duration_ms, rss_mib: rssMiB(), modified_files: report.counts.updated };
}

const operation = scenario === "cold" ? cold : scenario === "mutation" ? mutation : scenario === "semantic" ? semantic : undefined;
if (!operation) throw new Error(`unknown scenario: ${scenario}`);
console.log(JSON.stringify(await operation()));
