# GitPM progress

Current phase: `P02_in_progress`
Implementation code: P00, P00S and P01 complete; P02 parser/formatter/validation/calendar implemented

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

## Current blockers

None. P02 is in progress.

## Next action

Integrate P02 format, validate, semantic diff skeleton and doctor commands into CLI and record VFY-005/VFY-006 evidence.

## Evidence policy

Detailed stage and check status is maintained only in `GitPM_Execution_Status_v0.1.yaml`. This file records decisions and next action, not duplicate checklists.
