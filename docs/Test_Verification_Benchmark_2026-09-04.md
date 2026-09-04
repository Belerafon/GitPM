# Local verification benchmark — 2026-09-04

## Baseline

Measurements were taken on Windows 11 with Node.js 20.19.2, pnpm 10.12.1, 8 logical CPUs and
approximately 16 GiB RAM. A fresh worktree created in 17.4 seconds. Its frozen install took 1 minute
22 seconds with all 316 packages reused and no downloads.

A clean `corepack pnpm verify:local` passed in 18 minutes 33 seconds:

| Stage | Time |
| --- | ---: |
| clean | 3s |
| build | 47s |
| lint | 20s |
| typecheck | 23s |
| Vitest, 1,084 tests | 5m 26s |
| Playwright, 51 tests | 9m 21s |
| smoke | 10s |
| schemas | 3s |
| security report | <1s |
| planning | 38s |

A prior one-line CSS experiment completed `verify:web` in 1 minute 54 seconds. Two warm complete
gates took 10 minutes 43 seconds and 17 minutes 35 seconds, showing that host contention dominates
the variance even when dependencies are already present.

The acceptance run for the controls described below passed in 11 minutes 14 seconds. Vitest took
3 minutes 25 seconds at 79% average host CPU; Playwright took 6 minutes 17 seconds at 39.5%. Free
memory during those stages ranged from 1.73 to 2.25 GiB. An unchanged
`corepack pnpm verify:resume` then reused all 11 successful stages in 0.87 seconds.

## Why earlier feature sessions lasted hours

The structured employee-name change ran six complete gates and none passed as one command. Late
Vitest or Playwright failures consumed 72 minutes 41 seconds before diagnosis; failing Playwright
runs took up to 16 minutes because later tests cascaded on shared cleanup state. The eventual green
Vitest and Playwright runs took about 6 minutes and 8.5 minutes respectively. The file-drag session
spent about 29 minutes in verification, including two unrelated parallel-Vitest flakes that passed
in isolation; its two-hour conversation also contained roughly an hour of inactivity.

The bottleneck is therefore repeated work after late failures, not a two-hour healthy gate.

## Implemented controls

- Incremental JSON timing/resource reports make cross-run comparison possible without scraping chat
  logs.
- Per-profile checkpoints let an explicit `--resume` reuse successful unaffected stages.
- A two-worker low-impact mode reduces interference with interactive workloads.
- A repository-wide Playwright lock prevents fixed-port collisions across worktrees.
- Local Playwright fail-fast avoids paying for a cascade after the first browser failure.
- Retried draft cleanup and closing the audit page before cleanup reduce polling/delete races.
- Changed-path profile selection avoids using the complete gate for bounded changes.
- Both previously omitted Playwright files now belong to thematic browser profiles.

The complete gate remains mandatory for release candidates and root verification changes. These
controls reduce retries and contention; they do not weaken the set of checks in a successful full
gate.
