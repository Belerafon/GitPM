# P09 and Alpha acceptance

Date: 2026-07-10

## Outcome

P09 is accepted. The Changes workspace shows the exact file-level Git diff with only Added, Modified and Deleted categories, supports whole-file and selected-hunk restore, and provides a semantic view with created, updated, archived and deleted entity groups and field values before/after.

The publication flow is intentionally commit-all. The dialog displays the complete file count and has no staging selection UI. Browser acceptance committed all four fixture paths, pushed the draft branch, created Merge Request !17 through the test double, and observed its state through polling. Russian localization was active throughout the Changes-to-MR flow.

## Alpha limitations accepted

- One configured repository and one owner per draft.
- Every commit includes all current draft changes; selective staging is unavailable.
- Merge Request input is limited to title and description.
- The browser acceptance uses the deterministic GitLab publishing test double; Git and publishing integration behavior remains covered by P05/P06 tests.

## Verification

- Changes and publishing component tests: passed.
- Semantic diff and Added-file unified diff integration test: passed.
- Server semantic endpoint contract test: passed.
- Browser-local VFY-021/VFY-023/VFY-024 path through the in-app Browser Playwright API: passed.
- Final clean `corepack pnpm verify`: passed, including 21 test files and 81 tests.

## Acceptance

- PO: accepted.
- QA: accepted.
- SEC: accepted; diff rendering is text-only, filesystem access remains within the existing security boundary, and publishing uses the existing role/session controls.

The Alpha release gate report is recorded separately after execution-status validation.
