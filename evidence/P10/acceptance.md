# P10 acceptance

Role: QA
Result: accepted
Date: 2026-07-11

History exposes the commit graph, commit detail, exact diff, affected projects and per-file history through controlled Git commands. A selected commit already present on current remote main can be applied with `git revert --no-commit` to a separately named draft created from freshly fetched main. The inverse diff remains available to the established commit-all workflow and HEAD is not rewritten.

Merge commits use parent 1 explicitly. Conflicts are retained for an external Git client and force external writer mode; the UI offers no conflict resolution or rebase action. Arbitrary objects, commits outside current main, invalid paths and invalid limits are rejected.

Evidence:

- `vfy-025-history-revert.txt`
- `vfy-025-browser.json`
- `vfy-025-history.png`
- `vfy-025-revert-diff.png`
- `vfy-025-revert-diff.txt`
