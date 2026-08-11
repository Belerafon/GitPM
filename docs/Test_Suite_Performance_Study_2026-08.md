# GitPM test-suite performance study (2026-08)

## Scope and method

The measurements below use Node.js 20.19.2 and pnpm 10.12.1 on the supported Windows 11 local
profile: an Intel i7-1165G7 with 4 cores / 8 logical CPUs and 15.7 GiB RAM. Every comparison ran
the same checkout and retained the full real-Git and browser coverage. Scratch JSON reports lived
under the ignored `.tmp/` directory.

The suite contains 785 Vitest tests. Its expensive work is not TypeScript transformation alone:
the longest files create real repositories, worktrees, commits, validation snapshots, and jsdom
environments. The Playwright matrix contains 43 tests against worktree and direct repository
runtimes.

## Measurements

| Run | Result | Wall time |
| --- | --- | ---: |
| Vitest, `forks`, 1 worker (baseline) | 785 passed | 503.2 s |
| Vitest, `forks`, 4 workers | exposed one missing async UI wait | 239.2 s |
| Vitest, `threads`, 4 workers after fixing the wait | 785 passed | 234.6 s |
| Playwright, 1 worker (baseline) | 43 passed | 364.7 s |
| Playwright, 2 workers, first run | 42 passed, 1 failed | 300.9 s |
| Playwright, 2 workers, second run | 41 passed, 2 failed | 250.4 s |

The longest one-worker Vitest files were `apps/cli/src/command.test.ts` (66.0 s),
`packages/domain/src/index.test.ts` (60.4 s), `apps/server/src/domain-api.integration.test.ts`
(29.7 s), `apps/server/src/repository-runtime.test.ts` (27.4 s), and
`packages/drafts/src/index.test.ts` (26.5 s). Four workers more than doubled the duration of an
individual Git-heavy file because of filesystem contention, but reduced total Vitest wall time by
more than half by overlapping independent files.

The `threads` pool improved the four-worker run by only 4.6 seconds (about 2%). GitPM therefore
keeps Vitest's safer default `forks` pool. Migrating the runner is not justified: 39 files use
Vitest mocking APIs, 35 use jsdom/Testing Library, and the measured bottleneck is serialized real
Git work rather than the test API.

Two Playwright workers were not accepted. They share the same repository server, so concurrent
files make Git operations roughly twice as slow and expose stale fingerprint/polling races. The
small and unstable improvement does not justify weakening browser assertions or accepting flakes.

## Implemented changes

- Vitest now chooses half of the available logical CPUs, capped at four, while preserving the
  `GITPM_TEST_WORKERS` override.
- The CLI, repository-runtime, and domain-API integration files prepare an immutable Git template
  once and copy it per test instead of repeating `git init`, `add`, `commit`, bare initialization,
  and push.
- A React test now waits for asynchronously populated task options, a race exposed by four-worker
  execution.
- E2E draft cleanup prefixes no longer overlap between the app, scheduling, and Gantt files.
- The persistence E2E test subscribes to child exit before `taskkill`, avoiding the full five-second
  fallback when Windows reports the exit immediately.
- Full gates from different worktrees are documented as mutually exclusive because the E2E ports
  are fixed and competing Git suites make both gates slower.

These choices follow the Vitest guidance to profile transform/import/test/environment time and to
tune workers before changing isolation, and the Playwright requirement that parallel tests avoid
shared external state:

- [Vitest profiling](https://vitest.dev/guide/profiling-test-performance)
- [Vitest performance guidance](https://vitest.dev/guide/improving-performance)
- [Vitest `maxWorkers`](https://vitest.dev/config/maxworkers)
- [Playwright parallelism and external-state isolation](https://playwright.dev/docs/test-parallel)
