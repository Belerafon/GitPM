# GitPM local operations runbook v0.1

This runbook covers the supported local profiles: the Windows launcher with a
Node.js process and system Git, plus the Docker image with persistent volumes.
Both modes assume one configured GitPM repository; public-internet deployment
requires a separate reverse proxy/TLS and security review.

## Verified toolchain

- Node.js `20.19.2` (`.node-version`, `.nvmrc` and `package.json`)
- pnpm `10.12.1` through Corepack
- Git `2.53.0.windows.1` for the recorded local acceptance run
- Windows 11 x64, 8 logical CPUs and 15.7 GiB RAM for the recorded local acceptance run

CI uses the declared `ubuntu-24.04` runner with Node.js `20.19.2`, pnpm `10.12.1`, Python `3.11.9` and the frozen pnpm lockfile. Git remains the system Git supplied by that pinned runner image; its exact version must be captured with each performance report.

## Clean installation

From a clean checkout:

```powershell
corepack enable
corepack prepare pnpm@10.12.1 --activate
corepack pnpm install --frozen-lockfile
corepack pnpm verify
```

The install must not modify `pnpm-lock.yaml`. `verify` performs a clean build, lint, typecheck, tests, health smoke, schema fixtures, credential-boundary report and planning checks.

## Start and health verification

```powershell
.\run-gitpm.bat
```

Without `.gitpm/config.json` the launcher prepares the bundled demo. For a real
repository set `repository`, `repositoryMode` and optional `defaultBranch` in
that file. The launcher starts API and web UI together, checks both ports and
opens `http://127.0.0.1:5173` when ready.

In another terminal:

```powershell
Invoke-RestMethod http://127.0.0.1:3000/health/live
Invoke-RestMethod http://127.0.0.1:3000/health/ready
```

Both endpoints must return `status: ok`. Keep the service bound to loopback unless a separate trusted reverse proxy and public deployment review are provided.

## Restart and draft durability

Stop the process with `Ctrl+C` or `SIGTERM`, then start it with the same configuration and persistent data directory. OAuth sessions are memory-only, so login is required again. Direct checkout metadata, draft metadata and worktrees remain on disk.

The automated operational check creates a dirty draft, constructs a fresh runtime instance over the same data directory and verifies that:

- the draft is recovered;
- its completed file write remains present;
- dirty state is reported and is not silently accepted or removed.

Run it with:

```powershell
corepack pnpm operations:p13b
```

## Docker

Copy `.env.example` to `.env`, set `GITPM_REPOSITORY_PATH` and run:

```powershell
docker compose up -d --build
docker compose ps
```

The local profile publishes API `:3000` and web `:5173`; managed repository data
survives in `gitpm-data`. The optional server override publishes only the chosen
web port and adds healthcheck, persistent application config and GitLab OAuth:

```powershell
docker compose -f compose.yaml -f compose.server.yaml up -d --build
```

## Explicit cleanup

Cleanup is intentionally destructive and separate from close. Close the draft first, request cleanup, and enter the exact draft ID as confirmation. A dirty draft is removed only by this explicit confirmed action. The operational smoke verifies rejection of an incorrect confirmation and absence of the draft after confirmed cleanup.

## Performance smoke

```powershell
corepack pnpm performance:p13b
```

The command generates a temporary deterministic portfolio with 30 Projects, 30 People and 3000 Tasks. It runs cold validation/load, one Task write plus full validation, and semantic diff of 100 modified files in three fresh processes, then compares medians with the v0.1 budgets. Temporary fixture and Git data are removed afterward.

## Troubleshooting

- `GIT_TIMEOUT` or `GIT_OUTPUT_LIMIT`: inspect the repository size and system Git; do not raise limits before reviewing the input.
- `DRAFT_CHANGED_EXTERNALLY`: review the current files and use the UI acknowledgement action (or
  `POST /api/drafts/:draftId/acknowledge-external-changes`) before editing; acknowledgement accepts
  the current fingerprint but does not modify or validate files.
- `DIRECT_MODE_DRAFT_OPERATION_UNAVAILABLE`: the requested create/writer/close/reopen/cleanup or
  revert-draft operation belongs to worktree mode; direct mode always uses its one internal
  `DRF-LOCAL` workspace.
- `GIT_WRONG_BRANCH`: switch the selected checkout to the configured default
  branch after preserving any local changes; GitPM never switches it implicitly.
- `CLEANUP_CONFIRMATION_REQUIRED`: close the draft and repeat cleanup with the exact draft ID.
- `VALIDATION_FAILED`: run `gitpm validate --changed` in direct mode or add
  `--draft <ID>` in worktree mode, then correct the first stable validation code.
- Health endpoint unavailable: confirm the selected port is free and inspect structured server logs using the response correlation ID.
- Performance failure: confirm that the fixture count, Node/pnpm/Git versions, filesystem and runner metadata match the report before treating it as a product regression.

## Limitations

- The accepted performance numbers below are a local Windows smoke, not the Linux x64 4-vCPU/8-GiB reference profile from the architecture document.
- Network and live GitLab latency are excluded.
- Backup, multi-tenant isolation and public-internet hardening are not provided by GitPM.
