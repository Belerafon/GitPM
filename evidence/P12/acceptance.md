# P12 acceptance

Roles: ARCH, QA
Result: accepted
Date: 2026-07-11

The scripted agent creates an external-mode draft and edits repository YAML directly. CLI format, changed validation, semantic diff, commit-all, push and Merge Request commands pass through the shared runtime. Project scope rejects a Person edit outside the allowed Project, and deletion requires the explicit `--allow-delete` flag. Commit always includes every change.

With the Russian Tasks UI left open, two consecutive agent writes became visible on polling cycle 2 without a manual reload. Only `description_markdown`, `status` and `title` received the external-update indication. The two writes coalesced into one stable indication, which expired automatically in normal mode. Focus and scroll remained unchanged. Reduced-motion mode reported `animationName=none` and retained a static highlight during the indication interval.

Evidence:

- `vfy-029-agent-cli.txt`
- `vfy-029-browser.json`
- `vfy-029-playwright-trace.json`
- `vfy-029-external-highlight.png`
- `vfy-029-reduced-motion.png`
- `vfy-029-final-diff.txt`
- `vfy-029-mr-payload.json`
