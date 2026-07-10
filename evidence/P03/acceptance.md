# P03 acceptance record

Date: 2026-07-10

Accepted roles: SEC, QA.

- SEC: Git runs without shell under isolated config; shared bare mutations and
  per-draft mutations are serialized; paths and atomic writes reuse P00S controls.
- QA: VFY-007/VFY-008 pass exact-current-main creation, restart recovery,
  one-writer modes, optimistic blob IDs, orphan detection and explicit cleanup.
- Full verify passes 10 test files and 46 tests plus health, schema, security and
  planning checks.

Local filesystem remotes are enabled only by an explicit integration-test option;
production configuration continues to require credential-free HTTPS.
