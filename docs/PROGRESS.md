# GitPM progress

Current phase: `v0.1_release_accepted`
Implementation code: P00-P14 complete; Alpha, Beta, release candidate and release gates accepted

## Current active revision

- Implementation Plan: v0.7
- Work Plan: v0.8
- Traceability: v0.5
- Delivery Policies: v0.5
- Security Baseline: v0.5
- Maintenance Guide: v0.3
- Execution Status: v0.1

## Decisions closed in this revision

- Work stages require regular independently verifiable commits after every completed work package and before planned pause or handoff.
- Stage evidence contains only acceptance artifacts; Git history tracks implementation changes without duplicated metadata.
- Project path exception is explicit.
- Schema v1 baseline is a P01 exit artifact, not a draft.
- Bare clone, fetch-before-draft and exact base commit are defined.
- One writer mode per draft is mandatory.
- OAuth 2.0 Authorization Code with PKCE is the only login flow.
- Webhook is removed; UI polls GitLab API.
- Calendar model moves to P01-P02; late P11B is removed.
- Release checks use machine-readable execution status and evidence.
- Verification scenarios are categorized checks, not all browser E2E.
- No backup, rebase, quota engine, migration engine or MCP.
- Localization uses extensible locale packs; Russian is mandatory for v0.1 and English is the source fallback.
- External agent edits refresh open read-only UI through polling; changed fields receive a short, coalesced, non-flashing highlight with reduced-motion support.
- API and CLI JSON stay locale-neutral; user-authored repository content is not translated automatically.
- P00 closes on reproducible local verification and repository evidence; an external remote, clean-Linux CI run and ARCH/QA acceptance are not exit requirements.

## Last implementation evidence

- P00 implementation commit: `f347849`.
- P00 monorepo contains web, server, CLI, shared and logging workspaces.
- Pinned toolchain: Node.js 20.19.2 and pnpm 10.12.1 with a frozen lockfile.
- Local `corepack pnpm verify` passed clean build, lint, typecheck, 6 unit tests and health smoke.
- `/health/live` and `/health/ready` returned success; the response correlation ID appeared in structured logs.
- Evidence is recorded under `evidence/P00/`.

## Last planning evidence

- Localization planning revision commit: `abf001d`
- Planning validator: `20 stages, 32 verification checks, 33 requirements`
- Mutation self-tests: `15 mutations rejected`
- Release gate self-test: pending rejected, complete evidence passed, missing evidence rejected
- Alpha gate currently reports `NOT READY`, as expected while later alpha stages remain pending

## Last schema evidence

- JSON Schema 2020-12 baseline covers all seven entities and three repository configuration files.
- Repository path/reference rules are fixed in `GitPM_Repository_Format_v1.md`.
- Deterministic demo portfolio contains 14 YAML documents.
- VFY-004 rejects Project directory mismatch, cross-project dependency and invalid estimate with stable codes.

## Last security evidence

- Threat model and ADR fix browser, filesystem, Git process and OAuth boundaries before Git core.
- `@gitpm/security` provides strict branch/HTTPS URL validation, controlled Git environment and safe atomic domain writes.
- Six VFY-003 regressions cover injection, malicious inherited config, traversal, symlink swap and ASKPASS token transfer.
- Sanitized process inspection contains no token or absolute worktree path.

## Last P02 evidence

- Safe YAML parser and canonical formatter pass round-trip on 14 demo documents.
- Validation covers JSON Schema, path/ID, configuration and entity references, cycles, dates, archived warnings and delete restrict.
- Calendar utilities use UTC date-only operations, ISO weekdays and explicit holidays.
- CLI provides format/check, validate/changed, semantic diff skeleton, doctor and locale-neutral JSON output.
- Full verify passes 8 test files and 36 tests.

## Last P03 evidence

- Bare repository initialization and explicit fetch refspec use a controlled Git process.
- Draft creation fetches under a repository lock and records exact origin/default commit.
- Metadata, writer mode, fingerprint and blob revisions survive runtime restart.
- External edit, stale mutation, cleanup confirmation and orphan recovery return stable codes.
- P03 integration/fault suite adds 10 tests; full suite contains 46 tests.

## Last P04 evidence

- Draft lifecycle and entity REST contracts return stable errors with correlation IDs.
- HTTP integration creates and updates all seven editable entity types.
- Archive preserves a file; explicit delete removes it; referenced delete returns 409 without mutation.
- Maintainer-only configuration and static request/YAML limits are enforced without quota state.
- Full suite contains 13 test files and 56 tests.

## Last P05 evidence

- Changes API exposes Added, Modified and Deleted with unified diff and stable token.
- Modified/deleted file restore uses controlled HEAD content and atomic write.
- Selected reverse hunk preserves other hunks and rejects stale tokens.
- Unicode and CRLF diff cases pass; full suite contains 14 files and 60 tests.

## Last P06 evidence

- OAuth Authorization Code uses PKCE S256, one-time state and exact scopes.
- Sessions and access tokens live only in process memory; secure cookie carries only session ID.
- Role is refreshed before commit, push and MR; Reporter remains read-only.
- Commit-all/push creates the expected remote branch; MR create/poll matches sanitized test-double capture.
- Token leak scan is clean; full suite contains 17 files and 66 tests.

## Last P07 evidence

- React shell displays one configured repository, application navigation and multiple drafts without a repository selector.
- Draft context supports create/open/close/reopen/explicit cleanup and polls draft, changes, validation and MR status every 3 seconds.
- External writer mode displays a read-only contract; branch, dirty files and validation status remain visible.
- Version-controlled `en`/`ru` packs pass key, placeholder and no-HTML checks; locale persists through reload and updates root `lang`/`dir`.
- Browser-local VFY-018, lint, typecheck, build and the full 18-file/72-test suite pass.

## Last P08A evidence

- Owner-checked collection API lists Project, Milestone and Task read models with optional Project filtering.
- Core UI supports create, edit, archive and delete, plus Task filters, inline status edit and side-panel relationship editing.
- Status and issue type options come from repository configuration.
- Safe Markdown renders supported structure through React nodes; raw HTML is inert text.
- Browser-local VFY-019 records exactly three expected YAML paths and hides the archived Task from the active list.

## Last P08B evidence

- Administration UI covers Calendar weekdays/holidays, Person weekly capacity/calendar, Team membership and repository status/type packs.
- Person, Team and Calendar mutation routes now enforce Maintainer independently of UI visibility.
- Developer receives stable 403 `DRAFT_FORBIDDEN`; the domain store is not called.
- Repository settings expose statuses and issue types without server, GitLab or OAuth configuration.
- Browser-local VFY-020 records exactly five expected administrative paths and role-matrix screenshots.

## Last P09 and Alpha evidence

- Changes shows exact Added, Modified and Deleted diffs, with file and hunk restore actions.
- Semantic diff groups created, updated, archived and deleted entities and shows field values before and after.
- Commit dialog has a fixed commit-all scope and no staging selection; the accepted browser flow commits four fixture paths.
- Push, Merge Request creation and polling complete in the publishing test double with the expected branch payload.
- Russian localization and explicit Alpha limitations remain visible through the primary Changes-to-MR flow.
- Final clean verification passes 21 test files and 81 tests, smoke, schema, security and planning checks.

## Last P10 evidence

- Controlled Git history returns commit graph entries, exact commit/file detail, affected Projects and per-file history.
- Revert accepts only a commit reachable from current remote main and creates a separately named draft after a fresh fetch.
- `git revert --no-commit` leaves the inverse diff for the established commit-all workflow without rewriting HEAD; merge commits use parent 1.
- Conflict drafts are preserved in external writer mode; no rebase or built-in conflict-resolution action exists.
- Russian browser-local VFY-025 verified History, file history, separate revert draft and inverse Changes diff.
- Final clean verification passes 24 test files and 85 tests, smoke, schema, security and planning checks.

## Last P11A evidence

- Board columns come from repository status configuration and show active Tasks without swimlanes.
- Native and pointer drag update Task status through the existing optimistic domain API.
- Project, status and type filters persist in schema-v1 Saved Views with `kind: board` and `group_by: status`.
- Browser-local VFY-026 moved one Task to Done, reopened a Saved View and recorded exactly one Task YAML plus one View YAML.
- Read-only draft and role rules also apply to drag and Saved View mutation controls.
- Final clean verification passes 25 test files and 86 tests, smoke, schema, security and planning checks.

## Last P11C evidence

- Read-only Gantt uses the existing entity-list API and exposes no mutation controls.
- Active Tasks with both `start` and `due` render as inclusive date bars; undated and archived Tasks are excluded.
- Parent Tasks precede indented children, milestone due dates render as markers and dated `depends_on` references render as arrows.
- Browser-local VFY-027 matched five fixture bars, three dependency arrows and the Beta release milestone on 2026-07-08.
- Dragging the first bar changed no dates and produced no repository path mutation.
- Final clean verification passes 26 test files and 88 tests, smoke, schema, security and planning checks.

## Last P11D evidence

- `@gitpm/workload` splits each estimate equally between active assignees and distributes each share across that person's working dates.
- ISO-week allocation is compared with calendar-adjusted capacity; holidays proportionally reduce `weekly_capacity_hours`.
- Workload UI shows the Person-week matrix, utilization, overload state, formula explanations and deterministic exclusion counts.
- Browser-local VFY-028 matched three precomputed Person-week values in Russian and recorded no repository path mutation.
- Archived, undated, unestimated, unassigned and unavailable-assignee Tasks are excluded with visible reason counts.
- Final clean verification passes 28 test files and 91 tests, smoke, schema, security and planning checks.

## Last P12 evidence

- `@gitpm/agent` creates/opens external-mode drafts, enforces an optional Project scope and requires explicit delete authorization.
- CLI now supports draft status/writer mode, scoped format/changed validation/semantic diff, commit-all, push and MR creation with locale-neutral JSON.
- `GitPM_Agent_Workflow_v1.md` documents direct YAML editing, runtime configuration, token boundaries and the publish cycle.
- Draft polling exposes the current external fingerprint; open Core, Administration, Board, Changes, Gantt and Workload read-models reload without browser refresh.
- Changed fields are reconciled into one 1.8-second indication; consecutive writes coalesce, focus/scroll stay stable and reduced-motion uses a static marker.
- Agent-local and Russian browser-local VFY-029 passed scope/delete rejection and the valid branch/MR flow.
- Final clean verification passes 31 test files and 99 tests, smoke, schema, security and planning checks.

## Last P13A evidence

- Hostile repository Markdown, Git metadata and diffs remain inert; CSP, clickjacking and cross-site mutation controls are verified.
- Inherited hooks, filters, textconv and external diff commands do not execute; Git diff also disables textconv explicitly.
- OAuth state replay, session expiry and immediate role downgrade are rejected with stable codes.
- `ajv` and `yaml` were upgraded to patched versions; the final production audit reports 0 known vulnerabilities across 72 dependencies.
- Container scan is explicitly not applicable because v0.1 has no container build artifact and targets a local Node.js process with system Git.
- Focused security verification passes 7 files/18 tests; full clean verification passes 33 files/104 tests plus smoke, schema, security and planning checks.

## Last P13B evidence

- Deterministic temporary fixture contains 30 Projects, 30 People, 3000 Tasks and 3064 YAML documents.
- Three fresh-process runs per scenario produced medians of 1953.911 ms cold load, 149.307 ms mutation plus full validation and 812.672 ms semantic diff for 100 files.
- Cold RSS median is 100.848 MiB; all four v0.1 budgets pass.
- Server health survives process restart; draft metadata and a dirty completed write survive a fresh runtime without automatic cleanup.
- Incorrect cleanup confirmation is rejected and exact confirmed cleanup removes the closed dirty draft.
- Frozen install leaves the lockfile unchanged; final clean verification passes 33 test files/104 tests plus smoke, schema, security and planning checks.
- Measurements are an accepted local Windows smoke; runner metadata explicitly records that it is not the Linux reference profile.

## P14 release acceptance

- The Russian web UI was traversed through every mandatory workspace and representative validation/Git error states.
- Locale packs have complete key and placeholder parity, reject raw HTML, and a synthetic third locale renders from registry metadata without component changes.
- Russian date, decimal, duration and plural formatting passed; `lang=ru`, `dir=ltr` and the selected locale persist after reload.
- CLI remains locale-neutral by product-owner direction and passes an explicit UTF-8 Cyrillic round-trip test on Windows.
- Final clean verification passes 33 test files/107 tests plus smoke, schema, security and planning checks.
- The release gate passes all 20 stages and 32 verification checks.

## UX/UI global refactoring

- `GitPM_UX_UI_Global_Refactoring_Plan_v0.1.md` is active as of 2026-07-14.
- UX00 implementation, acceptance and handoff are complete in commit `4a4c816`: responsive navigation drawer, scroll/focus restoration, 1280 px People layout stabilization, destructive entity confirmations, distinct archive/delete styling and configured status titles are implemented and accepted.
- UX01 route groundwork is implemented: canonical parsing/serialization, History API navigation, direct section/Project/Task/commit links, Task status query restoration and route-aware Project selection in Board/Gantt.
- The responsive App Shell and navigation configuration are extracted from `App.tsx`; all 12 destinations are grouped into Planning, Team and Repository with complete English/Russian labels and active-item focus on drawer open.
- Route-aware breadcrumbs cover Project, Task, Board/Gantt Project and commit detail; the top bar now keeps only concise mode/role context and exposes the absolute repository path in expandable sidebar details.
- The full unit/integration suite passes 39 files and 149 tests; repository lint, web typecheck, production build and planning validation pass. The browser UI suite passes 8/8, including Back/Forward, direct Task deep link, selected Task reload and the UX00 viewport matrix.
- The UX00 Playwright flow reaches all 12 sections at 320, 390, 800, 1280 and 1920 px, checks restored focus and rejects page-level horizontal overflow against the actual document client width.
- Browser acceptance confirms the 320 px navigation drawer, the one-column 1280 px People layout and cancellation of permanent deletion; screenshots are stored under `evidence/ux00/`.

## Current blockers

None. P00-P14 and the v0.1 release gate are accepted.

## Next action

Commit the UX01 breadcrumbs/topbar package, then synchronize Board/saved-view filters with query state and run final UX01 acceptance.

## Evidence policy

Detailed P00–P14 release status is maintained in `GitPM_Execution_Status_v0.1.yaml`; UX/UI refactoring status is maintained in `GitPM_UX_UI_Global_Refactoring_Plan_v0.1.md`. This file records evidence, decisions and the next action without duplicating either checklist.
