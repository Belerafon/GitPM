# GitPM source development instructions

This repository contains the GitPM application source code. Work here as a software developer,
not as an agent managing a GitPM portfolio draft.

Do not confuse this file with the runtime `AGENTS.md` generated inside an external draft
worktree. The runtime file tells an agent to mutate portfolio data only through `gitpm`; this
source-development file authorizes normal, scoped source edits and requires the repository's
build and test workflow. The GitPM runtime skill must not be installed at
`.agents/skills/gitpm/` in this source root. Its generated content lives in
`packages/agent/src/worktree-guidance.ts` and is materialized only in draft worktrees.

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
- `packages/agent` — external-agent draft workflow and generated worktree guidance.
- `packages/drafts` — draft metadata, writer modes, worktrees, fingerprints, and recovery.
- `packages/domain` — entity and comment operations.
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

When changing draft guidance, update `packages/agent/src/worktree-guidance.ts`. Verify that an
external draft creates or restores `AGENTS.md` and `.agents/skills/gitpm/SKILL.md`, that the
content describes the actual installed CLI, and that runtime guidance is excluded from business
scope, semantic diff, commits, push clean checks, and Merge Requests.

## Errors and ambiguity

If requirements, code, schemas, or docs conflict, report the evidence and the consequence. State
the smallest safe interpretation used, or ask the user when alternatives materially change the
product. When a defect or awkward agent workflow is found, describe a concrete GitPM improvement
instead of hiding it with a test-only special case or undocumented workaround.

Before handing off, summarize changed contracts, list verification actually run, and call out any
remaining limitation. Do not commit, push, or open a Merge Request unless the user asks.
