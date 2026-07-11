# P11D acceptance

Roles: PO, QA
Result: accepted
Date: 2026-07-11

The deterministic calculator splits estimates equally between active assignees and distributes each share over that person's working dates. Weekly capacity respects configured weekdays and holidays. The Workload UI explains both formulas, shows allocation versus capacity, highlights overload, and lists exclusion reasons.

Browser-local VFY-028 verified three precomputed Person-week values in the Russian UI. The 2026-07-08 holiday reduced capacity as expected. One archived and one undated Task were excluded, and viewing Workload caused no repository mutation.

Evidence:

- `vfy-028-browser.json`
- `calculation-report.md`
- `vfy-028-workload.png`
- `vfy-028-git-status.txt`
