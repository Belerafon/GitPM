# GitPM source development instructions

This repository contains the GitPM application source code. Work here as a software developer,
not as an agent managing a GitPM portfolio draft.

Do not confuse this file with the runtime `AGENTS.md` generated inside an external draft
worktree. The runtime file tells an agent to mutate portfolio data only through `gitpm`; this
source-development file authorizes normal, scoped source edits and requires the repository's
build and test workflow. The GitPM runtime skill must not be installed at
`.agents/skills/gitpm/` in this source root. Its generated content lives in
`packages/drafts/src/worktree-guidance.ts` and is materialized only in draft worktrees.

## Product philosophy

GitPM is a Git-first project-management system. Git repositories hold the durable business
state; YAML is human-readable and reviewable; draft worktrees isolate writes; the CLI and web UI
share the same domain, validation, security, and publishing rules. There is no business database,
separate agent API, or MCP mutation path.

Preserve these principles when changing the product:

- one immutable entity ID and one canonical path per entity;
- one writer mode per draft, with optimistic fingerprints and explicit ownership;
- full repository validation before commit or publication;
- semantic changes and stable machine-readable error codes over text-only behavior;
- Project scope must not silently widen to global entities or another Project;
- archive and physical deletion remain distinct, with delete-restrict and explicit confirmation;
- credentials remain in process memory and never enter URLs, Git config, arguments, files, or logs;
- CLI JSON remains locale-neutral while human-facing UI and CLI use locale packs;
- agents use the CLI and must report product gaps instead of editing portfolio YAML directly.

## Repository map

- `apps/cli` — the `gitpm` command surface and process entrypoint.
- `apps/server` — HTTP API, runtime wiring, auth, and repository publication.
- `apps/web` — React UI and locale packs.
- `packages/agent` — shared direct/external CLI workflow, external-draft adapter, and generated worktree guidance.
- `packages/drafts` — draft metadata, writer modes, worktrees, fingerprints, and recovery.
- `packages/domain` — entity and comment operations.
- `packages/contracts` — shared HTTP DTOs and browser-side runtime response decoders.
- `packages/repository-format` — strict YAML parsing and canonical formatting.
- `packages/validation` — schemas, paths, identities, references, dates, and repository rules.
- `packages/git-client`, `packages/gitlab`, `packages/security`, `packages/changes`, and
  `packages/publishing` — controlled Git, remote protocol, filesystem boundaries, diffs, and
  publication.
- `schemas/v1` — JSON Schema 2020-12 contracts.
- `fixtures/schema-v1/demo` and `demo/portfolio` — deterministic test and user-facing examples.
- `docs` — normative architecture, format, workflow, security, planning, and operations material.

The main normative references are `docs/GitPM_Implementation_Plan_v0.7.md`,
`docs/GitPM_Repository_Format_v1.md`, `docs/GitPM_Agent_Workflow_v1.md`, `docs/CLI.md`, the
delivery/security policies, and the JSON schemas. When code and documentation disagree, identify
the conflict and resolve it explicitly rather than choosing one silently.

## Development environment

Use Node.js 20.19.2, pnpm 10.12.1 through Corepack, and Python 3.11 with PyYAML for planning
validators.

Common commands:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm schema:verify
corepack pnpm planning:verify
corepack pnpm verify
```

Use the narrowest relevant build and Vitest files while iterating, then widen verification in
proportion to risk. Build workspace dependencies before tests when package imports resolve from
`dist`.

## Temporary files

Keep all throwaway files (generator scripts, scratch output, experiments) inside the active
working directory (the worktree), never in an external or system temp location. Use a single
scratch folder named `.tmp/` at the worktree root; create it if it does not already exist, and
add it to `.gitignore` immediately so scratch files are never staged or committed. Node scripts
placed there resolve workspace `node_modules` correctly, which an external temp path does not.

## Git worktree policy

For each new task, create a separate branch and a separate git worktree.

Main repository:

`D:\other_projects\GitPM`

Directory for all worktrees of this repository:

`D:\other_projects\GitPM-worktrees`

Rules:

1. Do not make changes directly in the main working tree
   `D:\other_projects\GitPM`.

2. Create worktrees only under the pattern:

   `D:\other_projects\GitPM-worktrees\<task-slug>`

3. Never create a worktree next to the main repository under the pattern:

   `D:\other_projects\GitPM-*`

4. Use a short task name in kebab-case for the directory name.
   Replace "/" characters from the branch name with "-".

   Example:

   ```
   branch:    feature/project-group-editor
   directory: D:\other_projects\GitPM-worktrees\feature-project-group-editor
   ```

5. Before creating a worktree, check existing worktrees:

   ```
   git -C D:\other_projects\GitPM worktree list
   ```

6. If the branch does not exist yet, create it together with the worktree:

   ```
   git -C D:\other_projects\GitPM worktree add -b <branch-name> <worktree-path> <base-branch>
   ```

7. If the branch already exists:

   ```
   git -C D:\other_projects\GitPM worktree add <worktree-path> <branch-name>
   ```

8. Run all commands, edits, builds, and tests inside the created worktree.

9. Upon completing the task, commit all work to the worktree branch before handing off.
   First inspect `git status`, `git diff`, and recent `git log`, stage only intended files,
   and never commit secrets. Do not leave uncommitted changes behind. Committing the branch
   is required without asking for separate confirmation; running the local quality gate below
   and writing a concise handoff summary happen alongside this commit. Pushing still requires
   a separate explicit user instruction.

10. After the completion commit succeeds, end the handoff with one combined confirmation:
    `Merge <branch> into main and remove worktree <worktree-path>, keeping the branch?`
    A reply of `Yes` (or its direct equivalent in the conversation language) authorizes both
    the local merge into `main` and removal of that worktree. Do not perform either action before
    that confirmation. Do not delete the branch as part of this cleanup; branch deletion requires
    a separate explicit user instruction.

## Impact-based local quality gate

This repository intentionally has no hosted GitHub Actions workflow, so local verification remains
a required delivery contract. The contract is evidence proportional to the change, not an
automatic run of every test. Before committing, inspect changed paths and imports, identify the
producer and consumer boundaries that can change, and run every affected thematic profile:

- `verify:web` — React UI, styles, browser-side models and API client;
- `verify:server` — HTTP routes, auth, repository runtime and stores;
- `verify:cli` — CLI parsing, commands and direct/external workflows;
- `verify:repository` — contracts, domain, repository format, validation, shared identities and
  task hierarchy, including schema verification;
- `verify:planning-domain` — calendar, scheduling, time-entry and workload logic;
- `verify:workflow` — agent, changes, drafts, Git/GitLab, history, logging, publishing and security;
- `verify:export` — document and PDF export;
- `verify:tooling` — repository scripts and planning validators;
- `verify:e2e-ui` and `verify:e2e-workflow` — browser coverage, added only when the affected
  behavior crosses a browser boundary;
- `verify:guidance` — text-only direct/worktree agent guidance changes.

For example, a local background color, spacing, or button-size change normally requires
`corepack pnpm verify:web`, not server, Git, schema, or all Playwright tests. Add `verify:e2e-ui`
only if the change can affect geometry assertions, navigation, persistence, or browser-only
interaction. A shared DTO or repository-format change requires `verify:repository` plus each
public consumer profile whose behavior can change. Multiple profiles may be required; do not hide
cross-boundary impact by selecting only the directory containing the edit.

Each thematic profile performs a frozen install, builds the relevant dependency closure, lints
the owned sources, runs the thematic tests, and checks whitespace. Documentation-only changes may
use `git diff --check` with careful diff review; add a thematic profile when documentation changes
an executable contract or generated example. The detailed ownership map and selection examples
are in `docs/Test_Verification_Strategy.md`.

Use the complete `corepack pnpm verify:local` only for release candidates or changes whose impact
cannot be bounded confidently, such as root dependency/lockfile changes, root TypeScript,
Vitest, Playwright, or build configuration, verification orchestration, and broad refactors across
most groups. It is an escalation path, not the default for every source, test, or mixed-scope
change.

The verification runner prints each command, PID, timeout, 30-second heartbeat, per-step result,
and final timing summary. Vitest uses half of the available logical CPUs, capped at four workers;
override it with `GITPM_TEST_WORKERS` only for diagnosis. Playwright stays at one worker because
its files share repository servers and polling state. Do not overlap browser profiles from
multiple worktrees because their ports are fixed. Override heartbeat or step timeout with
`GITPM_VERIFY_HEARTBEAT_SECONDS` or `GITPM_VERIFY_TIMEOUT_MINUTES`.

If a selected profile cannot run, do not describe the work as verified: report the exact failing
or skipped command and reason. The handoff must state the impact analysis and every profile or
narrower diagnostic command actually run.

## Change rules

- Inspect existing code, tests, schemas, and normative docs before changing a contract.
- Keep changes scoped; preserve unrelated user modifications in a dirty worktree.
- Use `apply_patch` for source edits. Do not edit generated `dist` files.
- Treat CLI command names, flags, JSON fields, and error codes as public automation contracts.
- Add or update tests for successful behavior, stable failures, scope, security boundaries, and
  UTF-8 content when relevant.
- Update docs and examples whenever behavior or a public contract changes.
- Do not weaken path containment, symlink defenses, credential handling, validation, or explicit
  delete authorization to make a test pass.
- Do not add a parallel agent API or instruct agents to bypass the CLI.
- Keep root source-development instructions separate from draft runtime guidance.

When changing draft guidance, update `packages/drafts/src/worktree-guidance.ts`. Verify that every
draft creates or restores `AGENTS.md` and `.agents/skills/gitpm/SKILL.md`, that the
content describes the actual installed CLI, and that runtime guidance is excluded from business
scope, semantic diff, commits, push clean checks, and Merge Requests.

## Errors and ambiguity

If requirements, code, schemas, or docs conflict, report the evidence and the consequence. State
the smallest safe interpretation used, or ask the user when alternatives materially change the
product. When a defect or awkward agent workflow is found, describe a concrete GitPM improvement
instead of hiding it with a test-only special case or undocumented workaround.

Before handing off, summarize changed contracts, list verification actually run, and call out any
remaining limitation. The completion commit is mandatory under rule 9. Do not push or open a
Merge Request unless the user asks. Merge into `main` and worktree removal follow the combined
confirmation in rule 10; keep the branch unless the user separately asks to delete it.
