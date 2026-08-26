import { lstat, mkdir, readFile } from "node:fs/promises";
import { atomicWriteDomainFile, resolveDomainPath } from "@gitpm/security";

export const GITPM_AGENT_FILE = "AGENTS.md";
export const GITPM_SKILL_FILE = ".agents/skills/gitpm/SKILL.md";

export const GITPM_GUIDANCE_PATHS = [GITPM_AGENT_FILE, GITPM_SKILL_FILE] as const;
export const GITPM_GUIDANCE_FILES = new Set<string>(GITPM_GUIDANCE_PATHS);

export class WorktreeGuidanceError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "WorktreeGuidanceError";
  }
}

async function ensureDirectory(root: string, relative: string): Promise<void> {
  const absolute = await resolveDomainPath(root, relative);
  try {
    await mkdir(absolute, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const details = await lstat(absolute);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new WorktreeGuidanceError("WORKTREE_GUIDANCE_PATH_INVALID", `${relative} must be a regular directory`);
  }
}

async function writeGuidanceFile(root: string, relative: string, content: string): Promise<boolean> {
  const absolute = await resolveDomainPath(root, relative);
  try {
    if (await readFile(absolute, "utf8") === content) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await atomicWriteDomainFile(root, relative, content);
  return true;
}

export async function provisionGitPmWorktreeGuidance(root: string, draftId: string): Promise<boolean> {
  await ensureDirectory(root, ".agents");
  await ensureDirectory(root, ".agents/skills");
  await ensureDirectory(root, ".agents/skills/gitpm");
  const changed = await Promise.all([
    writeGuidanceFile(root, GITPM_AGENT_FILE, gitPmAgentFile(draftId)),
    writeGuidanceFile(root, GITPM_SKILL_FILE, GITPM_SKILL_FILE_CONTENT),
  ]);
  return changed.some(Boolean);
}

export function gitPmAgentFile(draftId: string): string {
  return `# GitPM draft agent instructions

This worktree is GitPM draft \`${draftId}\`. Read and follow
\`.agents/skills/gitpm/SKILL.md\` before doing any GitPM work. GitPM manages this file and
the skill; do not edit or delete them.

This is the portfolio-data runtime contract, not the GitPM source-development \`AGENTS.md\`. Do not
edit or patch the GitPM application from this worktree.

## Product philosophy

GitPM is Git-first project management. The repository is the source of truth, YAML is the
portable human-readable representation, and a draft worktree is the isolated unit of change.
There is no separate agent database or agent API. The CLI is the supported policy and safety
boundary around repository mutations; bypassing it can violate identity, references, scope,
writer ownership, validation, deletion, and publishing rules.

The guidance files are local runtime material for this worktree. GitPM excludes them from
Project scope, semantic diff, commits, and Merge Requests; their presence does not widen the
requested business change.

Work conservatively:

- understand current state before changing it;
- keep one external writer per draft and work only in the reported worktree;
- preserve immutable IDs and explicit references;
- limit work to the requested Project whenever possible;
- validate the complete repository and review the semantic diff;
- do not commit unless the user explicitly requests a commit; when requested, commit the
  complete draft atomically through GitPM;
- publish only when the user explicitly requests it;
- prefer a clear blocker over a guessed command or a hidden manual edit.

## Repository model

- \`.gitpm/repository.yaml\`, \`.gitpm/statuses.yaml\`, and
  \`.gitpm/issue-types.yaml\` contain repository-wide configuration.
- \`people/\`, \`teams/\`, \`calendars/\`, and \`availability/\` contain global entities.
- \`projects/<project-id>/project.yaml\` contains a Project.
- Project milestones, tasks, saved views, and task comments live below the same Project.
- Entity references use immutable IDs such as \`P-26-7K4M9Q\` and
  \`T-26-X8D2FW\`; paths and IDs are validated together.
- A mutation invoked with \`--project\` must not itself change global configuration, People,
  Teams, Calendars, Availability Events, or another Project. An explicitly combined user request
  may accumulate separate global and Project mutations in one draft for final unscoped review.
- Archive is a lifecycle state. Physical deletion is separate, restricted by references, and
  always requires explicit authorization.

## Mandatory operating rules

- Use the \`gitpm\` CLI for every mutation, format, validation, semantic diff, commit, push,
  and Merge Request operation.
- Never edit, rename, or delete files under \`.gitpm/\`, \`people/\`, \`teams/\`,
  \`calendars/\`, \`availability/\`, or \`projects/\` directly.
- Never use raw \`git add\`, \`git commit\`, \`git push\`, Git hosting APIs, MCP, or UI API
  calls to mutate GitPM data.
- Reading repository files and using read-only Git commands for orientation is allowed.
- A request to create, update, archive, move, or delete GitPM data does not authorize a commit.
  Run a commit command only when the user explicitly requests a commit.
- Prefer \`--json\`; evaluate both the process exit code and the stable GitPM result code.
- Never place credentials in arguments, repository URLs, files, Git configuration, logs, or
  responses.
- If the installed CLI has no command for a requested mutation, stop and report the missing
  capability. Do not bypass the CLI.

## User-supplied uploads

The \`uploads/\` directory at the repository root is a working area for incoming
documents (for example, \`.docx\`, \`.xlsx\`, \`.pdf\` reports) that you read but never
import verbatim into the GitPM data store. \`uploads/\` is listed in
\`allowed_top_level_directories\` and ignored by the root \`.gitignore\`, so Git
never tracks incoming files. The companion root \`.ignore\` un-ignores
\`uploads/\` for ripgrep-based tools (including OpenCode), so you can still
discover and read these files while Git ignores them:

- read, parse, and convert these files freely;
- use Python with \`openpyxl\` to read, create, or modify Excel workbooks;
- never copy their bytes into \`projects/\`, \`people/\`, \`teams/\`, \`calendars/\`, \`availability/\`,
  or \`.gitpm/\`;
- never \`git add\` or commit incoming files under \`uploads/\`;
- never delete or rename files under \`uploads/\` unless explicitly requested.

When asked to seed or update GitPM data from a document, extract the relevant fields and use
\`gitpm entity create\`, \`gitpm entity update\`, or \`gitpm entity import\` with a temporary
YAML/CSV/JSONL file outside this worktree.

## CLI workflow

Start with:

\`gitpm --version\`

\`gitpm draft status --draft ${draftId} --json\`

For supported entity creation, supply a YAML mapping from a temporary path outside this worktree.
Use \`--type\` when schema is omitted; GitPM generates a missing ID and applies documented defaults:

\`gitpm entity create --draft ${draftId} --type <type> --file <temporary-yaml> [--project <project-id>] [--allow-delete] --json\`

Update one or more fields without a temporary file by repeating \`--set\`; use \`--unset\` to
remove an optional field:

\`gitpm entity update --draft ${draftId} --type <type> --id <entity-id> --set <field>=<yaml-value> [--set ...] [--unset <field>] [--project <project-id>] [--allow-delete] --json\`

Inspect fields with \`gitpm schema show <type> --json\`. Inspect existing data with
\`gitpm entity list --draft ${draftId} --type <type> [--project <id>] --json\` and
\`gitpm entity show --draft ${draftId} --type <type> --id <entity-id> --json\`.

For bulk creation, use \`gitpm entity
import --draft <draft-id> --type <type> --format <csv|yaml|jsonl> --file <file>\`, first with
\`--dry-run\` and then without it; add \`--project <project-id>\` when scoped and
\`--allow-delete\` while a physical deletion is present.

Before removing an entity, preview the impact with
\`gitpm entity delete --draft ${draftId} --type <type> --id <entity-id> --dry-run --json\`.
Restrictions, cascade, and unlink paths are reported without writing. Then delete with
\`--allow-delete\`; add \`--unlink-references\` for a person to remove references first, or
\`--cascade-references\` for a project to delete every project-owned entity.
Archive a reversible lifecycle state with
\`gitpm entity archive --draft ${draftId} --type <type> --id <entity-id> [--include-tasks] [--project <project-id>] [--allow-delete] --json\`.
Restore it with
\`gitpm entity restore --draft ${draftId} --type <type> --id <entity-id> [--include-tasks|--restore-milestone] [--project <project-id>] [--allow-delete] --json\`.
Move a task with
\`gitpm entity move --draft ${draftId} --type task --id <entity-id> --to-project <id> [--to-milestone <id>] --allow-delete --json\`.

Use \`gitpm comment list|create|update|delete --draft ${draftId} ...\` for task comments,
\`gitpm notification list --draft ${draftId}\` for mentions,
\`gitpm time-entry list|summary|create|replace|void --draft ${draftId} ...\` for actual effort, and
\`gitpm config show|update --draft ${draftId} ...\` for repository configuration. These are
domain commands; never substitute raw YAML edits.

Then run \`format\`, \`validate --changed\`, and \`diff --semantic\` with
\`--draft ${draftId}\`, \`--json\`, and \`--project\` when scoped. Repeat
\`--allow-delete\` on every subsequent mutation, verification, and commit command while a
physical deletion is present.
Stop after reporting the verified semantic diff unless the user explicitly requested a commit.
When a commit was explicitly requested, use only \`gitpm commit --all\`. Use \`gitpm push\` and
\`gitpm mr create\` only when publication was requested. The full command reference and decision
rules are in the skill.

## Errors, ambiguity, and product feedback

Do not silently work around a GitPM error, unclear contract, inconsistent output, missing CLI
operation, or ambiguous repository state. Tell the user:

1. what operation is blocked and what you were trying to achieve;
2. the exact sanitized command, exit code, and stable GitPM error code;
3. what was observed and what behavior was expected;
4. whether the likely cause is repository data, runtime configuration, or a GitPM product gap;
5. a concrete improvement GitPM should make, such as a new CLI command, clearer validation
   message, safer default, additional machine-readable field, or documentation clarification.

Ask the user before expanding scope or changing intent. Do not patch the GitPM application from
inside a portfolio draft, and do not turn a product suggestion into an unauthorized workaround.
`;
}

export const GITPM_SKILL_FILE_CONTENT = `---
name: gitpm
description: Operate a GitPM project-management draft safely through the GitPM CLI. Use for understanding GitPM repository data, creating and updating supported entities, validating and formatting draft changes, viewing semantic diffs, committing, pushing, opening Merge Requests, and diagnosing GitPM errors or ambiguous behavior. Enforces CLI-only mutation and requires actionable product feedback instead of workarounds.
---

# Work with a GitPM draft

## Understand the philosophy

Treat GitPM as a Git-first system, not as a collection of YAML files. Git is the history and
publishing protocol; YAML is the reviewable storage format; the draft worktree is the isolated
transaction; the CLI is the mutation and policy boundary. Correct work preserves all four.

\`AGENTS.md\` and this skill are local worktree runtime guidance. GitPM keeps them out of the
business diff, commit, and Merge Request.

Do not confuse this runtime skill with source development of the GitPM application. If the
current directory is the GitPM monorepo rather than the \`worktree_path\` reported by draft status,
stop: the root source-development \`AGENTS.md\` applies there and this skill does not.

Apply these principles:

- Repository truth over hidden state: do not create side databases or private shadow files.
- Explicit workflow over convenience: acquire external writer mode, validate, review, wait for
  an explicit user request before committing all, and publish deliberately.
- Semantic intent over textual patches: use semantic diff and stable entity IDs to understand
  the result.
- Safety over improvisation: stop when the CLI cannot express the requested operation.
- Useful transparency over silent recovery: surface errors and propose improvements to GitPM.

## Know the model

The repository-wide documents are \`.gitpm/repository.yaml\`,
\`.gitpm/statuses.yaml\`, and \`.gitpm/issue-types.yaml\`. Global entity directories are
\`people/\`, \`teams/\`, \`calendars/\`, and \`availability/\`. A Project occupies
\`projects/<P-id>/\` and contains \`project.yaml\`, plus \`milestones/\`, \`tasks/\`,
\`views/\`, and task-scoped \`comments/\`.

Core schemas and relations:

- \`gitpm/project@2\`: status, lifecycle, optional owner, dates, milestone order, labels.
- \`gitpm/task@2\`: owning Project, title, type, status, lifecycle, optional parent and
  milestone, assignees, estimate, dates, dependencies, labels, Markdown fields.
- \`gitpm/milestone@2\`: owning Project, name, lifecycle, due date, task order.
- \`gitpm/person@1\`: name, weekly capacity, Calendar, lifecycle, optional email.
- \`gitpm/team@1\`: name, Person members, lifecycle.
- \`gitpm/calendar@1\`: working weekdays, holidays, lifecycle.
- \`gitpm/availability-event@1\`: Person, date range, kind, availability percentage, state,
  lifecycle, and an optional note.
- \`gitpm/saved-view@1\`: owning Project, list or board kind, filters, optional status grouping.
- \`gitpm/comment@1\`: owning Project and Task, author snapshot, timestamps, state, body, and
  mentions.

IDs are immutable and have the form \`<type>-<UTC-year>-<six Crockford Base32 characters>\`.
Type prefixes are \`P\` Project, \`T\` Task, \`M\` Milestone, \`U\` Person, \`G\` Team,
\`C\` Calendar, \`A\` Availability Event, and \`V\` Saved View. Do not rename IDs or move an entity by changing its
path. References must resolve, task/milestone/view references cannot cross Project boundaries,
and active configuration slugs must exist. Dates are \`YYYY-MM-DD\`; estimates are
nonnegative quarter-hour multiples. YAML uses UTF-8, LF, two-space indentation, no duplicate
keys, aliases, anchors, or custom tags.

Read YAML only to understand state or prepare a temporary create input or update patch. Never
mutate domain files directly.

## Establish the draft context

1. Read \`AGENTS.md\`; take the exact draft ID from it.
2. Run \`gitpm --version\`.
3. Run \`gitpm draft status --draft <draft-id> --json\`.
4. Require \`state: open\`, \`writer_mode: external\`, and a \`worktree_path\` equal to the
   current worktree.
5. If any check fails, stop and use the error-reporting procedure below.

Do not run \`gitpm init\` inside a draft. Do not create another draft unless the user explicitly
asks. Do not switch writer mode back to \`ui\` until agent writes have stopped and the user or
orchestrating workflow requests the handoff.

## Respect the mutation boundary

Never write, rename, or delete data below \`.gitpm/\`, \`people/\`, \`teams/\`,
\`calendars/\`, \`availability/\`, or \`projects/\` with an editor, shell redirection, scripts, filesystem tools,
raw Git, an MCP server, or a private API call. Never modify \`AGENTS.md\` or this skill; GitPM
manages them.

Read-only inspection of repository data and read-only Git commands is allowed. Every state
change must be attributable to a documented \`gitpm\` command.

## Use the supported CLI surface

All commands accept \`--json\`; use it for automation. The CLI rejects unknown and duplicate
non-repeatable options with \`CLI_USAGE\`; never retry a misspelled flag by dropping it silently.

- \`gitpm draft list|create|open|status|set-writer|acknowledge|close|reopen|cleanup\` manages draft
  lifecycle and writer ownership.
- \`gitpm entity create --draft <id> --type <type> --file <file> [--project <id>] [--allow-delete]\` creates an
  entity from a YAML mapping, generating a missing ID and applying documented defaults.
- \`gitpm calendar presets\` lists built-in editable schedules and their coverage;
  \`gitpm calendar create --draft <id> --preset <preset-id>\` creates a Calendar and
  \`gitpm calendar apply --draft <id> --preset <preset-id> --id <calendar-id>\` replaces its schedule.
- \`gitpm entity update --draft <id> --type <type> --id <entity-id> [--file <yaml-patch>]
  [--set <field>=<yaml-value>]... [--unset <field>]... [--project <id>] [--allow-delete]\` transactionally patches
  any supported entity type. Inline values use YAML scalar/collection types; \`--unset\` removes
  an optional field. Identity, schema, and owning Project are immutable.
- \`gitpm entity import --draft <id> --type <type> --format <csv|yaml|jsonl> --file <file>
  [--dry-run] [--project <id>] [--allow-delete]\` atomically validates and creates a batch.
- \`gitpm entity list --draft <id> --type <type> [--project <id>]\` lists entities of a type,
  optionally filtered by Project.
- \`gitpm entity show --draft <id> --type <type> --id <entity-id>\` returns a single entity
  document.
- \`gitpm entity delete --draft <id> --type <type> --id <entity-id> [--unlink-references|--cascade-references]
  [--dry-run] [--allow-delete] [--project <id>]\` removes an entity file. Task deletion
  cascades to that task's comments. \`--dry-run\` previews the reference impact (restrictions,
  cascade, and unlink preview) without writing. \`--unlink-references\` removes references to a
  person before deleting (people only). \`--cascade-references\` deletes every entity owned by a
  project before deleting that project (projects only). \`--allow-delete\` authorizes the physical
  deletion scope.
- \`gitpm entity archive --draft <id> --type <type> --id <entity-id> [--include-tasks] [--project <id>]
  [--allow-delete]\` sets lifecycle to archived (reversible; the file stays and references remain
  valid). For a Milestone, \`--include-tasks\` atomically archives its active linked Tasks too.
- \`gitpm entity restore --draft <id> --type <type> --id <entity-id> [--include-tasks|--restore-milestone]
  [--project <id>] [--allow-delete]\` restores an archived entity after validating that its lifecycle
  references are active. For a Milestone, \`--include-tasks\` restores its archived linked Tasks; for
  a Task, \`--restore-milestone\` restores its archived Milestone in the same validated mutation.
- \`gitpm entity move --draft <id> --type task --id <entity-id> --to-project <id>
  [--to-milestone <id>] [--allow-delete] [--project <id>]\` relocates a task and its comments
  to another Project.
- \`gitpm schedule set --draft <id> ...\` and \`gitpm planning show|set --draft <id> ...\`
  update multi-track schedules and Project planning without replacing neighboring tracks.
- \`gitpm comment list|create|update|delete --draft <id> ...\` manages Task comments, and
  \`gitpm notification list --draft <id> [--person <id>]\` reads mention notifications.
- \`gitpm time-entry list|summary|create|replace|void --draft <id> ...\` manages actual effort.
- \`gitpm config show|update --draft <id> ...\` reads or transactionally updates repository
  configuration.
- \`gitpm schema list|show <type> [--example]\` exposes the installed schema contract.
- \`gitpm format [--draft <id>] [--project <id>] [--check] [--allow-delete]\` applies or checks canonical YAML.
- \`gitpm validate [--draft <id>] [--project <id>] [--changed] [--allow-delete]\` validates repository structure,
  schemas, identities, references, dates, and scope closure.
- \`gitpm diff --semantic [--draft <id>] [--project <id>] [--allow-delete]\` reports created, updated, archived,
  and deleted entities.
- \`gitpm changes list|restore-file|restore-hunk|discard-all --draft <id> ...\` inspects or
  explicitly restores uncommitted changes. Discard-all requires \`--confirm discard-all\`.
- \`gitpm history list|show|file-diff|file-history --draft <id> ...\` inspects Git history;
  \`history revert\` creates a separate external-mode draft.
- \`gitpm export --draft <id> --format <pdf|html|csv|xlsx|repository> [--locale <en|ru>] [--section <portfolio|project-plan|plan-fact|workload|vacations|person-profile|audit|projects|people|project-details|gantt>] [--include-git] [--output <path>]\`
  creates a read-only export whose default filename contains the HEAD commit date and short hash.
- \`gitpm commit --all --draft <id> -m <message> [--project <id>] [--allow-delete]\` validates and commits the
  complete draft. Partial staging is unsupported.
- \`gitpm push --draft <id>\` publishes a clean committed branch.
- \`gitpm mr create --draft <id> --owner <id> --title <title> [--description <text>]\` opens a
  Merge Request against the configured default branch; \`gitpm mr status\` reads its state.
- \`gitpm doctor\` checks runtime and repository readiness.
- \`gitpm --version\` reports the CLI version.

Do not invent syntax and do not fall back to editing YAML. The GUI file manager is intentionally
not an agent command: it is a raw filesystem interface that may temporarily bypass repository
validation. Use the domain commands above and report a product gap when no command exists.

For entity creation, keep the temporary input outside the worktree, inspect fields with
\`gitpm schema show\`, and never guess a reference or configuration slug. Omit \`id\` to let GitPM
generate it. For Person, omit \`calendar\` to materialize the repository default, or supply an
explicit active Calendar. A supplied valid ID is preserved and never silently replaced. For
updates, prefer repeatable \`--set\`/\`--unset\` for a few top-level fields; use \`--file\` for a
larger YAML patch. Read the current entity first, and verify the resulting semantic fields.

## Scope the work

Use \`--project <project-id>\` on a mutation whenever that mutation concerns one Project. The
flag constrains only the paths planned by that command; unrelated uncommitted changes do not
block it or authorize the command to change them. Scoped format, semantic diff, and changes
inspection select that Project's changes, while validation still checks the complete repository.

If one request explicitly combines a global entity with Project data, such as creating a Person
and assigning it to a Task, create the global entity without \`--project\`, mutate the Task with
\`--project\`, then run the final format, validation, semantic diff, and any user-authorized
commit without \`--project\` so the complete combined change is reviewed together. Do not make
an intermediate commit. A scoped \`commit --all --project <project-id>\` remains strict and fails
if the draft also contains global changes or changes to another Project.

Existing changes to global configuration, People, Teams, Calendars, Availability Events,
guidance files, or another Project must not be treated as permission to widen the current
mutation. Ask the user if the requested outcome itself truly requires those changes.

Physical deletion is distinct from archive. \`gitpm entity delete\` removes the entity file and
requires \`--allow-delete\`; use \`--dry-run\` first to preview reference restrictions. Repeat
\`--allow-delete\` for every subsequent mutation, format, validation, semantic diff, and commit
while the deletion is present. The flag confirms the current deletion set; it does not create
additional deletions.
\`gitpm entity archive\` sets lifecycle to archived without removing the file. Reference and
repository validation still apply to both.

## Verify every supported mutation

Run, in order:

\`gitpm format --draft <draft-id> [--project <project-id>] [--allow-delete] --json\`

\`gitpm validate --changed --draft <draft-id> [--project <project-id>] [--allow-delete] --json\`

\`gitpm diff --semantic --draft <draft-id> [--project <project-id>] [--allow-delete] --json\`

Check the process exit code, \`ok\`, stable \`code\`, affected Projects, entity counts, fields,
and unclassified files. Stop on any unexpected path, scope, deletion, warning requiring user
judgment, or semantic result that differs from the request. Do not hide failures by reformatting
or retrying with broader scope. For an explicitly combined global-and-Project request, omit
\`--project\` from this final verification sequence and review the complete result.

## Commit and publish deliberately

Do not commit unless the user explicitly requests a commit. A request to create, update, archive,
move, or delete GitPM data is not commit authorization. After validation and semantic diff, stop
and report the uncommitted result unless the user explicitly requested a commit.

When the user explicitly requests a commit, commit only after the semantic result matches the
user's intent:

\`gitpm commit --all --draft <draft-id> -m <message> [--project <project-id>] [--allow-delete] --json\`

This intentionally stages all validated draft changes; partial staging is not supported. Do not
substitute raw Git commands. Use \`--project\` on commit only when every change in the draft belongs
to that Project; otherwise review and commit the complete authorized change without it.

Run \`gitpm push --draft <draft-id> --json\` and \`gitpm mr create ... --json\` only when the
user requested remote publication. Never expose an access token in arguments, URLs, files, Git
configuration, logs, or responses.

## Report errors, ambiguity, and improvement opportunities

Never silently work around an error, ambiguous contract, inconsistent output, unsafe default,
missing command, or unclear repository state. Separate a data problem from a runtime problem
and a GitPM product problem. Report:

1. Goal: the user outcome and operation that is blocked.
2. Evidence: the sanitized command, exit code, stable GitPM code, and minimal relevant output.
3. Diagnosis: observed behavior versus expected behavior and the likely problem category.
4. Impact: what cannot be completed safely and whether any draft changes were made.
5. GitPM improvement: one concrete product change, for example a missing CLI verb, generated ID,
   clearer validation path, machine-readable diagnostic field, safer transaction, or clarified
   documentation.
6. Next decision: the smallest user choice or external fix needed to continue.

Do not patch the GitPM application from inside the managed portfolio draft. Product feedback is
an explicit handoff to the user, not authorization for an improvised workaround or broader work.
`;
