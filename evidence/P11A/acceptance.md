# P11A acceptance

Roles: PO, QA
Result: accepted
Date: 2026-07-11

The Board groups active Tasks by repository-defined status without swimlanes. Native drag and pointer drag update a Task through the existing optimistic domain API. Project, status and type filters are visible and can be persisted as schema-v1 Saved Views with `kind: board` and `group_by: status`.

Reopening a Saved View restores its filters. Archived Tasks remain excluded by the established active-entity rule. External writer mode, closed drafts, external changes and Reporter access keep the Board read-only.

Evidence:

- `vfy-026-board-saved-view.txt`
- `vfy-026-browser.json`
- `vfy-026-board-saved-view.png`
- `vfy-026-git-diff.txt`
