import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { GITPM_VERSION } from "@gitpm/shared";
import { formatYamlText, parseYamlDocument, RepositoryFormatError } from "@gitpm/repository-format";
import { validateRepository } from "@gitpm/validation";
import { atomicWriteDomainFile } from "@gitpm/security";
import type { AgentScope, AgentScopeReport, AgentWorkflow } from "@gitpm/agent";

export interface CliResult {
  readonly exitCode: number;
  readonly output: string;
}

interface CommonOptions {
  readonly json: boolean;
  readonly root: string;
  readonly rest: readonly string[];
}

type CliAgent = Pick<AgentWorkflow, "assertScope" | "commitAll" | "createDraft" | "createMergeRequest" | "openDraft" | "push" | "semanticDiff" | "setWriterMode" | "status">
  & Partial<Pick<AgentWorkflow, "createEntity">>;

export interface CliDependencies { readonly agent?: CliAgent }

function flagValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1];
}

function agentScope(args: readonly string[]): AgentScope {
  const allowedProject = flagValue(args, "--project");
  return { ...(allowedProject === undefined ? {} : { allowedProject }), ...(args.includes("--allow-delete") ? { allowDelete: true } : {}) };
}

function options(args: readonly string[], cwd: string): CommonOptions {
  const rest: string[] = [];
  let root = cwd;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") json = true;
    else if (argument === "--root") {
      const value = args[index + 1];
      if (!value) throw new RepositoryFormatError("CLI_USAGE", "--root requires a path");
      root = path.resolve(cwd, value);
      index += 1;
    } else if (argument !== undefined) rest.push(argument);
  }
  return { json, root, rest };
}

function render(json: boolean, payload: Record<string, unknown>, human: string): string {
  return json ? JSON.stringify(payload, null, 2) : human;
}

async function yamlFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.name.endsWith(".yaml")) result.push(absolute);
    }
  };
  await walk(root);
  return result.sort();
}

async function runFormat(args: readonly string[], cwd: string, scoped?: AgentScopeReport): Promise<CliResult> {
  const parsed = options(args, cwd);
  const check = parsed.rest.includes("--check");
  const changed: string[] = [];
  const allowed = scoped === undefined ? undefined : new Set(scoped.changed_files.filter((file) => file.kind !== "Deleted").map((file) => file.path));
  for (const absolute of await yamlFiles(parsed.root)) {
    const relative = path.relative(parsed.root, absolute).split(path.sep).join("/");
    if (allowed !== undefined && !allowed.has(relative)) continue;
    const original = await readFile(absolute, "utf8");
    const formatted = formatYamlText(original, relative);
    if (formatted !== original) {
      changed.push(relative);
      if (!check) await atomicWriteDomainFile(parsed.root, relative, formatted);
    }
  }
  const ok = !check || changed.length === 0;
  const code = ok ? "OK" : "FORMAT_REQUIRED";
  return {
    exitCode: ok ? 0 : 1,
    output: render(parsed.json, { ok, code, changed_files: changed }, ok ? `Formatted ${changed.length} file(s)` : `${changed.length} file(s) require formatting`),
  };
}

async function runValidate(args: readonly string[], cwd: string): Promise<CliResult> {
  const parsed = options(args, cwd);
  const changedRequested = parsed.rest.includes("--changed");
  const report = await validateRepository(parsed.root);
  const payload = {
    ok: report.valid,
    code: report.valid ? "OK" : "VALIDATION_FAILED",
    scope: changedRequested ? "changed-with-reference-closure" : "repository",
    ...report,
  };
  return {
    exitCode: report.valid ? 0 : 1,
    output: render(parsed.json, payload, report.valid
      ? `Repository is valid (${report.documentCount} documents, ${report.warnings.length} warnings)`
      : `Repository is invalid (${report.errors.length} errors, ${report.warnings.length} warnings)`),
  };
}

async function runSemanticDiff(args: readonly string[], cwd: string): Promise<CliResult> {
  const parsed = options(args, cwd);
  if (!parsed.rest.includes("--semantic")) {
    return { exitCode: 2, output: render(parsed.json, { ok: false, code: "CLI_USAGE" }, "diff requires --semantic") };
  }
  const report = await validateRepository(parsed.root);
  const payload = {
    ok: report.valid,
    code: report.valid ? "OK" : "VALIDATION_FAILED",
    created: [],
    updated: [],
    archived: [],
    deleted: [],
    changed_files_count: 0,
    affected_projects: [],
    validation: report,
    note: "Git before/after population is introduced with draft Git integration",
  };
  return { exitCode: report.valid ? 0 : 1, output: render(parsed.json, payload, "Semantic diff: 0 changed files") };
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new RepositoryFormatError("CLI_USAGE", `${name} is required`); return value;
}

function requireAgent(dependencies: CliDependencies): NonNullable<CliDependencies["agent"]> {
  if (!dependencies.agent) throw new RepositoryFormatError("CLI_AGENT_CONFIGURATION_REQUIRED", "Agent runtime configuration is unavailable");
  return dependencies.agent;
}

async function draftRoot(args: readonly string[], dependencies: CliDependencies): Promise<{ draftId: string; root: string; scope: AgentScopeReport }> {
  const agent = requireAgent(dependencies); const draftId = required(flagValue(args, "--draft"), "--draft");
  const metadata = await agent.status(draftId); const scope = await agent.assertScope(draftId, agentScope(args));
  return { draftId, root: metadata.worktree_path, scope };
}

async function runDraft(args: readonly string[], dependencies: CliDependencies): Promise<CliResult> {
  const agent = requireAgent(dependencies); const [action, mode] = args.filter((value, index) => index === 0 || !args[index - 1]?.startsWith("--"));
  const draftId = required(flagValue(args, "--draft"), "--draft"); const owner = flagValue(args, "--owner"); const json = args.includes("--json");
  let metadata;
  if (action === "create") metadata = await agent.createDraft(draftId, required(owner, "--owner"));
  else if (action === "open") metadata = await agent.openDraft(draftId, required(owner, "--owner"));
  else if (action === "status") metadata = await agent.status(draftId);
  else if (action === "set-writer") metadata = await agent.setWriterMode(draftId, required(owner, "--owner"), mode === "ui" ? "ui" : mode === "external" ? "external" : (() => { throw new RepositoryFormatError("CLI_USAGE", "writer mode must be ui or external"); })());
  else throw new RepositoryFormatError("CLI_USAGE", "draft requires create, open, status or set-writer");
  return { exitCode: 0, output: render(json, { ok: true, code: "OK", draft: metadata }, `Draft ${metadata.draft_id}: ${metadata.writer_mode} (${metadata.state})\n${metadata.worktree_path}`) };
}

async function runCommit(args: readonly string[], dependencies: CliDependencies): Promise<CliResult> {
  if (!args.includes("--all")) throw new RepositoryFormatError("CLI_USAGE", "commit requires --all");
  const agent = requireAgent(dependencies); const draftId = required(flagValue(args, "--draft"), "--draft"); const message = required(flagValue(args, "-m") ?? flagValue(args, "--message"), "-m");
  const result = await agent.commitAll(draftId, message, agentScope(args));
  return { exitCode: 0, output: render(args.includes("--json"), { ok: true, code: "OK", ...result }, `Committed all changes: ${result.commit}`) };
}

async function runEntity(args: readonly string[], cwd: string, dependencies: CliDependencies): Promise<CliResult> {
  if (args[0] !== "create") throw new RepositoryFormatError("CLI_USAGE", "entity requires create");
  const draftId = required(flagValue(args, "--draft"), "--draft");
  const file = required(flagValue(args, "--file"), "--file");
  const agent = requireAgent(dependencies);
  if (agent.createEntity === undefined) throw new RepositoryFormatError("CLI_AGENT_CONFIGURATION_REQUIRED", "Entity creation is unavailable");
  const source = path.resolve(cwd, file);
  const document = parseYamlDocument(await readFile(source, "utf8"), source);
  const created = await agent.createEntity(draftId, document, agentScope(args));
  return {
    exitCode: 0,
    output: render(args.includes("--json"), { ok: true, code: "OK", ...created }, `Created ${created.path}`),
  };
}

async function runPush(args: readonly string[], dependencies: CliDependencies): Promise<CliResult> {
  const result = await requireAgent(dependencies).push(required(flagValue(args, "--draft"), "--draft"));
  return { exitCode: 0, output: render(args.includes("--json"), { ok: true, code: "OK", ...result }, `Pushed ${result.branch} at ${result.commit}`) };
}

async function runMr(args: readonly string[], dependencies: CliDependencies): Promise<CliResult> {
  if (args[0] !== "create") throw new RepositoryFormatError("CLI_USAGE", "mr requires create");
  const draftId = required(flagValue(args, "--draft"), "--draft"); const owner = required(flagValue(args, "--owner"), "--owner"); const title = required(flagValue(args, "--title"), "--title");
  const result = await requireAgent(dependencies).createMergeRequest(draftId, owner, title, flagValue(args, "--description"));
  return { exitCode: 0, output: render(args.includes("--json"), { ok: true, code: "OK", merge_request: result }, `Created Merge Request !${result.iid}: ${result.web_url}`) };
}

async function runDoctor(args: readonly string[], cwd: string): Promise<CliResult> {
  const parsed = options(args, cwd);
  const report = await validateRepository(parsed.root);
  const nodeSupported = /^v20\./u.test(process.version);
  const checks = {
    node_20: nodeSupported,
    repository_valid: report.valid,
    schemas_loaded: report.documentCount > 0,
  };
  const ok = Object.values(checks).every(Boolean);
  return {
    exitCode: ok ? 0 : 1,
    output: render(parsed.json, { ok, code: ok ? "OK" : "DOCTOR_FAILED", checks, validation: report }, ok ? "Doctor checks passed" : "Doctor checks failed"),
  };
}

export async function run(args: readonly string[], cwd = process.cwd(), dependencies: CliDependencies = {}): Promise<CliResult> {
  if (args.includes("--version") || args.includes("-v")) return { exitCode: 0, output: GITPM_VERSION };
  const [command, ...commandArgs] = args;
  try {
    if (command === "draft") return await runDraft(commandArgs, dependencies);
    if (command === "entity") return await runEntity(commandArgs, cwd, dependencies);
    if (command === "format" && commandArgs.includes("--draft")) { const context = await draftRoot(commandArgs, dependencies); return await runFormat([...commandArgs, "--root", context.root], cwd, context.scope); }
    if (command === "format") return await runFormat(commandArgs, cwd);
    if (command === "validate" && commandArgs.includes("--draft")) { const context = await draftRoot(commandArgs, dependencies); return await runValidate([...commandArgs, "--root", context.root], cwd); }
    if (command === "validate") return await runValidate(commandArgs, cwd);
    if (command === "diff" && commandArgs.includes("--draft")) { const agent = requireAgent(dependencies); const draftId = required(flagValue(commandArgs, "--draft"), "--draft"); const report = await agent.semanticDiff(draftId, agentScope(commandArgs)); return { exitCode: 0, output: render(commandArgs.includes("--json"), { ok: true, code: "OK", ...report }, `Semantic diff: ${report.counts.created + report.counts.updated + report.counts.archived + report.counts.deleted} changed entities`) }; }
    if (command === "diff") return await runSemanticDiff(commandArgs, cwd);
    if (command === "commit") return await runCommit(commandArgs, dependencies);
    if (command === "push") return await runPush(commandArgs, dependencies);
    if (command === "mr") return await runMr(commandArgs, dependencies);
    if (command === "doctor") return await runDoctor(commandArgs, cwd);
    const json = args.includes("--json");
    return {
      exitCode: 2,
      output: render(json, { ok: false, code: "CLI_USAGE" }, "Usage: gitpm <draft|entity create|format|validate|diff --semantic|commit --all|push|mr create|doctor> [options]"),
    };
  } catch (error) {
    const code = error instanceof RepositoryFormatError || (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") ? error.code : "CLI_INTERNAL";
    const message = error instanceof Error ? error.message : String(error);
    const details = typeof error === "object" && error !== null && "details" in error ? error.details : undefined;
    return { exitCode: 1, output: JSON.stringify({ ok: false, code, message, ...(details === undefined ? {} : { details }) }, null, 2) };
  }
}
