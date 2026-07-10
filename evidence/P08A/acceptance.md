# P08A acceptance

Date: 2026-07-10

## Outcome

P08A is accepted. Portfolio, Project, Milestone and Task surfaces are integrated into the P07 shell. An open UI-mode draft supports create, edit, archive and delete actions for all three core entity types. Task UI includes active-list filtering, inline status editing and a side panel for Markdown and relationship edits.

Status and issue-type values come from the draft repository configuration rather than hard-coded product labels. Entity collection reads are owner-checked by the server and may be filtered by Project. Optimistic draft fingerprint and blob revisions remain attached to every mutation.

Markdown is rendered as React text/element nodes without `innerHTML`; the browser scenario confirmed that a raw `<img onerror>` string creates zero image elements. Archived Tasks disappear from the active list.

## Verification

- Component CRUD/localization suite: passed.
- Browser-local VFY-019 through the in-app Browser Playwright API: passed.
- Browser path ledger contains exactly one Project, one Milestone and one Task YAML path.
- Screenshot: `vfy-019-core-crud.png`.
- Trace: `vfy-019-playwright-trace.json`.
- Git-style path ledger: `vfy-019-git-diff.txt`.

## Acceptance

- PO: accepted.
- QA: accepted.

Board behavior is intentionally deferred to P11A. Administration entities and repository configuration mutation UI remain in P08B.
