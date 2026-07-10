# P04 acceptance record

Date: 2026-07-10

Accepted roles: ARCH, QA.

- ARCH: REST contracts delegate all file changes to the draft/domain layers,
  preserve one-writer and optimistic revision boundaries, and expose no server paths.
- QA: VFY-009/VFY-010/VFY-011 cover all editable entity types, exact changed
  files, archive/delete, delete restrict, stale revisions and technical limits.
- Full verify passes 13 test files and 56 tests plus health, schema, security and
  planning checks.

Authentication is an injected server boundary until P06 supplies OAuth-backed
identity and refreshed GitLab roles.
