import { lstat, mkdir, readFile } from "node:fs/promises";
import { atomicWriteDomainFile, resolveDomainPath } from "@gitpm/security";
import { GITPM_AGENT_FILE, GITPM_SKILL_FILE, WorktreeGuidanceError } from "./worktree-guidance.js";

export interface DirectGuidanceInfo {
  readonly checkoutPath: string;
  readonly branch: string;
  readonly remoteUrl?: string;
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

export function gitPmDirectAgentFile(info: DirectGuidanceInfo): string {
  return `# GitPM direct-mode agent instructions

This working copy is the GitPM managed checkout in \`direct\` repository mode. Read and
follow \`.agents/skills/gitpm/SKILL.md\` before doing any GitPM work. GitPM manages this
file and the skill; do not edit or delete them.

This is the portfolio-data runtime contract, not the GitPM source-development \`AGENTS.md\`.
Do not edit or patch the GitPM application from this checkout.

## Active checkout

- Repository mode: \`direct\`
- Checkout path: \`${info.checkoutPath}\`
- Active branch: \`${info.branch}\`
- Remote: ${info.remoteUrl ?? "(none — push is disabled until a remote is configured)"}

In \`direct\` mode GitPM works in one ordinary Git working copy. There is no draft, no
draft branch, no worktree, no writer-mode handoff, and no Merge Request. Commits go
straight onto the active branch (by default \`main\`); push publishes the active branch
to \`origin\` with a fast-forward only.

## Product philosophy

GitPM is Git-first project management. The repository is the source of truth, YAML is the
portable human-readable representation, and this working copy is the single unit of change.
There is no separate agent database or agent API. The CLI is the supported policy and safety
boundary around repository mutations; bypassing it can violate identity, references, scope,
validation, deletion, and publishing rules.

The guidance files are local runtime material for this checkout. GitPM keeps them out of the
business diff, commits, and pushes; their presence does not widen the requested business change.

Work conservatively:

- understand current state before changing it;
- preserve immutable IDs and explicit references;
- limit work to the requested Project whenever possible;
- validate the complete repository and review the semantic diff;
- commit the complete change atomically through GitPM;
- publish only when the user explicitly requests it;
- prefer a clear blocker over a guessed command or a hidden manual edit.

## Mandatory operating rules

- Use the \`gitpm\` CLI for every mutation, format, validation, semantic diff, commit, and push.
- Never edit, rename, or delete files under \`.gitpm/\`, \`people/\`, \`teams/\`,
  \`calendars/\`, or \`projects/\` directly.
- Never use raw \`git add\`, \`git commit\`, \`git push\`, Git hosting APIs, MCP, or UI API
  calls to mutate GitPM data.
- Reading repository files and using read-only Git commands for orientation is allowed.
- Prefer \`--json\`; evaluate both the process exit code and the stable GitPM result code.
- Never place credentials in arguments, repository URLs, files, Git configuration, logs, or
  responses.
- If the installed CLI has no command for a requested mutation, stop and report the missing
  capability. Do not bypass the CLI.

## User-supplied uploads

The \`uploads/\` directory at the repository root is a working area for incoming
documents (for example, \`.docx\`, \`.xlsx\`, \`.pdf\` reports) that you read but never
import verbatim into the GitPM data store. \`uploads/\` is listed in
\`allowed_top_level_directories\` and ignored by the root \`.gitignore\`, so:

- read, parse, and convert these files freely;
- never copy their bytes into \`projects/\`, \`people/\`, \`teams/\`, \`calendars/\`,
  or \`.gitpm/\`;
- never \`git add\` or commit anything under \`uploads/\`;
- never delete or rename files under \`uploads/\` unless explicitly requested.

When asked to seed or update GitPM data from such a document, convert it to a
textual form (for example via \`markitdown\` or \`pandoc\`), extract the relevant
fields, and use \`gitpm entity create\` / \`gitpm entity update\` /
\`gitpm entity import\` with a temporary YAML/CSV/JSONL file outside this checkout.

## CLI workflow (direct mode)

Direct-mode commands do not need \`--draft\`. Start with:

\`gitpm --version\`

\`gitpm status --json\`

For supported entity creation, supply a YAML mapping from a temporary path outside this checkout.
Use \`--type\` when schema is omitted; GitPM generates a missing ID and applies documented defaults:

\`gitpm entity create --type <type> --file <temporary-yaml> [--project <project-id>] --json\`

Update one or more fields without a temporary file by repeating \`--set\`; use \`--unset\` to
remove an optional field:

\`gitpm entity update --type <type> --id <entity-id> --set <field>=<yaml-value> [--set ...] [--unset <field>] [--project <project-id>] --json\`

Inspect fields with \`gitpm schema show <type> --json\`. For bulk creation, use \`gitpm entity
import --type <type> --format <csv|yaml|jsonl> --file <file>\`, first with \`--dry-run\` and then
without it.

Then run \`format\`, \`validate --changed\`, and \`diff --semantic\` with \`--json\` and
\`--project\` when scoped. Commit with \`gitpm commit --all\`. Use \`gitpm push\` only when
publication was requested. There is no \`mr\` command in direct mode.

## Errors, ambiguity, and product feedback

Do not silently work around a GitPM error, unclear contract, inconsistent output, missing CLI
operation, or ambiguous repository state. Tell the user:

1. what operation is blocked and what you were trying to achieve;
2. the exact sanitized command, exit code, and stable GitPM error code;
3. what was observed and what behavior was expected;
4. whether the likely cause is repository data, runtime configuration, or a GitPM product gap;
5. a concrete improvement GitPM should make.

Ask the user before expanding scope or changing intent. Do not patch the GitPM application from
inside this managed portfolio checkout.
`;
}

export const GITPM_DIRECT_SKILL_FILE_CONTENT = `---
name: gitpm
description: Operate a GitPM project-management checkout in direct repository mode through the GitPM CLI. Use for understanding GitPM repository data, creating and updating supported entities, validating and formatting changes, viewing semantic diffs, committing to the active branch, pushing to origin, and diagnosing GitPM errors or ambiguous behavior. Enforces CLI-only mutation and requires actionable product feedback instead of workarounds.
---

# Work with a GitPM direct-mode checkout

## Understand the philosophy

Treat GitPM as a Git-first system, not as a collection of YAML files. Git is the history and
publishing protocol; YAML is the reviewable storage format; this working copy is the single unit
of change; the CLI is the mutation and policy boundary. Correct work preserves all four.

\`AGENTS.md\` and this skill are local runtime guidance. GitPM keeps them out of the business diff,
commits, and pushes.

Do not confuse this runtime skill with source development of the GitPM application. If the current
directory is the GitPM monorepo rather than the \`checkout path\` reported by \`gitpm status\`, stop:
the root source-development \`AGENTS.md\` applies there and this skill does not.

Apply these principles:

- Repository truth over hidden state: do not create side databases or private shadow files.
- Explicit workflow over convenience: validate, review, commit all, and publish deliberately.
- Semantic intent over textual patches: use semantic diff and stable entity IDs.
- Safety over improvisation: stop when the CLI cannot express the requested operation.
- Useful transparency over silent recovery: surface errors and propose improvements to GitPM.

## Know the model

The repository-wide documents are \`.gitpm/repository.yaml\`, \`.gitpm/statuses.yaml\`, and
\`.gitpm/issue-types.yaml\`. Global entity directories are \`people/\`, \`teams/\`, and
\`calendars/\`. A Project occupies \`projects/<P-id>/\` and contains \`project.yaml\`, plus
\`milestones/\`, \`tasks/\`, \`views/\`, and task-scoped \`comments/\`.

IDs are immutable and have the form \`<type>-<UTC-year>-<six Crockford Base32 characters>\`.
Type prefixes are \`P\` Project, \`T\` Task, \`M\` Milestone, \`U\` Person, \`G\` Team,
\`C\` Calendar, and \`V\` Saved View. Do not rename IDs or move an entity by changing its
path. References must resolve, task/milestone/view references cannot cross Project boundaries,
and active configuration slugs must exist. Dates are \`YYYY-MM-DD\`; estimates are nonnegative
quarter-hour multiples. YAML uses UTF-8, LF, two-space indentation, no duplicate keys, aliases,
anchors, or custom tags.

Read YAML only to understand state or prepare a temporary create input or update patch. Never
mutate domain files directly.

## Establish the direct-mode context

1. Read \`AGENTS.md\`; take the checkout path and active branch from it.
2. Run \`gitpm --version\`.
3. Run \`gitpm status --json\`.
4. Confirm the reported \`mode: direct\`, the checkout path, and the active branch.

Direct mode has no draft id, writer mode, or Merge Request. Do not look for or create a draft.

## Respect the mutation boundary

Never write, rename, or delete data below \`.gitpm/\`, \`people/\`, \`teams/\`, \`calendars/\`, or
\`projects/\` with an editor, shell redirection, scripts, filesystem tools, raw Git, an MCP server,
or a private API call. Never modify \`AGENTS.md\` or this skill; GitPM manages them.

Read-only inspection of repository data and read-only Git commands is allowed. Every state change
must be attributable to a documented \`gitpm\` command.

## Use the supported CLI surface (direct mode)

All commands accept \`--json\`; use it for automation. Direct-mode commands do not take \`--draft\`.

- \`gitpm status\` reports mode, checkout path, active branch, HEAD commit, dirty state, and
  ahead/behind versus origin.
- \`gitpm entity create --type <type> --file <file> [--project <id>]\` creates an entity from a
  YAML mapping, generating a missing ID and applying documented defaults.
- \`gitpm entity update --type <type> --id <entity-id> [--file <yaml-patch>]
  [--set <field>=<yaml-value>]... [--unset <field>]... [--project <id>]\` transactionally patches
  any supported entity type. Inline values use YAML scalar/collection types; \`--unset\` removes
  an optional field. Identity, schema, and owning Project are immutable.
- \`gitpm entity import --type <type> --format <csv|yaml|jsonl> --file <file> [--dry-run]\`
  atomically validates and creates a batch.
- \`gitpm schema list|show <type> [--example]\` exposes the installed schema contract.
- \`gitpm format [--project <id>] [--check]\` applies or checks canonical YAML.
- \`gitpm validate [--project <id>] [--changed]\` validates repository structure, schemas,
  identities, references, dates, and scope closure.
- \`gitpm diff --semantic [--project <id>]\` reports created, updated, archived, and deleted
  entities.
- \`gitpm commit --all -m <message> [--project <id>]\` validates and commits every change onto the
  active branch.
- \`gitpm push\` fast-forward publishes the active branch to \`origin\`.
- \`gitpm doctor\` checks runtime and repository readiness.
- \`gitpm --version\` reports the CLI version.

There is no \`mr\` command in direct mode. The current CLI exposes entity creation and general
entity update, but not archive, physical delete, move, configuration update, or comment-specific commands. When the
request needs one of these, report the capability gap and recommend adding the corresponding CLI
operation. Do not invent syntax and do not fall back to editing YAML.

For entity creation, keep the temporary input outside the checkout, inspect fields with
\`gitpm schema show\`, and never guess a reference or configuration slug. Omit \`id\` to let GitPM
generate it. For Person, omit \`calendar\` to materialize the repository default, or supply an
explicit active Calendar. A supplied valid ID is preserved and never silently replaced. For
updates, prefer repeatable \`--set\`/\`--unset\` for a few top-level fields; use \`--file\` for a
larger YAML patch. Read the current entity first, and verify the resulting semantic fields.

## Scope the work

Use \`--project <project-id>\` whenever the request concerns one Project. Under Project scope, changes
to global configuration, People, Teams, Calendars, guidance files, or another Project must not be
treated as permission to widen scope. Ask the user if the requested outcome truly requires global
changes.

Physical deletion is distinct from archive. Even if a future CLI mutation creates a deletion,
verification and commit require explicit user intent plus \`--allow-delete\`; reference and repository
validation still apply.

## Verify every supported mutation

Run, in order:

\`gitpm format [--project <project-id>] --json\`

\`gitpm validate --changed [--project <project-id>] --json\`

\`gitpm diff --semantic [--project <project-id>] --json\`

Check the process exit code, \`ok\`, stable \`code\`, affected Projects, entity counts, fields, and
unclassified files. Stop on any unexpected path, scope, deletion, warning requiring user judgment, or
semantic result that differs from the request. Do not hide failures by reformatting or retrying with
broader scope.

## Commit and publish deliberately

Commit only after the semantic result matches the user's intent:

\`gitpm commit --all -m <message> [--project <project-id>] --json\`

This intentionally stages all validated changes onto the active branch; partial staging is not
supported. Do not substitute raw Git commands.

Run \`gitpm push --json\` only when the user requested remote publication. GitPM fetches first and
refuses non-fast-forward, force push, rebase, merge commit, hard reset, and stash. Never expose an
access token in arguments, URLs, files, Git configuration, logs, or responses.

## Report errors, ambiguity, and improvement opportunities

Never silently work around an error, ambiguous contract, inconsistent output, unsafe default, missing
command, or unclear repository state. Separate a data problem from a runtime problem and a GitPM product
problem. Report the goal, evidence, diagnosis, impact, a concrete GitPM improvement, and the next
decision needed to continue.

Do not patch the GitPM application from inside the managed portfolio checkout. Product feedback is an
explicit handoff to the user, not authorization for an improvised workaround or broader work.
`;

export async function provisionGitPmDirectGuidance(root: string, info: DirectGuidanceInfo): Promise<boolean> {
  await ensureDirectory(root, ".agents");
  await ensureDirectory(root, ".agents/skills");
  await ensureDirectory(root, ".agents/skills/gitpm");
  const changed = await Promise.all([
    writeGuidanceFile(root, GITPM_AGENT_FILE, gitPmDirectAgentFile(info)),
    writeGuidanceFile(root, GITPM_SKILL_FILE, GITPM_DIRECT_SKILL_FILE_CONTENT),
  ]);
  return changed.some(Boolean);
}
