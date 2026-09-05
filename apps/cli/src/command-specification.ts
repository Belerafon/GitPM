import { RepositoryFormatError } from "@gitpm/repository-format";

export const CLI_COMMAND_NAMES = [
  "init", "status", "draft", "entity", "calendar", "schedule", "planning", "workload",
  "comment", "notification", "time-entry", "config", "schema", "format", "validate", "diff",
  "changes", "history", "export", "commit", "push", "mr", "doctor",
] as const;

export type CliCommandName = (typeof CLI_COMMAND_NAMES)[number];

export const ROOT_USAGE = "Usage: gitpm <init|status|draft|entity|calendar|schedule|planning|workload|comment|notification|time-entry|config|schema|format|validate|diff --semantic|changes|history|export|commit --all|push|mr|doctor> [options]";

const commandHelp: Readonly<Record<CliCommandName | "root", string>> = {
  root: [
    ROOT_USAGE,
    "",
    "Run 'gitpm <command> --help' for command-specific help. All commands support --json.",
  ].join("\n"),
  entity: [
    "Usage:",
    "  gitpm entity create [--draft <id>] --file <yaml> [--type <type>] [--project <id>] [--allow-delete] [--json]",
    "  gitpm entity update [--draft <id>] --type <type> --id <entity-id> [--file <yaml-patch>] [--set <field>=<yaml-value>]... [--unset <field>]... [--project <id>] [--allow-delete] [--json]",
    "  gitpm entity import [--draft <id>] --type <type> --format <csv|yaml|jsonl> (--file <path>|--path <path>) [--dry-run] [--project <id>] [--allow-delete] [--json]",
    "  gitpm entity list [--draft <id>] --type <type> [--project <id>] [--json]",
    "  gitpm entity show [--draft <id>] --type <type> --id <entity-id> [--json]",
    "  gitpm entity delete [--draft <id>] --type <type> --id <entity-id> [--unlink-references|--cascade-references] [--dry-run] [--allow-delete] [--project <id>] [--json]",
    "  gitpm entity archive [--draft <id>] --type <type> --id <entity-id> [--include-tasks] [--project <id>] [--allow-delete] [--json]",
    "  gitpm entity restore [--draft <id>] --type <type> --id <entity-id> [--include-tasks|--restore-milestone] [--project <id>] [--allow-delete] [--json]",
    "  gitpm entity move [--draft <id>] --type task --id <entity-id> --to-project <id> [--to-milestone <id>] [--to-parent <task-id>] [--allow-delete] [--project <id>] [--json]",
    "",
    "create accepts a YAML mapping. schema, id and lifecycle may be omitted when --type is supplied.",
    "Person calendar may be omitted and is materialized from repository default_calendar.",
    "A supplied valid ID is preserved; otherwise GitPM generates <prefix>-<UTC YY>-<6 Crockford Base32>.",
    "update applies a YAML field patch from --file and/or repeatable --set/--unset options. Entity ID, schema, owning Project and lifecycle are immutable.",
    "import is atomic: the complete batch is validated once and rolled back on any error.",
    "list returns every entity of a type (optionally filtered by --project).",
    "show returns a single entity document with its canonical path.",
    "delete removes the entity file. Task deletion cascades to that task's comments.",
    "  --dry-run returns the reference impact (restrictions, cascade and unlink preview) without writing.",
    "  --unlink-references removes references to a person before deleting (people only).",
    "  --cascade-references deletes every entity owned by a project before deleting the project (projects only).",
    "  Restricted references raise DELETE_RESTRICTED with structured details listing every affected item.",
    "archive sets lifecycle to archived (reversible); the entity file stays and references remain valid.",
    "restore sets an archived entity back to active after validating that its lifecycle references are active.",
    "move relocates a task (and its comments) to another project and optional milestone.",
  ].join("\n"),
  calendar: [
    "Usage:",
    "  gitpm calendar presets [--preset <id>] [--json]",
    "  gitpm calendar create [--draft <id>] --preset <id> [--name <name>] [--id <calendar-id>] [--json]",
    "  gitpm calendar apply [--draft <id>] --preset <id> --id <calendar-id> [--name <name>] [--json]",
    "",
    "presets lists the built-in, editable schedules and their coverage.",
    "create materializes a preset as a normal Calendar entity.",
    "apply replaces an existing Calendar's working weekdays and non-working dates; --name also renames it.",
  ].join("\n"),
  init: [
    "Usage:",
    "  gitpm init [path] [--calendar-preset <id>] [--json]",
    "",
    "The default standard-five-day preset has no public holidays.",
    "Run 'gitpm calendar presets' to inspect official built-in schedules and their coverage.",
  ].join("\n"),
  schema: [
    "Usage:",
    "  gitpm schema list [--json]",
    "  gitpm schema show <type> [--example] [--json]",
  ].join("\n"),
  validate: "Usage: gitpm validate [--draft <id>] [--project <id>] [--changed] [--allow-delete] [--json]",
  format: "Usage: gitpm format [--draft <id>] [--project <id>] [--check] [--allow-delete] [--json]",
  diff: "Usage: gitpm diff --semantic [--draft <id>] [--project <id>] [--allow-delete] [--json]",
  export: [
    "Usage:",
    "  gitpm export [--draft <id>] --format pdf|html|csv|xlsx|repository [--locale en|ru] [--section portfolio|project-plan|plan-fact|workload|vacations|person-profile|audit|projects|people|project-details|gantt]... [--scope portfolio|project|person|team] [--project <id>] [--person <id>] [--team <id>] [--as-of <YYYY-MM-DD>] [--from <YYYY-MM-DD>] [--to <YYYY-MM-DD>] [--lifecycle active|archived|all] [--include-email] [--hide-personal-data] [--page-size A4|Letter] [--density compact|detailed] [--include-git] [--output <path>] [--force] [--json]",
    "",
    "PDF defaults to Projects and People when --section is omitted.",
    "HTML, CSV and XLSX default to every report. CSV still includes one raw table per schema.",
    "Repository ZIP excludes .git unless --include-git is set; portable Git exports remove the remote URL.",
    "The default filename contains the HEAD commit date and short hash. Existing files are not replaced unless --force is set.",
  ].join("\n"),
  commit: "Usage: gitpm commit --all [--draft <id>] -m <message> [--project <id>] [--allow-delete] [--json]",
  status: "Usage: gitpm status [--draft <id>] [--json]",
  draft: [
    "Usage:",
    "  gitpm draft list [--owner <id>] [--json]",
    "  gitpm draft create|open|status|acknowledge|close|reopen --draft <id> [--owner <id>] [--json]",
    "  gitpm draft set-writer ui|external --draft <id> --owner <id> [--json]",
    "  gitpm draft cleanup --draft <id> --owner <id> --confirm <id> [--json]",
  ].join("\n"),
  push: "Usage: gitpm push [--draft <id>] [--json]",
  mr: "Usage: gitpm mr create|status --draft <id> --owner <id> [--title <title>] [--description <text>] [--json]",
  doctor: "Usage: gitpm doctor [--json]",
  comment: [
    "Usage:",
    "  gitpm comment list [--draft <id>] --project <id> --task <id> [--json]",
    "  gitpm comment create [--draft <id>] --project <id> --task <id> (--body <text> | --file <path>) [--json]",
    "  gitpm comment update [--draft <id>] --project <id> --task <id> --id <comment-id> (--body <text> | --file <path>) [--json]",
    "  gitpm comment delete [--draft <id>] --project <id> --task <id> --id <comment-id> [--json]",
    "",
    "Comments support Markdown with @[Name](person:U-...) mentions.",
    "Delete is a soft-delete (tombstone remains in Git history).",
  ].join("\n"),
  notification: "Usage: gitpm notification list [--draft <id>] [--person <id>] [--json]",
  "time-entry": [
    "Usage:",
    "  gitpm time-entry list [--draft <id>] --project <id> [--task <id>] [--milestone <id>] [--person <id>] [--category <slug>] [--state active|voided] [--from <yyyy-mm-dd>] [--to <yyyy-mm-dd>] [--offset <n>] [--limit <n>] [--json]",
    "  gitpm time-entry summary [--draft <id>] --project <id> [--task <id>] [--milestone <id>] [--person <id>] [--category <slug>] [--state active|voided] [--from <yyyy-mm-dd>] [--to <yyyy-mm-dd>] [--after <yyyy-mm-dd>] [--json]",
    "  gitpm time-entry create [--draft <id>] --project <id> --task <id> --person <id> --date <yyyy-mm-dd> --hours <n> --category <slug> [--note <text>] [--json]",
    "  gitpm time-entry replace [--draft <id>] --project <id> --task <id> --id <entry-id> --person <id> --date <yyyy-mm-dd> --hours <n> --category <slug> [--note <text>] [--json]",
    "  gitpm time-entry void [--draft <id>] --project <id> --task <id> --id <entry-id> [--json]",
    "",
    "List and summary operate at Project scope; --task narrows the result. Actual effort is stored independently of task status and plan windows.",
    "Void marks an entry voided (kept in history).",
  ].join("\n"),
  schedule: [
    "Usage:",
    "  gitpm schedule set [--draft <id>] --type project|task|milestone --id <id> --track <slug> [--start <yyyy-mm-dd>] [--finish <yyyy-mm-dd>] [--effort-hours <n>] [--depends-on <task-id>]... [--clear-start] [--clear-finish] [--clear-effort] [--clear-dependencies] [--project <id>] [--allow-delete] [--json]",
    "",
    "Updates one schedules.<track> window and preserves other track windows. Dependencies belong to the selected track.",
  ].join("\n"),
  planning: [
    "Usage:",
    "  gitpm planning show [--draft <id>] --project <id> [--json]",
    "  gitpm planning set [--draft <id>] --project <id> [--primary-track <slug>] [--workload-track <slug>] [--comparison-track <slug>|--clear-comparison-track] [--enabled-track <slug>]... [--dashboard-track <slug>]... [--allow-delete] [--json]",
    "",
    "Set only the planning fields supplied. Repeated track flags replace that planning list.",
  ].join("\n"),
  workload: [
    "Usage:",
    "  gitpm workload report [--draft <id>] [--project <id>] [--milestone <id>] [--team <id>] [--json]",
    "",
    "Uses the same repository-level workload calculation as the HTTP API and GUI.",
    "Active Tasks owned by archived Projects are excluded from capacity and reported as archived exclusions.",
  ].join("\n"),
  config: [
    "Usage:",
    "  gitpm config show [--draft <id>] --kind repository|statuses|issue-types|work-categories|schedule-tracks [--json]",
    "  gitpm config update [--draft <id>] --kind repository|statuses|issue-types|work-categories|schedule-tracks [--file <yaml>] [--set <field>=<yaml-value>]... [--unset <field>] [--allow-delete] [--json]",
    "",
    "Reads or updates repository configuration documents in .gitpm/.",
  ].join("\n"),
  changes: [
    "Usage:",
    "  gitpm changes list [--draft <id>] [--project <id>] [--allow-delete] [--json]",
    "  gitpm changes restore-file [--draft <id>] --path <path> [--project <id>] [--allow-delete] [--json]",
    "  gitpm changes restore-hunk [--draft <id>] --path <path> --diff-token <sha256> --hunk <index> [--project <id>] [--allow-delete] [--json]",
    "  gitpm changes discard-all [--draft <id>] --confirm discard-all [--project <id>] [--allow-delete] [--json]",
  ].join("\n"),
  history: [
    "Usage:",
    "  gitpm history list [--draft <id>] [--limit <n>] [--json]",
    "  gitpm history show [--draft <id>] --commit <sha> [--json]",
    "  gitpm history file-diff [--draft <id>] --commit <sha> --path <path> [--json]",
    "  gitpm history file-history [--draft <id>] --path <path> [--limit <n>] [--json]",
    "  gitpm history restore --commit <sha> --path <path> [--path <path> ...] [--json]",
    "  gitpm history revert --commit <sha> --message <message> [--json]",
    "  gitpm history revert --draft <id> --commit <sha> --new-draft <id> --owner <id> [--json]",
  ].join("\n"),
};

export interface CliArgumentSpec {
  readonly values?: readonly string[];
  readonly repeatable?: readonly string[];
  readonly booleans?: readonly string[];
  readonly minPositionals: number;
  readonly maxPositionals: number;
}

export interface CliCommandSpecification {
  readonly help: string;
  readonly arguments: (args: readonly string[]) => CliArgumentSpec;
}

export function commandArgumentSpec(command: string | undefined, args: readonly string[]): CliArgumentSpec | undefined {
  const action = args[0];
  if (command === "status") return { values: ["--draft"], booleans: ["--json"], minPositionals: 0, maxPositionals: 0 };
  if (command === "draft") return { values: ["--draft", "--owner", "--confirm"], booleans: ["--json"], minPositionals: 1, maxPositionals: action === "set-writer" ? 2 : 1 };
  if (command === "entity") {
    const common = ["--draft", "--type", "--schema"];
    if (action === "create") return { values: [...common, "--file", "--path", "--project"], booleans: ["--allow-delete", "--json"], minPositionals: 1, maxPositionals: 1 };
    if (action === "update") return { values: [...common, "--id", "--file", "--path", "--project"], repeatable: ["--set", "--unset"], booleans: ["--allow-delete", "--json"], minPositionals: 1, maxPositionals: 1 };
    if (action === "import" || action === "bulk-import") return { values: [...common, "--format", "--file", "--path", "--project"], booleans: ["--dry-run", "--allow-delete", "--json"], minPositionals: 1, maxPositionals: 1 };
    if (action === "list") return { values: [...common, "--project"], booleans: ["--json"], minPositionals: 1, maxPositionals: 1 };
    if (action === "show") return { values: [...common, "--id"], booleans: ["--json"], minPositionals: 1, maxPositionals: 1 };
    if (action === "delete") return { values: [...common, "--id", "--project"], booleans: ["--unlink-references", "--cascade-references", "--dry-run", "--allow-delete", "--json"], minPositionals: 1, maxPositionals: 1 };
    if (action === "archive") return { values: [...common, "--id", "--project"], booleans: ["--include-tasks", "--allow-delete", "--json"], minPositionals: 1, maxPositionals: 1 };
    if (action === "restore") return { values: [...common, "--id", "--project"], booleans: ["--include-tasks", "--restore-milestone", "--allow-delete", "--json"], minPositionals: 1, maxPositionals: 1 };
    if (action === "move") return { values: [...common, "--id", "--to-project", "--to-milestone", "--to-parent", "--project"], booleans: ["--allow-delete", "--json"], minPositionals: 1, maxPositionals: 1 };
    return { booleans: ["--json"], minPositionals: 1, maxPositionals: 1 };
  }
  if (command === "calendar") {
    if (action === "presets") return { values: ["--preset"], booleans: ["--json"], minPositionals: 1, maxPositionals: 1 };
    if (action === "create") return { values: ["--draft", "--preset", "--name", "--id"], booleans: ["--json"], minPositionals: 1, maxPositionals: 1 };
    if (action === "apply") return { values: ["--draft", "--preset", "--name", "--id"], booleans: ["--json"], minPositionals: 1, maxPositionals: 1 };
    return { booleans: ["--json"], minPositionals: 1, maxPositionals: 1 };
  }
  if (command === "schema") return action === "show"
    ? { booleans: ["--example", "--json"], minPositionals: 2, maxPositionals: 2 }
    : { booleans: ["--json"], minPositionals: 1, maxPositionals: 1 };
  if (command === "format") return { values: ["--root", "--draft", "--project"], booleans: ["--check", "--allow-delete", "--json"], minPositionals: 0, maxPositionals: 0 };
  if (command === "validate") return { values: ["--root", "--draft", "--project"], booleans: ["--changed", "--allow-delete", "--json"], minPositionals: 0, maxPositionals: 0 };
  if (command === "diff") return { values: ["--root", "--draft", "--project"], booleans: ["--semantic", "--allow-delete", "--json"], minPositionals: 0, maxPositionals: 0 };
  if (command === "export") return { values: ["--draft", "--format", "--locale", "--output", "--scope", "--project", "--person", "--team", "--as-of", "--from", "--to", "--lifecycle", "--time-entry-state", "--page-size", "--density", "--title"], repeatable: ["--section"], booleans: ["--include-git", "--include-email", "--hide-personal-data", "--force", "--json"], minPositionals: 0, maxPositionals: 0 };
  if (command === "commit") return { values: ["--draft", "-m", "--message", "--project"], booleans: ["--all", "--allow-delete", "--json"], minPositionals: 0, maxPositionals: 0 };
  if (command === "push") return { values: ["--draft"], booleans: ["--json"], minPositionals: 0, maxPositionals: 0 };
  if (command === "mr") return { values: ["--draft", "--owner", "--title", "--description"], booleans: ["--json"], minPositionals: 1, maxPositionals: 1 };
  if (command === "comment") return { values: ["--draft", "--project", "--task", "--id", "--body", "--file", "--path"], booleans: ["--json"], minPositionals: 1, maxPositionals: 1 };
  if (command === "notification") return { values: ["--draft", "--person"], booleans: ["--json"], minPositionals: 1, maxPositionals: 1 };
  if (command === "time-entry") return { values: ["--draft", "--project", "--task", "--milestone", "--id", "--person", "--date", "--hours", "--category", "--note", "--after", "--state", "--from", "--to", "--offset", "--limit"], booleans: ["--json"], minPositionals: 1, maxPositionals: 1 };
  if (command === "schedule") return { values: ["--draft", "--type", "--id", "--track", "--start", "--finish", "--effort-hours", "--project"], repeatable: ["--depends-on"], booleans: ["--clear-start", "--clear-finish", "--clear-effort", "--clear-dependencies", "--allow-delete", "--json"], minPositionals: 1, maxPositionals: 1 };
  if (command === "planning") return { values: ["--draft", "--project", "--primary-track", "--workload-track", "--comparison-track"], repeatable: ["--enabled-track", "--dashboard-track"], booleans: ["--clear-comparison-track", "--allow-delete", "--json"], minPositionals: 1, maxPositionals: 1 };
  if (command === "workload") return { values: ["--draft", "--project", "--milestone", "--team"], booleans: ["--json"], minPositionals: 1, maxPositionals: 1 };
  if (command === "config") {
    return action === "update"
      ? { values: ["--draft", "--kind", "--file", "--path"], repeatable: ["--set", "--unset"], booleans: ["--allow-delete", "--json"], minPositionals: 1, maxPositionals: 1 }
      : { values: ["--draft", "--kind"], booleans: ["--json"], minPositionals: 1, maxPositionals: 1 };
  }
  if (command === "changes") return { values: ["--draft", "--project", "--path", "--diff-token", "--hunk", "--confirm"], booleans: ["--allow-delete", "--json"], minPositionals: 1, maxPositionals: 1 };
  if (command === "history") return { values: ["--draft", "--commit", "--path", "--limit", "--new-draft", "--owner", "--message"], booleans: ["--json"], minPositionals: 1, maxPositionals: 1 };
  if (command === "doctor") return { values: ["--root"], booleans: ["--json"], minPositionals: 0, maxPositionals: 0 };
  if (command === "init") return { values: ["--calendar-preset"], booleans: ["--json"], minPositionals: 0, maxPositionals: 1 };
  return undefined;
}

export const COMMAND_SPECIFICATIONS: Readonly<Record<CliCommandName, CliCommandSpecification>> = Object.freeze(
  Object.fromEntries(CLI_COMMAND_NAMES.map((command) => [
    command,
    {
      help: commandHelp[command],
      arguments: (args: readonly string[]) => commandArgumentSpec(command, args)!,
    },
  ])) as unknown as Record<CliCommandName, CliCommandSpecification>,
);

function isCliCommand(command: string | undefined): command is CliCommandName {
  return command !== undefined && Object.prototype.hasOwnProperty.call(COMMAND_SPECIFICATIONS, command);
}

export function assertKnownArguments(command: string | undefined, args: readonly string[]): void {
  const spec = isCliCommand(command) ? COMMAND_SPECIFICATIONS[command].arguments(args) : undefined;
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



export function helpForCommand(command: string): string | undefined {
  if (command === "root") return commandHelp.root;
  return isCliCommand(command) ? COMMAND_SPECIFICATIONS[command].help : undefined;
}
