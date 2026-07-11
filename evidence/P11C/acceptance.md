# P11C acceptance

Roles: PO, QA
Result: accepted
Date: 2026-07-11

The read-only Gantt renders active Tasks only when both `start` and `due` are present. Five deterministic bars match the fixture dates from 2026-07-01 through 2026-07-08. Task hierarchy is visible through indentation, the Beta release milestone is positioned on its due date, and three dependency arrows connect the dated Tasks.

The archived and undated fixture Tasks are absent. A browser drag gesture on the first bar did not change its dates or produce a repository path mutation. The component uses only entity-list reads and exposes no drag, resize, inline edit, or mutation controls.

Evidence:

- `vfy-027-browser.json`
- `vfy-027-gantt.jpg`
- `vfy-027-git-status.txt`
