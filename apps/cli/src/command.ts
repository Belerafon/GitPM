import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { GITPM_VERSION } from "@gitpm/shared";
import { formatYamlText, RepositoryFormatError } from "@gitpm/repository-format";
import { validateRepository } from "@gitpm/validation";
import { atomicWriteDomainFile } from "@gitpm/security";

export interface CliResult {
  readonly exitCode: number;
  readonly output: string;
}

interface CommonOptions {
  readonly json: boolean;
  readonly root: string;
  readonly rest: readonly string[];
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

async function runFormat(args: readonly string[], cwd: string): Promise<CliResult> {
  const parsed = options(args, cwd);
  const check = parsed.rest.includes("--check");
  const changed: string[] = [];
  for (const absolute of await yamlFiles(parsed.root)) {
    const relative = path.relative(parsed.root, absolute).split(path.sep).join("/");
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

export async function run(args: readonly string[], cwd = process.cwd()): Promise<CliResult> {
  if (args.includes("--version") || args.includes("-v")) return { exitCode: 0, output: GITPM_VERSION };
  const [command, ...commandArgs] = args;
  try {
    if (command === "format") return await runFormat(commandArgs, cwd);
    if (command === "validate") return await runValidate(commandArgs, cwd);
    if (command === "diff") return await runSemanticDiff(commandArgs, cwd);
    if (command === "doctor") return await runDoctor(commandArgs, cwd);
    const json = args.includes("--json");
    return {
      exitCode: 2,
      output: render(json, { ok: false, code: "CLI_USAGE" }, "Usage: gitpm <format|validate|diff --semantic|doctor> [--root PATH] [--json]"),
    };
  } catch (error) {
    const code = error instanceof RepositoryFormatError ? error.code : "CLI_INTERNAL";
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, output: JSON.stringify({ ok: false, code, message }, null, 2) };
  }
}
