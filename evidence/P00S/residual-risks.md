# P00S residual risks

- Node path APIs cannot completely eliminate a TOCTOU race if an attacker can
  rename an otherwise trusted parent between the final check and rename.
  Supported deployment therefore requires exclusive server ownership of
  repository/worktree parent directories. The regression spike detects a swap
  before rename and never follows a swapped parent for cleanup.
- A privileged same-host process may inspect child environment, including the
  short-lived ASKPASS token. Host/process isolation is an operator boundary.
- Browser sanitizer/CSP tests, YAML resource limits and process-group timeout
  behavior are implemented with the components that introduce those surfaces
  and are rechecked in P13A.

Acceptance decision (2026-07-10): SEC and ARCH accept these residual risks for
v0.1 under the deployment boundary and follow-up stages stated above.
