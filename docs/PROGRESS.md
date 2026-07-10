# GitPM progress

Current phase: `P00_implementation_complete_pending_CI_acceptance`
Implementation code: P00 foundation implemented

## Current active revision

- Implementation Plan: v0.7
- Work Plan: v0.7
- Traceability: v0.5
- Delivery Policies: v0.5
- Security Baseline: v0.5
- Maintenance Guide: v0.3
- Execution Status: v0.1

## Decisions closed in this revision

- Work stages require regular independently verifiable commits after every completed work package and before planned pause or handoff.
- Stage evidence records the implementing commit SHA or commit-series range.
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
- Alpha gate currently reports `NOT READY`, as expected before implementation

## Current blockers

P00 implementation has no code blocker. Stage completion still requires a clean-Linux CI job URL and ARCH/QA acceptance; P01 and P00S remain behind that gate.

## Next action

Run the new CI workflow on a remote, record its URL, obtain ARCH/QA acceptance and close P00. Then start P01 and P00S according to the DAG.

## Evidence policy

Detailed stage and check status is maintained only in `GitPM_Execution_Status_v0.1.yaml`. This file records decisions and next action, not duplicate checklists.
