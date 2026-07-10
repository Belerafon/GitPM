# P01 acceptance record

Date: 2026-07-10

Accepted roles: ARCH, PO, QA.

- ARCH: JSON Schema 2020-12 files and `GitPM_Repository_Format_v1.md` form a
  complete v1 baseline before production parser work.
- PO: the deterministic portfolio covers Project, Task, Milestone, Person,
  Team, Calendar and Saved View with the required configuration files.
- QA: VFY-004 passes the valid portfolio and rejects Project directory mismatch,
  cross-project dependency and invalid estimate step with stable codes.

Known limitation: production parsing, canonical formatting, full reference and
calendar validation belong to P02 and do not reopen the approved field model.
