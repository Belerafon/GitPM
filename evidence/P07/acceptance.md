# P07 acceptance

Date: 2026-07-10

## Outcome

P07 is accepted. The React frontend shell provides one configured repository without a repository selector, session/login states, navigation, multi-draft list and the create/open/close/reopen/explicit-cleanup lifecycle. Active draft status includes branch, dirty file count, validation, writer mode and Merge Request state.

The draft context polls draft, changes, validation and MR state every 3 seconds. External writer mode shows an explicit read-only warning. The backend now exposes owner-filtered draft listing, current memory-session inspection and read-only validation summaries.

The version-controlled `en` source and mandatory `ru` locale packs have identical keys and placeholders, contain no HTML, persist the explicit browser choice, and update root `lang`/`dir`. Locale switching produces no domain API payload.

## Verification

- Component lifecycle and localization tests: passed.
- Browser-local VFY-018 through the in-app Browser Playwright API: passed.
- Poll counter advanced from 1 to 2 after one 3-second interval.
- Full browser screenshot: `vfy-018-draft-lifecycle.png`.
- Machine-readable browser trace: `vfy-018-playwright-trace.json`.
- Monorepo lint, typecheck, build and 18-file/72-test suite: passed before final status update.

## Acceptance

- FE: accepted.
- QA: accepted.

Production service composition and the later Project/Task/administration screens remain in their planned stages; they do not block the P07 shell and draft-lifecycle contract.
