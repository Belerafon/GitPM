# GitPM impact-based test strategy

## Why the suite is grouped

The complete local gate is intentionally expensive: it builds the whole monorepo, runs every
Vitest file, starts both browser repository modes, and performs schema, security, smoke, and
planning checks. That is useful before a release or after a cross-cutting infrastructure change,
but it is not the default proof for every source edit.

The September 2026 audit found 108 Vitest files and 11 Playwright files. Every Vitest file belongs to
one of the non-overlapping source groups below. The directory-based commands automatically include
new tests added under the same ownership boundary.

| Group | Current files | Scope | Command |
| --- | ---: | --- | --- |
| Web | 58 | React UI, styles, browser-side models and API client; shared scheduling regression scan | `corepack pnpm test:web` |
| Server | 12 | HTTP routes, auth, repository runtime and stores | `corepack pnpm test:server` |
| CLI | 4 | CLI parsing, commands and direct/external workflows | `corepack pnpm test:cli` |
| Repository | 10 | contracts, domain, repository format, validation, shared identities and task hierarchy | `corepack pnpm test:repository` |
| Planning domain | 5 | calendars, scheduling, time entries and workload; shared scheduling regression scan | `corepack pnpm test:planning-domain` |
| Git workflow | 11 | agent, changes, drafts, Git/GitLab, history, logging, publishing and security | `corepack pnpm test:workflow` |
| Export | 2 | document/PDF export | `corepack pnpm test:export` |
| Tooling | 6 | repository scripts, verification runner and scheduling regression scan | `corepack pnpm test:tooling` |

Playwright is split by observable boundary rather than source owner:

| Group | Current files | Scope | Command |
| --- | ---: | --- | --- |
| Browser UI | 5 | application UI, Gantt, file changes, geometry and schedule preservation | `corepack pnpm e2e:ui` |
| Browser workflow | 6 | proxy, lifecycle audit, persistence, repository-mode parity, semantic writes and startup races | `corepack pnpm e2e:workflow` |

`corepack pnpm test` and `corepack pnpm e2e` remain the complete Vitest and Playwright commands.

## Selecting the delivery check

Before committing, inspect the changed paths and imports, then record which producer and consumer
boundaries can change. Run every affected profile; there is no requirement to select exactly one.
Each `verify:*` profile performs a frozen install, builds the relevant package dependency closure,
lints its source boundary, runs its thematic tests, and checks whitespace. The web profile also
typechecks the Vite application; repository and workflow add their schema or security checks.

| Change impact | Required starting profile | Add when applicable |
| --- | --- | --- |
| CSS, spacing, color, local component markup | `corepack pnpm verify:web` | `verify:e2e-ui` only for navigation, geometry, persistence, or a browser-only interaction |
| Server route/runtime | `corepack pnpm verify:server` | repository, workflow, web, or browser workflow when its contract crosses those boundaries |
| CLI behavior | `corepack pnpm verify:cli` | workflow or repository when command semantics use those packages |
| YAML/DTO/domain validation | `corepack pnpm verify:repository` | server, CLI, web, or export for changed public consumers |
| Scheduling/calendar/workload/time entry logic | `corepack pnpm verify:planning-domain` | web/server and UI E2E when presentation or transport also changes |
| Draft/Git/publish/security/history behavior | `corepack pnpm verify:workflow` | CLI/server and workflow E2E for changed entrypoints or persisted behavior |
| Export rendering | `corepack pnpm verify:export` | server or web when export endpoints/UI change |
| Scripts or planning validators | `corepack pnpm verify:tooling` | the profile whose pipeline or generated artifact is changed |
| Generated agent guidance only | `corepack pnpm verify:guidance` | none unless executable behavior also changed |
| Documentation only | `git diff --check` | a thematic profile if the document changes an executable contract or generated example |

Impact analysis follows dependencies in both directions. A low-level producer change needs its own
profile plus profiles for public consumers whose behavior can change. A local CSS token does not
affect server, Git, schema, or Playwright workflow tests; a shared DTO usually does.

Use `corepack pnpm verify:local` for release candidates and changes whose impact cannot be bounded
confidently, including root dependency/lockfile changes, root TypeScript/Vitest/Playwright/build
configuration, verification orchestration, or broad refactors spanning most groups. It is an
available escalation path, not the default response to a mixed-scope change.

`corepack pnpm verify:changed` conservatively derives profiles from changes against `main` (or
`GITPM_VERIFY_BASE`) and runs the frozen install once. Review its printed file/profile selection;
unknown root files and changes to build or verification configuration deliberately escalate to the
complete gate.

## Expensive-gate recovery and machine load

Every runner invocation writes an incremental JSON report under `.tmp/verification-reports/` and
updates a per-profile checkpoint under `.tmp/verification-checkpoints/`. The report records each
command, outcome, duration, average host CPU use, free memory and the source snapshot. After a
failure, repair the cause and run `corepack pnpm verify:resume`. Previously successful stages are
reused only when their inputs are unchanged; for example, an E2E-only repair reruns lint,
typecheck and Playwright without rebuilding or repeating the complete Vitest suite. `--resume` is
explicit because it relies on build artifacts retained from the failed invocation.

Use `corepack pnpm verify:local:low-impact` when the computer must remain interactive. It limits
Vitest to two workers while keeping Playwright at its required single worker. This mode trades
wall-clock time for lower contention and records the selected worker counts in the JSON report.

All repository Playwright scripts acquire one lock in the shared Git directory, so browser suites
from different worktrees wait instead of colliding on fixed ports. Local Playwright stops after the
first failure by default to avoid timeout cascades; set `GITPM_E2E_MAX_FAILURES=0` only when a full
failure inventory is specifically needed. The lock wait can be bounded with
`GITPM_E2E_LOCK_TIMEOUT_MINUTES`.

If a selected profile cannot run, report the exact failed or skipped command. In the handoff, list
the impact analysis and every profile or narrower diagnostic command actually run; do not claim
coverage from tests that were not executed.
