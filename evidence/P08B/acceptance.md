# P08B acceptance

Date: 2026-07-10

## Outcome

P08B is accepted. The administration UI provides Calendar weekday/holiday editing, Person weekly capacity and calendar assignment, Team membership, and repository-defined status/issue-type editing. Person, Team and Calendar support create, edit, archive and delete actions.

Administrative controls are enabled only for an open UI-mode draft with a Maintainer session. Developer sees an explicit read-only warning and disabled mutation controls. Backend create/update/archive/delete routes independently enforce Maintainer for Person, Team and Calendar; configuration mutation already enforces the same role.

Repository settings expose only `.gitpm/statuses.yaml` and `.gitpm/issue-types.yaml`. Server, GitLab and OAuth configuration are intentionally absent.

## Verification

- Component Maintainer workflow and Developer read-only tests: passed.
- Backend Developer administrative mutation: stable 403 `DRAFT_FORBIDDEN`, store not called.
- Browser-local VFY-020 through the in-app Browser Playwright API: passed.
- Maintainer and Developer role-matrix screenshots: saved.
- Browser path ledger contains exactly Calendar, Person, Team, statuses and issue-types paths.

## Acceptance

- PO: accepted.
- QA: accepted.

Workload and Gantt consumers of these administration entities remain in their planned P11C/P11D stages.
