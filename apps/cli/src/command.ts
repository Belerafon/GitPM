import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ENTITY_ID_PREFIX, GITPM_VERSION, newEntityId } from "@gitpm/shared";
import { formatYamlText, parseYamlDocument, parseYamlValue, referenceLabelsForDocuments, RepositoryFormatError } from "@gitpm/repository-format";
import { discoverRepositoryFiles, validateRepository } from "@gitpm/validation";
import { atomicWriteDomainFile } from "@gitpm/security";
import type { AgentScope, AgentScopeReport, AgentWorkflow } from "@gitpm/agent";
import type { DirectCliRuntime } from "./direct-runtime.js";
import { parseCsvEntities, parseEntityMapping, parseJsonLinesEntities, parseYamlEntities } from "./entity-input.js";

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
  & Partial<Pick<AgentWorkflow, "createEntity" | "createEntities" | "updateEntity" | "listEntities" | "getEntity" | "planDelete" | "deleteEntity" | "archiveEntity" | "moveTask">>;

export interface CliDependencies {
  readonly agent?: CliAgent;
  readonly direct?: DirectCliRuntime;
  readonly init?: {
    readonly now?: () => Date;
    readonly randomIndex?: () => number;
  };
}

function flagValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1];
}

function flagValues(args: readonly string[], name: string): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (value === undefined) throw new RepositoryFormatError("CLI_USAGE", `${name} requires a value`);
    values.push(value);
    index += 1;
  }
  return values;
}

function updateField(name: string, source: string): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(name)) throw new RepositoryFormatError("CLI_USAGE", `${source} field name is invalid`);
  return name;
}

async function entityUpdatePatch(args: readonly string[], cwd: string): Promise<Readonly<Record<string, unknown>>> {
  const file = flagValue(args, "--file") ?? flagValue(args, "--path");
  const result: Record<string, unknown> = file === undefined
    ? {}
    : { ...parseEntityMapping(await readFile(path.resolve(cwd, file), "utf8"), path.resolve(cwd, file)) };
  const inlineFields = new Set<string>();
  for (const assignment of flagValues(args, "--set")) {
    const separator = assignment.indexOf("=");
    if (separator <= 0) throw new RepositoryFormatError("CLI_USAGE", "--set requires field=value");
    const field = updateField(assignment.slice(0, separator), "--set");
    if (inlineFields.has(field)) throw new RepositoryFormatError("CLI_USAGE", `Field ${field} is specified more than once`);
    inlineFields.add(field);
    const value = assignment.slice(separator + 1);
    result[field] = value === "" ? "" : parseYamlValue(value, `--set ${field}`);
  }
  for (const rawField of flagValues(args, "--unset")) {
    const field = updateField(rawField, "--unset");
    if (inlineFields.has(field)) throw new RepositoryFormatError("CLI_USAGE", `Field ${field} is specified more than once`);
    inlineFields.add(field);
    result[field] = null;
  }
  if (file === undefined && inlineFields.size === 0) {
    throw new RepositoryFormatError("CLI_USAGE", "entity update requires --file, --set or --unset");
  }
  return result;
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

const SCHEMA_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../schemas/v1");
const ROOT_USAGE = "Usage: gitpm <init|status|draft|entity create|entity update|entity import|entity list|entity show|entity delete|entity archive|entity move|comment|config|schema|format|validate|diff --semantic|commit --all|push|mr create|doctor> [options]";

const commandHelp: Readonly<Record<string, string>> = {
  root: [
    ROOT_USAGE,
    "",
    "Run 'gitpm <command> --help' for command-specific help. All commands support --json.",
  ].join("\n"),
  entity: [
    "Usage:",
    "  gitpm entity create [--draft <id>] --file <yaml> [--type <type>] [--project <id>] [--json]",
    "  gitpm entity update [--draft <id>] --type <type> --id <entity-id> [--file <yaml-patch>] [--set <field>=<yaml-value>]... [--unset <field>]... [--project <id>] [--json]",
    "  gitpm entity import [--draft <id>] --type <type> --format <csv|yaml|jsonl> (--file <path>|--path <path>) [--dry-run] [--json]",
    "  gitpm entity list [--draft <id>] --type <type> [--project <id>] [--json]",
    "  gitpm entity show [--draft <id>] --type <type> --id <entity-id> [--json]",
    "  gitpm entity delete [--draft <id>] --type <type> --id <entity-id> [--unlink-references] [--dry-run] [--allow-delete] [--project <id>] [--json]",
    "  gitpm entity archive [--draft <id>] --type <type> --id <entity-id> [--project <id>] [--json]",
    "  gitpm entity move [--draft <id>] --type task --id <entity-id> --to-project <id> [--to-milestone <id>] [--allow-delete] [--project <id>] [--json]",
    "",
    "create accepts a YAML mapping. schema, id and lifecycle may be omitted when --type is supplied.",
    "Person calendar may be omitted and is materialized from repository default_calendar.",
    "A supplied valid ID is preserved; otherwise GitPM generates <prefix>-<UTC YY>-<6 Crockford Base32>.",
    "update applies a YAML field patch from --file and/or repeatable --set/--unset options. Entity ID, schema and owning Project are immutable.",
    "import is atomic: the complete batch is validated once and rolled back on any error.",
    "list returns every entity of a type (optionally filtered by --project).",
    "show returns a single entity document with its canonical path.",
    "delete removes the entity file. Task deletion cascades to that task's comments.",
    "  --dry-run returns the reference impact (restrictions, cascade and unlink preview) without writing.",
    "  --unlink-references removes references to a person before deleting (people only; other types raise DELETE_UNLINK_UNSUPPORTED).",
    "  Restricted references raise DELETE_RESTRICTED with structured details listing every affected item.",
    "archive sets lifecycle to archived (reversible); the entity file stays and references remain valid.",
    "move relocates a task (and its comments) to another project and optional milestone.",
  ].join("\n"),
  schema: [
    "Usage:",
    "  gitpm schema list [--json]",
    "  gitpm schema show <type> [--example] [--json]",
  ].join("\n"),
  validate: "Usage: gitpm validate [--draft <id>] [--project <id>] [--changed] [--allow-delete] [--json]",
  format: "Usage: gitpm format [--draft <id>] [--project <id>] [--check] [--allow-delete] [--json]",
  diff: "Usage: gitpm diff --semantic [--draft <id>] [--project <id>] [--allow-delete] [--json]",
  commit: "Usage: gitpm commit --all [--draft <id>] -m <message> [--project <id>] [--allow-delete] [--json]",
  status: "Usage: gitpm status [--draft <id>] [--json]",
  draft: "Usage: gitpm draft create|open|status|set-writer --draft <id> [--owner <id>] [ui|external] [--json]",
  push: "Usage: gitpm push [--draft <id>] [--json]",
  mr: "Usage: gitpm mr create --draft <id> --owner <id> --title <title> [--description <text>] [--json]",
  init: "Usage: gitpm init [path] [--json]",
  doctor: "Usage: gitpm doctor [--json]",
  comment: [
    "Usage:",
    "  gitpm comment list --project <id> --task <id> [--json]",
    "  gitpm comment create --project <id> --task <id> (--body <text> | --file <path>) [--json]",
    "  gitpm comment update --project <id> --task <id> --id <comment-id> (--body <text> | --file <path>) [--json]",
    "  gitpm comment delete --project <id> --task <id> --id <comment-id> [--json]",
    "",
    "Comments support Markdown with @[Name](person:U-...) mentions.",
    "Delete is a soft-delete (tombstone remains in Git history). Available in direct mode.",
  ].join("\n"),
  config: [
    "Usage:",
    "  gitpm config show --kind statuses|issue-types [--json]",
    "  gitpm config update --kind statuses|issue-types [--file <yaml>] [--set <field>=<yaml-value>]... [--unset <field>] [--json]",
    "",
    "Reads or updates repository configuration documents in .gitpm/. Available in direct mode.",
  ].join("\n"),
};

interface CliArgumentSpec {
  readonly values?: readonly string[];
  readonly repeatable?: readonly string[];
  readonly booleans?: readonly string[];
  readonly minPositionals: number;
  readonly maxPositionals: number;
}

function commandArgumentSpec(command: string | undefined, args: readonly string[]): CliArgumentSpec | undefined {
  const action = args[0];
  if (command === "status") return { values: ["--draft"], booleans: ["--json"], minPositionals: 0, maxPositionals: 0 };
  if (command === "draft") return { values: ["--draft", "--owner"], booleans: ["--json"], minPositionals: 1, maxPositionals: action === "set-writer" ? 2 : 1 };
  if (command === "entity") {
    const common = ["--draft", "--type", "--schema"];
    if (action === "create") return { values: [...common, "--file", "--path", "--project"], booleans: ["--json"], minPositionals: 1, maxPositionals: 1 };
    if (action === "update") return { values: [...common, "--id", "--file", "--path", "--project"], repeatable: ["--set", "--unset"], booleans: ["--json"], minPositionals: 1, maxPositionals: 1 };
    if (action === "import" || action === "bulk-import") return { values: [...common, "--format", "--file", "--path", "--project"], booleans: ["--dry-run", "--json"], minPositionals: 1, maxPositionals: 1 };
    if (action === "list") return { values: [...common, "--project"], booleans: ["--json"], minPositionals: 1, maxPositionals: 1 };
    if (action === "show") return { values: [...common, "--id"], booleans: ["--json"], minPositionals: 1, maxPositionals: 1 };
    if (action === "delete") return { values: [...common, "--id", "--project"], booleans: ["--unlink-references", "--dry-run", "--allow-delete", "--json"], minPositionals: 1, maxPositionals: 1 };
    if (action === "archive") return { values: [...common, "--id", "--project"], booleans: ["--json"], minPositionals: 1, maxPositionals: 1 };
    if (action === "move") return { values: [...common, "--id", "--to-project", "--to-milestone", "--project"], booleans: ["--allow-delete", "--json"], minPositionals: 1, maxPositionals: 1 };
    return { booleans: ["--json"], minPositionals: 1, maxPositionals: 1 };
  }
  if (command === "schema") return action === "show"
    ? { booleans: ["--example", "--json"], minPositionals: 2, maxPositionals: 2 }
    : { booleans: ["--json"], minPositionals: 1, maxPositionals: 1 };
  if (command === "format") return { values: ["--root", "--draft", "--project"], booleans: ["--check", "--allow-delete", "--json"], minPositionals: 0, maxPositionals: 0 };
  if (command === "validate") return { values: ["--root", "--draft", "--project"], booleans: ["--changed", "--allow-delete", "--json"], minPositionals: 0, maxPositionals: 0 };
  if (command === "diff") return { values: ["--root", "--draft", "--project"], booleans: ["--semantic", "--allow-delete", "--json"], minPositionals: 0, maxPositionals: 0 };
  if (command === "commit") return { values: ["--draft", "-m", "--message", "--project"], booleans: ["--all", "--allow-delete", "--json"], minPositionals: 0, maxPositionals: 0 };
  if (command === "push") return { values: ["--draft"], booleans: ["--json"], minPositionals: 0, maxPositionals: 0 };
  if (command === "mr") return { values: ["--draft", "--owner", "--title", "--description"], booleans: ["--json"], minPositionals: 1, maxPositionals: 1 };
  if (command === "comment") return { values: ["--project", "--task", "--id", "--body", "--file", "--path"], booleans: ["--json"], minPositionals: 1, maxPositionals: 1 };
  if (command === "config") {
    return action === "update"
      ? { values: ["--kind", "--file", "--path"], repeatable: ["--set", "--unset"], booleans: ["--json"], minPositionals: 1, maxPositionals: 1 }
      : { values: ["--kind"], booleans: ["--json"], minPositionals: 1, maxPositionals: 1 };
  }
  if (command === "doctor") return { values: ["--root"], booleans: ["--json"], minPositionals: 0, maxPositionals: 0 };
  if (command === "init") return { booleans: ["--json"], minPositionals: 0, maxPositionals: 1 };
  return undefined;
}

function assertKnownArguments(command: string | undefined, args: readonly string[]): void {
  const spec = commandArgumentSpec(command, args);
  if (spec === undefined) return;
  const values = new Set(spec.values ?? []);
  const repeatable = new Set(spec.repeatable ?? []);
  const booleans = new Set(spec.booleans ?? []);
  const seen = new Set<string>();
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!argument.startsWith("-")) {
      positionals.push(argument);
      continue;
    }
    if (!values.has(argument) && !repeatable.has(argument) && !booleans.has(argument)) {
      throw new RepositoryFormatError("CLI_USAGE", `Unknown option for ${command ?? "command"}: ${argument}`);
    }
    if (!repeatable.has(argument) && seen.has(argument)) {
      throw new RepositoryFormatError("CLI_USAGE", `Option ${argument} may only be specified once`);
    }
    seen.add(argument);
    if (values.has(argument) || repeatable.has(argument)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) throw new RepositoryFormatError("CLI_USAGE", `${argument} requires a value`);
      index += 1;
    }
  }
  if (positionals.length < spec.minPositionals || positionals.length > spec.maxPositionals) {
    throw new RepositoryFormatError("CLI_USAGE", `Unexpected positional arguments for ${command ?? "command"}`);
  }
}

function requestedEntityType(args: readonly string[]): string | undefined {
  const value = flagValue(args, "--type") ?? flagValue(args, "--schema");
  if (value === undefined) return undefined;
  const match = /^gitpm\/(project|task|milestone|person|team|calendar|saved-view)@1$/u.exec(value);
  return match?.[1] ?? value;
}

async function versionPayload(): Promise<Record<string, unknown>> {
  const hash = createHash("sha256");
  for (const file of (await readdir(SCHEMA_DIRECTORY)).filter((entry) => entry.endsWith(".schema.json")).sort()) {
    hash.update(file).update("\0").update(await readFile(path.join(SCHEMA_DIRECTORY, file))).update("\0");
  }
  return {
    ok: true,
    code: "OK",
    version: GITPM_VERSION,
    repository_schema: 1,
    schema_digest: `sha256:${hash.digest("hex")}`,
    build_commit: process.env.GITPM_BUILD_COMMIT?.trim() || "unknown",
    node: process.versions.node,
  };
}

const schemaAliases: Readonly<Record<string, string>> = {
  project: "project", projects: "project", task: "task", tasks: "task",
  milestone: "milestone", milestones: "milestone", person: "person", people: "person",
  team: "team", teams: "team", calendar: "calendar", calendars: "calendar",
  view: "saved-view", views: "saved-view", "saved-view": "saved-view",
  comment: "comment", repository: "repository", statuses: "statuses", "issue-types": "issue-types",
};

const schemaExamples: Readonly<Record<string, string>> = {
  person: [
    "schema: gitpm/person@1", "id: U-26-7K4M9Q", "name: Ada Lovelace",
    "weekly_capacity_hours: 40", "calendar: C-26-QD7FJ4", "lifecycle: active",
    "email: ada@example.test", "",
  ].join("\n"),
  calendar: [
    "schema: gitpm/calendar@1", "id: C-26-QD7FJ4", "name: Standard work week",
    "working_weekdays: [1, 2, 3, 4, 5]", "holidays: []", "lifecycle: active", "",
  ].join("\n"),
};

async function runSchema(args: readonly string[]): Promise<CliResult> {
  const json = args.includes("--json");
  const action = args[0];
  const available = ["project", "task", "milestone", "person", "team", "calendar", "saved-view", "comment", "repository", "statuses", "issue-types"];
  if (action === "list") {
    return { exitCode: 0, output: render(json, { ok: true, code: "OK", schemas: available }, available.join("\n")) };
  }
  if (action !== "show") throw new RepositoryFormatError("CLI_USAGE", "schema requires list or show");
  const requested = args[1];
  const name = requested === undefined ? undefined : schemaAliases[requested];
  if (name === undefined) throw new RepositoryFormatError("SCHEMA_UNKNOWN", `Unknown schema ${requested ?? ""}`.trim());
  const schema = JSON.parse(await readFile(path.join(SCHEMA_DIRECTORY, `${name}.schema.json`), "utf8")) as Record<string, unknown>;
  const requiredFields = Array.isArray(schema.required) ? schema.required : [];
  const properties = schema.properties !== null && typeof schema.properties === "object" ? Object.keys(schema.properties as Record<string, unknown>) : [];
  const optionalFields = properties.filter((field) => !requiredFields.includes(field));
  const example = schemaExamples[name];
  if (args.includes("--example") && !json) {
    return { exitCode: 0, output: example ?? `No example is available for ${name}` };
  }
  const human = [
    `${name}: ${String(schema.$id ?? "")}`,
    `Required: ${requiredFields.join(", ") || "(none)"}`,
    `Optional: ${optionalFields.join(", ") || "(none)"}`,
    name === "person" ? "Create defaults: generated id, lifecycle=active, calendar=repository default_calendar" : "Create defaults: generated id, lifecycle=active",
    ...(example === undefined ? [] : ["", example.trimEnd()]),
  ].join("\n");
  return { exitCode: 0, output: render(json, { ok: true, code: "OK", name, required: requiredFields, optional: optionalFields, schema, ...(example === undefined ? {} : { example }) }, human) };
}

async function yamlFiles(root: string): Promise<string[]> {
  const discovery = await discoverRepositoryFiles(root);
  if (discovery.issues.length > 0) {
    const issue = discovery.issues[0]!;
    throw new RepositoryFormatError(issue.code, issue.message);
  }
  return [...discovery.files];
}

async function runFormat(args: readonly string[], cwd: string, scoped?: AgentScopeReport): Promise<CliResult> {
  const parsed = options(args, cwd);
  const check = parsed.rest.includes("--check");
  const changed: string[] = [];
  const allowed = scoped === undefined ? undefined : new Set(scoped.changed_files.filter((file) => file.kind !== "Deleted").map((file) => file.path));
  const sources = [];
  for (const absolute of await yamlFiles(parsed.root)) {
    const relative = path.relative(parsed.root, absolute).split(path.sep).join("/");
    const original = await readFile(absolute, "utf8");
    sources.push({ relative, original, document: parseYamlDocument(original, relative) });
  }
  const referenceLabels = referenceLabelsForDocuments(sources.map((source) => source.document));
  for (const { relative, original } of sources) {
    if (allowed !== undefined && !allowed.has(relative)) continue;
    const formatted = formatYamlText(original, relative, referenceLabels);
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
  throw new RepositoryFormatError(
    "CLI_DIRECT_CONFIGURATION_REQUIRED",
    `Semantic diff requires a configured direct checkout or worktree draft; standalone root ${parsed.root} supports format and validate only`,
  );
}
function required(value: string | undefined, name: string): string {
  if (!value) throw new RepositoryFormatError("CLI_USAGE", `${name} is required`); return value;
}

function requireAgent(dependencies: CliDependencies): NonNullable<CliDependencies["agent"]> {
  if (!dependencies.agent) throw new RepositoryFormatError("CLI_AGENT_CONFIGURATION_REQUIRED", "Agent runtime configuration is unavailable");
  return dependencies.agent;
}

function requireDirect(dependencies: CliDependencies): NonNullable<CliDependencies["direct"]> {
  if (!dependencies.direct) throw new RepositoryFormatError("CLI_DIRECT_CONFIGURATION_REQUIRED", "Direct runtime configuration is unavailable");
  return dependencies.direct;
}

async function runDirectStatus(args: readonly string[], dependencies: CliDependencies): Promise<CliResult> {
  const direct = requireDirect(dependencies);
  const status = await direct.status();
  const json = args.includes("--json");
  const human = [
    `Repository mode: ${status.mode}`,
    `Repository path: ${status.path}`,
    `Branch: ${status.branch}`,
    `HEAD: ${status.head}`,
    `Dirty: ${status.dirty ? "yes" : "no"}`,
    `Ahead: ${status.ahead}`,
    `Behind: ${status.behind}`,
    status.remote === undefined ? "Remote: (none)" : `Remote: ${status.remote}`,
  ].join("\n");
  return { exitCode: 0, output: render(json, { ok: true, code: "OK", status }, human) };
}

async function runDirectCommit(args: readonly string[], dependencies: CliDependencies): Promise<CliResult> {
  if (!args.includes("--all")) throw new RepositoryFormatError("CLI_USAGE", "commit requires --all");
  const direct = requireDirect(dependencies);
  const message = required(flagValue(args, "-m") ?? flagValue(args, "--message"), "-m");
  const result = await direct.commitAll(message, agentScope(args));
  return { exitCode: 0, output: render(args.includes("--json"), { ok: true, code: "OK", ...result }, `Committed all changes: ${result.commit} (${result.branch})`) };
}

async function runDirectPush(args: readonly string[], dependencies: CliDependencies): Promise<CliResult> {
  const direct = requireDirect(dependencies);
  const result = await direct.push();
  return { exitCode: 0, output: render(args.includes("--json"), { ok: true, code: "OK", ...result }, `Pushed ${result.branch} at ${result.commit}`) };
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

function entitySummary(document: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    id: typeof document.id === "string" ? document.id : undefined,
    schema: typeof document.schema === "string" ? document.schema : undefined,
    lifecycle: typeof document.lifecycle === "string" ? document.lifecycle : undefined,
  };
  if (typeof document.name === "string") summary.name = document.name;
  if (typeof document.title === "string") summary.title = document.title;
  return summary;
}

async function runEntity(args: readonly string[], cwd: string, dependencies: CliDependencies): Promise<CliResult> {
  const action = args[0] === "bulk-import" ? "import" : args[0];
  const validActions = ["create", "update", "import", "list", "show", "delete", "archive", "move"];
  if (typeof action !== "string" || !validActions.includes(action)) throw new RepositoryFormatError("CLI_USAGE", "entity requires create, update, import, list, show, delete, archive or move");
  const draftId = flagValue(args, "--draft");
  const agent = args.includes("--draft") ? requireAgent(dependencies) : undefined;
  if (agent !== undefined && action === "create" && agent.createEntity === undefined) throw new RepositoryFormatError("CLI_AGENT_CONFIGURATION_REQUIRED", "Entity creation is unavailable");
  if (agent !== undefined && action === "import" && agent.createEntities === undefined) throw new RepositoryFormatError("CLI_AGENT_CONFIGURATION_REQUIRED", "Atomic entity import is unavailable");
  if (agent !== undefined && action === "update" && agent.updateEntity === undefined) throw new RepositoryFormatError("CLI_AGENT_CONFIGURATION_REQUIRED", "Entity update is unavailable");
  if (agent !== undefined && action === "list" && agent.listEntities === undefined) throw new RepositoryFormatError("CLI_AGENT_CONFIGURATION_REQUIRED", "Entity list is unavailable");
  if (agent !== undefined && action === "show" && agent.getEntity === undefined) throw new RepositoryFormatError("CLI_AGENT_CONFIGURATION_REQUIRED", "Entity show is unavailable");
  if (agent !== undefined && action === "delete" && !args.includes("--dry-run") && agent.deleteEntity === undefined) throw new RepositoryFormatError("CLI_AGENT_CONFIGURATION_REQUIRED", "Entity delete is unavailable");
  if (agent !== undefined && (action === "delete" && args.includes("--dry-run")) && agent.planDelete === undefined) throw new RepositoryFormatError("CLI_AGENT_CONFIGURATION_REQUIRED", "Entity delete preview is unavailable");
  if (agent !== undefined && action === "archive" && agent.archiveEntity === undefined) throw new RepositoryFormatError("CLI_AGENT_CONFIGURATION_REQUIRED", "Entity archive is unavailable");
  if (agent !== undefined && action === "move" && agent.moveTask === undefined) throw new RepositoryFormatError("CLI_AGENT_CONFIGURATION_REQUIRED", "Entity move is unavailable");
  const direct = agent === undefined ? requireDirect(dependencies) : undefined;
  const entityType = requestedEntityType(args);
  const json = args.includes("--json");

  if (action === "list") {
    const requestedType = required(entityType, "--type");
    const project = flagValue(args, "--project");
    const result = agent?.listEntities === undefined
      ? await direct!.listEntities(requestedType, project === undefined ? undefined : project)
      : await agent.listEntities(required(draftId, "--draft"), requestedType, project === undefined ? undefined : project);
    const items = result.items.map((item) => ({ ...entitySummary(item.document), path: item.path }));
    return {
      exitCode: 0,
      output: render(json, { ok: true, code: "OK", items, draft_fingerprint: result.draft_fingerprint }, `${items.length} ${requestedType} entit${items.length === 1 ? "y" : "ies"}`),
    };
  }

  if (action === "show") {
    const requestedType = required(entityType, "--type");
    const requestedId = required(flagValue(args, "--id"), "--id");
    const result = agent?.getEntity === undefined
      ? await direct!.getEntity(requestedType, requestedId)
      : await agent.getEntity(required(draftId, "--draft"), requestedType, requestedId);
    return {
      exitCode: 0,
      output: render(json, { ok: true, code: "OK", document: result.document, path: result.path, draft_fingerprint: result.draft_fingerprint }, `${result.path}`),
    };
  }

  if (action === "delete") {
    const requestedType = required(entityType, "--type");
    const requestedId = required(flagValue(args, "--id"), "--id");
    const dryRun = args.includes("--dry-run");
    if (dryRun) {
      const plan = agent?.planDelete === undefined
        ? await direct!.planDelete(requestedType, requestedId)
        : await agent.planDelete(required(draftId, "--draft"), requestedType, requestedId);
      const restricted = plan.restrictions.length > 0 && !args.includes("--unlink-references");
      const human = restricted
        ? `Would be blocked by DELETE_RESTRICTED: ${plan.restrictions.length} reference(s)`
        : `Would delete ${plan.path}${plan.cascaded_comments.length > 0 ? ` and ${plan.cascaded_comments.length} comment(s)` : ""}${plan.supports_unlink && args.includes("--unlink-references") ? `, unlinking ${plan.would_unlink.length} reference(s)` : ""}`;
      return {
        exitCode: restricted ? 0 : 0,
        output: render(json, { ok: true, code: "OK", dry_run: true, ...plan, ...(restricted ? { would_be_restricted: true } : {}) }, human),
      };
    }
    const unlink = args.includes("--unlink-references");
    const deleted = agent?.deleteEntity === undefined
      ? await direct!.deleteEntity(requestedType, requestedId, unlink, agentScope(args))
      : await agent.deleteEntity(required(draftId, "--draft"), requestedType, requestedId, unlink, agentScope(args));
    const unlinked = deleted.unlinked_paths.length > 0 ? `, unlinked ${deleted.unlinked_paths.length} reference(s)` : "";
    return {
      exitCode: 0,
      output: render(json, { ok: true, code: "OK", ...deleted }, `Deleted ${deleted.path}${unlinked}`),
    };
  }

  if (action === "archive") {
    const requestedType = required(entityType, "--type");
    const requestedId = required(flagValue(args, "--id"), "--id");
    const archived = agent?.archiveEntity === undefined
      ? await direct!.archiveEntity(requestedType, requestedId, agentScope(args))
      : await agent.archiveEntity(required(draftId, "--draft"), requestedType, requestedId, agentScope(args));
    return {
      exitCode: 0,
      output: render(json, { ok: true, code: "OK", path: archived.path, draft_fingerprint: archived.draft_fingerprint, document: archived.document }, `Archived ${archived.path}`),
    };
  }

  if (action === "move") {
    const requestedType = required(entityType, "--type");
    if (requestedType !== "tasks" && requestedType !== "task") throw new RepositoryFormatError("CLI_USAGE", "entity move supports tasks only");
    const requestedId = required(flagValue(args, "--id"), "--id");
    const targetProject = required(flagValue(args, "--to-project"), "--to-project");
    const targetMilestone = flagValue(args, "--to-milestone");
    const moved = agent?.moveTask === undefined
      ? await direct!.moveTask(requestedId, targetProject, targetMilestone === undefined ? undefined : targetMilestone, agentScope(args))
      : await agent.moveTask(required(draftId, "--draft"), requestedId, targetProject, targetMilestone === undefined ? undefined : targetMilestone, agentScope(args));
    return {
      exitCode: 0,
      output: render(json, { ok: true, code: "OK", path: moved.path, draft_fingerprint: moved.draft_fingerprint, document: moved.document }, `Moved to ${moved.path}`),
    };
  }

  if (action === "update") {
    const requestedType = required(entityType, "--type");
    const requestedId = required(flagValue(args, "--id"), "--id");
    const patch = await entityUpdatePatch(args, cwd);
    const updated = agent?.updateEntity === undefined
      ? await direct!.updateEntity(patch, requestedType, requestedId, agentScope(args))
      : await agent.updateEntity(required(draftId, "--draft"), patch, requestedType, requestedId, agentScope(args));
    return {
      exitCode: 0,
      output: render(json, { ok: true, code: "OK", ...updated }, `Updated ${updated.path}`),
    };
  }
  const file = required(flagValue(args, "--file") ?? flagValue(args, "--path"), "--file or --path");
  const source = path.resolve(cwd, file);
  const text = await readFile(source, "utf8");
  if (action === "import") {
    const format = (flagValue(args, "--format") ?? path.extname(source).slice(1)).toLocaleLowerCase();
    const documents = format === "csv" ? parseCsvEntities(text, source)
      : ["yaml", "yml"].includes(format) ? parseYamlEntities(text, source)
        : ["jsonl", "ndjson"].includes(format) ? parseJsonLinesEntities(text, source)
          : (() => { throw new RepositoryFormatError("IMPORT_FORMAT_INVALID", "--format must be csv, yaml or jsonl"); })();
    const requestedType = required(entityType, "--type");
    const dryRun = args.includes("--dry-run");
    const rowOffset = format === "csv" ? 2 : 1;
    let imported;
    try {
      imported = agent === undefined
        ? await direct!.createEntities(documents, requestedType, agentScope(args), dryRun)
        : agent.createEntities === undefined
          ? (() => { throw new RepositoryFormatError("CLI_AGENT_CONFIGURATION_REQUIRED", "Atomic entity import is unavailable"); })()
          : await agent.createEntities(required(draftId, "--draft"), documents, requestedType, agentScope(args), dryRun);
    } catch (error) {
      if (error !== null && typeof error === "object" && "details" in error && Array.isArray(error.details)) {
        error.details = error.details.map((detail) => detail !== null && typeof detail === "object" && "source_index" in detail && typeof detail.source_index === "number"
          ? { ...detail, row: detail.source_index + rowOffset }
          : detail);
      }
      throw error;
    }
    const items = imported.items.map((item) => ({ ...item, row: item.source_index + rowOffset }));
    return {
      exitCode: 0,
      output: render(json, { ok: true, code: "OK", ...imported, items }, `${dryRun ? "Validated" : "Imported"} ${items.length} entities`),
    };
  }
  const document = parseEntityMapping(text, source);
  const created = agent?.createEntity === undefined
    ? await direct!.createEntity(document, agentScope(args), entityType)
    : await agent.createEntity(required(draftId, "--draft"), document, agentScope(args), entityType);
  return {
    exitCode: 0,
    output: render(json, { ok: true, code: "OK", ...created }, `Created ${created.path}`),
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

async function runComment(args: readonly string[], cwd: string, dependencies: CliDependencies): Promise<CliResult> {
  const action = args[0];
  const validActions = ["list", "create", "update", "delete"];
  if (typeof action !== "string" || !validActions.includes(action)) throw new RepositoryFormatError("CLI_USAGE", "comment requires list, create, update or delete");
  const direct = requireDirect(dependencies);
  const projectId = required(flagValue(args, "--project"), "--project");
  const taskId = required(flagValue(args, "--task"), "--task");
  const json = args.includes("--json");
  if (action === "list") {
    const result = await direct.listComments(projectId, taskId);
    const items = result.map((item) => ({ id: String(item.document.id), state: item.document.state, author: item.document.author.display_name, ...(typeof item.document.body_markdown === "string" ? { excerpt: item.document.body_markdown.slice(0, 120) } : {}), path: item.path }));
    return { exitCode: 0, output: render(json, { ok: true, code: "OK", items }, `${items.length} comment(s)`) };
  }
  if (action === "delete") {
    const commentId = required(flagValue(args, "--id"), "--id");
    const deleted = await direct.deleteComment(projectId, taskId, commentId);
    return { exitCode: 0, output: render(json, { ok: true, code: "OK", document: deleted.document, path: deleted.path }, `Deleted ${deleted.path}`) };
  }
  const commentId = action === "create" ? undefined : required(flagValue(args, "--id"), "--id");
  const bodyFile = flagValue(args, "--file") ?? flagValue(args, "--path");
  const bodyInline = flagValue(args, "--body");
  const body = bodyInline ?? (bodyFile === undefined ? undefined : await readFile(path.resolve(cwd, bodyFile), "utf8"));
  if (body === undefined) throw new RepositoryFormatError("CLI_USAGE", "comment requires --body or --file");
  if (action === "create") {
    const created = await direct.createComment(projectId, taskId, body);
    return { exitCode: 0, output: render(json, { ok: true, code: "OK", document: created.document, path: created.path }, `Created ${created.path}`) };
  }
  const updated = await direct.updateComment(projectId, taskId, commentId!, body);
  return { exitCode: 0, output: render(json, { ok: true, code: "OK", document: updated.document, path: updated.path }, `Updated ${updated.path}`) };
}

async function runConfig(args: readonly string[], cwd: string, dependencies: CliDependencies): Promise<CliResult> {
  const action = args[0];
  if (action !== "show" && action !== "update") throw new RepositoryFormatError("CLI_USAGE", "config requires show or update");
  const direct = requireDirect(dependencies);
  const kind = required(flagValue(args, "--kind"), "--kind");
  if (kind !== "statuses" && kind !== "issue-types") throw new RepositoryFormatError("CLI_USAGE", "--kind must be statuses or issue-types");
  const json = args.includes("--json");
  if (action === "show") {
    const result = await direct.getConfiguration(kind);
    return { exitCode: 0, output: render(json, { ok: true, code: "OK", document: result.document, path: result.path }, result.path) };
  }
  const current = await direct.getConfiguration(kind);
  const patch = await entityUpdatePatch(args, cwd);
  const next: Record<string, unknown> = { ...current.document };
  for (const [field, value] of Object.entries(patch)) {
    if (value === null) delete next[field];
    else next[field] = value;
  }
  next.schema = current.document.schema;
  const updated = await direct.updateConfiguration(kind, next);
  return { exitCode: 0, output: render(json, { ok: true, code: "OK", document: updated.document, path: updated.path }, `Updated ${updated.path}`) };
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

const execFileAsync = promisify(execFile);

const initRepositoryYaml = (calendarId: string) => `schema: gitpm/repository@1
default_branch: main
default_calendar: ${calendarId} # calendar: Standard work week
allowed_top_level_files:
  - README.md
  - .gitignore
  - .ignore
allowed_top_level_directories:
  - uploads
ui_poll_interval_seconds: 5
`;

const INIT_STATUSES_YAML = `schema: gitpm/statuses@1
statuses:
  - slug: backlog
    title: Backlog
    color: gray
    active: true
  - slug: in-progress
    title: In progress
    color: blue
    active: true
  - slug: done
    title: Done
    color: green
    active: true
`;

const INIT_ISSUE_TYPES_YAML = `schema: gitpm/issue-types@1
issue_types:
  - slug: task
    title: Task
    color: blue
    active: true
  - slug: bug
    title: Bug
    color: red
    active: true
`;

const initCalendarYaml = (calendarId: string) => `schema: gitpm/calendar@1
id: ${calendarId} # calendar: Standard work week
name: Standard work week
working_weekdays:
  - 1
  - 2
  - 3
  - 4
  - 5
holidays: []
lifecycle: active
`;

const INIT_README_MD = `# Project portfolio managed by GitPM

This repository was initialised by \`gitpm init\`. Use the GitPM web UI or CLI
to create projects, people, teams, calendars and tasks. See
https://github.com/Belerafon/GitPM for details.

Place local source documents in \`uploads/\`. Git ignores their contents; convert
them to temporary CLI input instead of committing them as GitPM business data.
`;

const INIT_GITIGNORE = `# User-supplied artefacts are local inputs, not GitPM business data.
/uploads/*
!/uploads/.gitkeep
`;

const INIT_IGNORE = `# Keep uploads searchable by ripgrep-based agent tools even though Git ignores them.
!uploads/
!uploads/**
`;

const INIT_KEEPERS = ["people", "teams", "projects"] as const;

async function directoryIsEmpty(directory: string): Promise<boolean> {
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      return false;
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

async function runInit(args: readonly string[], cwd: string, dependencies: NonNullable<CliDependencies["init"]> = {}): Promise<CliResult> {
  const parsed = options(args, cwd);
  const target = parsed.rest[0] !== undefined ? path.resolve(cwd, parsed.rest[0]) : path.resolve(cwd);
  const calendarId = newEntityId(
    ENTITY_ID_PREFIX.calendar,
    dependencies.randomIndex,
    dependencies.now?.() ?? new Date(),
  );
  await mkdir(target, { recursive: true });
  if (!(await directoryIsEmpty(target))) {
    throw new RepositoryFormatError("INIT_TARGET_NOT_EMPTY", `Target directory is not empty (excluding .git): ${target}`);
  }
  await mkdir(path.join(target, ".gitpm"), { recursive: true });
  await mkdir(path.join(target, "calendars"), { recursive: true });
  await mkdir(path.join(target, "uploads"), { recursive: true });
  for (const sub of INIT_KEEPERS) {
    const directory = path.join(target, sub);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, ".gitkeep"), "", "utf8");
  }
  await writeFile(path.join(target, ".gitpm", "repository.yaml"), initRepositoryYaml(calendarId), "utf8");
  await writeFile(path.join(target, ".gitpm", "statuses.yaml"), INIT_STATUSES_YAML, "utf8");
  await writeFile(path.join(target, ".gitpm", "issue-types.yaml"), INIT_ISSUE_TYPES_YAML, "utf8");
  await writeFile(path.join(target, "calendars", `${calendarId}.yaml`), initCalendarYaml(calendarId), "utf8");
  await writeFile(path.join(target, "README.md"), INIT_README_MD, "utf8");
  await writeFile(path.join(target, ".gitignore"), INIT_GITIGNORE, "utf8");
  await writeFile(path.join(target, ".ignore"), INIT_IGNORE, "utf8");
  await writeFile(path.join(target, "uploads", ".gitkeep"), "", "utf8");

  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" };
  const branch = process.env.GITPM_INIT_BRANCH?.trim() || "main";
  try {
    await execFileAsync("git", ["-C", target, "rev-parse", "--git-dir"], { windowsHide: true });
  } catch {
    await execFileAsync("git", ["init", "-b", branch, target], { windowsHide: true, env: gitEnv });
  }
  await execFileAsync("git", ["-C", target, "add", "."], { windowsHide: true, env: gitEnv });
  const authorName = process.env.GITPM_INIT_AUTHOR_NAME?.trim() || "GitPM";
  const authorEmail = process.env.GITPM_INIT_AUTHOR_EMAIL?.trim() || "gitpm@localhost";
  const message = process.env.GITPM_INIT_MESSAGE?.trim() || "Initialise GitPM repository";
  await execFileAsync(
    "git",
    ["-C", target, "-c", `user.name=${authorName}`, "-c", `user.email=${authorEmail}`, "commit", "-m", message],
    { windowsHide: true, env: gitEnv },
  );
  const { stdout: commit } = await execFileAsync("git", ["-C", target, "rev-parse", "HEAD"], { windowsHide: true });
  return {
    exitCode: 0,
    output: render(parsed.json, { ok: true, code: "OK", path: target, commit: commit.trim() }, `Initialised GitPM repository at ${target} (${commit.trim()})`),
  };
}

export async function run(args: readonly string[], cwd = process.cwd(), dependencies: CliDependencies = {}): Promise<CliResult> {
  if (args.includes("--version") || args.includes("-v")) {
    const unknown = args.find((argument) => !["--version", "-v", "--json"].includes(argument));
    if (unknown !== undefined || (args.includes("--version") && args.includes("-v"))) {
      return {
        exitCode: 2,
        output: render(
          args.includes("--json"),
          { ok: false, code: "CLI_USAGE", message: `Unknown or conflicting version option: ${unknown ?? "-v"}` },
          ROOT_USAGE,
        ),
      };
    }
    const payload = await versionPayload();
    return { exitCode: 0, output: args.includes("--json") ? JSON.stringify(payload, null, 2) : GITPM_VERSION };
  }
  const [command, ...commandArgs] = args;
  if (command === "help" || args.includes("--help") || args.includes("-h")) {
    const requested = command === "help" ? commandArgs[0] : command;
    const key = requested === undefined ? "root" : requested;
    const help = commandHelp[key];
    const json = args.includes("--json");
    if (help === undefined) {
      return { exitCode: 2, output: render(json, { ok: false, code: "CLI_USAGE", message: `Unknown command: ${key}` }, ROOT_USAGE) };
    }
    return { exitCode: 0, output: render(json, { ok: true, code: "OK", command: key, help }, help) };
  }
  const hasDraft = commandArgs.includes("--draft");
  const direct = dependencies.direct;
  // In direct mode, format/validate/diff operate on the selected checkout by default.
  const directRootArgs = (!hasDraft && direct !== undefined && !commandArgs.includes("--root"))
    ? ["--root", direct.checkoutPath]
    : [];
  try {
    assertKnownArguments(command, commandArgs);
    if (command === "status") {
      if (hasDraft) {
        const agent = requireAgent(dependencies);
        const draftId = required(flagValue(commandArgs, "--draft"), "--draft");
        const metadata = await agent.status(draftId);
        return { exitCode: 0, output: render(commandArgs.includes("--json"), { ok: true, code: "OK", draft: metadata }, `Draft ${metadata.draft_id}: ${metadata.writer_mode} (${metadata.state})\n${metadata.worktree_path}`) };
      }
      return await runDirectStatus(commandArgs, dependencies);
    }
    if (command === "draft") return await runDraft(commandArgs, dependencies);
    if (command === "entity") return await runEntity(commandArgs, cwd, dependencies);
    if (command === "schema") return await runSchema(commandArgs);
    if (command === "format" && hasDraft) { const context = await draftRoot(commandArgs, dependencies); return await runFormat([...commandArgs, "--root", context.root], cwd, context.scope); }
    if (command === "format" && direct !== undefined) {
      const scope = await direct.assertScope(agentScope(commandArgs));
      return await runFormat([...directRootArgs, ...commandArgs], cwd, flagValue(commandArgs, "--project") === undefined ? undefined : scope);
    }
    if (command === "format") return await runFormat(commandArgs, cwd);
    if (command === "validate" && hasDraft) { const context = await draftRoot(commandArgs, dependencies); return await runValidate([...commandArgs, "--root", context.root], cwd); }
    if (command === "validate" && direct !== undefined) { await direct.assertScope(agentScope(commandArgs)); return await runValidate([...directRootArgs, ...commandArgs], cwd); }
    if (command === "validate") return await runValidate(commandArgs, cwd);
    if (command === "diff" && hasDraft) { const agent = requireAgent(dependencies); const draftId = required(flagValue(commandArgs, "--draft"), "--draft"); const report = await agent.semanticDiff(draftId, agentScope(commandArgs)); return { exitCode: 0, output: render(commandArgs.includes("--json"), { ok: true, code: "OK", ...report }, `Semantic diff: ${report.counts.created + report.counts.updated + report.counts.archived + report.counts.deleted} changed entities`) }; }
    if (command === "diff" && direct !== undefined) { const report = await direct.semanticDiff(agentScope(commandArgs)); return { exitCode: 0, output: render(commandArgs.includes("--json"), { ok: true, code: "OK", ...report }, `Semantic diff: ${report.counts.created + report.counts.updated + report.counts.archived + report.counts.deleted} changed entities`) }; }
    if (command === "diff") return await runSemanticDiff(commandArgs, cwd);
    if (command === "commit") {
      if (hasDraft) return await runCommit(commandArgs, dependencies);
      return await runDirectCommit(commandArgs, dependencies);
    }
    if (command === "push") {
      if (hasDraft) return await runPush(commandArgs, dependencies);
      return await runDirectPush(commandArgs, dependencies);
    }
    if (command === "mr") return await runMr(commandArgs, dependencies);
    if (command === "comment") return await runComment(commandArgs, cwd, dependencies);
    if (command === "config") return await runConfig(commandArgs, cwd, dependencies);
    if (command === "doctor" && direct !== undefined) { await direct.prepare(); return await runDoctor([...directRootArgs, ...commandArgs], cwd); }
    if (command === "doctor") return await runDoctor(commandArgs, cwd);
    if (command === "init") return await runInit(commandArgs, cwd, dependencies.init);
    const json = args.includes("--json");
    return {
      exitCode: 2,
      output: render(json, { ok: false, code: "CLI_USAGE" }, ROOT_USAGE),
    };
  } catch (error) {
    const code = error instanceof RepositoryFormatError || (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") ? error.code : "CLI_INTERNAL";
    const message = error instanceof Error ? error.message : String(error);
    const details = typeof error === "object" && error !== null && "details" in error ? error.details : undefined;
    return { exitCode: 1, output: JSON.stringify({ ok: false, code, message, ...(details === undefined ? {} : { details }) }, null, 2) };
  }
}
