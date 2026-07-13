# P13A residual risks

Deployment boundary: local, trusted-user GitPM installation. The application data directory and runtime-owned Git configuration are writable only by the account running GitPM.

- A privileged process on the same host can inspect process memory or the short-lived ASKPASS child environment. This is accepted because same-host administrator/process isolation is outside the local application boundary.
- Node filesystem checks cannot eliminate every TOCTOU race if another process can rename trusted parent directories. The local deployment must keep the data directory under exclusive runtime-account ownership.
- Runtime-owned `.git/config` is trusted operational state. Repository content, inherited Git environment, hooks, filters, textconv, unsafe protocols and submodule initialization remain blocked by the tested Git boundary.
- Origin-less non-browser requests remain available to the local CLI/API workflow. Browser cookie mutations are protected by `SameSite=Strict`, Secure/HttpOnly cookies and cross-site Origin/Fetch-Metadata rejection.
- Multi-tenant isolation, hostile local administrators, backup, a container image and a public-internet hardening profile are outside v0.1 scope.

No unresolved high or critical finding remains. SEC and ARCH accept these risks for the local v0.1 deployment model on 2026-07-13.
