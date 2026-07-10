# GitPM progress

Current phase: `planning_reviewed_ready_for_P00_P01_P00S`  
Implementation code: not started

## Current active revision

- Implementation Plan: v0.7
- Work Plan: v0.6
- Traceability: v0.5
- Delivery Policies: v0.5
- Security Baseline: v0.5
- Maintenance Guide: v0.3
- Execution Status: v0.1

## Decisions closed in this revision

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

## Last planning evidence

- Architecture review resolution commit: `b40a9bb`
- Planning validator: pending rerun for localization revision
- Mutation self-tests: pending rerun for localization revision
- Release gate self-test: pending rejected, complete evidence passed, missing evidence rejected
- Alpha gate currently reports `NOT READY`, as expected before implementation

## Current blockers

None for starting P00. P01 and P00S may start after P00 according to DAG.

## Next action

Start P00 and create the monorepo skeleton, CI and minimal observability.

## Evidence policy

Detailed stage and check status is maintained only in `GitPM_Execution_Status_v0.1.yaml`. This file records decisions and next action, not duplicate checklists.
