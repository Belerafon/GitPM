# GitPM repository modes

GitPM can talk to a Git repository in two ways. The mode is selected in
`.gitpm/config.json` (`repositoryMode`) or with the `GITPM_REPOSITORY_MODE`
environment variable. The environment variable wins over the file. Unknown
non-empty values are rejected with a clear error. When nothing is set, GitPM uses
`direct`.

| | `direct` (default) | `worktree` |
| --- | --- | --- |
| Working copy | one normal checkout at `<data-dir>/repository` | bare `<data-dir>/repository.git` plus one `git worktree` per draft |
| Branch | the configured default branch (`main`) | one `gitpm/<owner>/<draft>` branch per draft |
| Commit | straight onto `main` | onto the draft branch |
| Push | fast-forward `main` to `origin/main` (no force, no rebase, no merge commit) | push the draft branch, then open a Merge Request |
| CLI | commands work without `--draft` | commands require `--draft <id>` |
| Agent guidance | `direct`-mode `AGENTS.md` + skill at the checkout root | draft `AGENTS.md` + skill in each worktree |
| UI | branch, changes, commit, push, sync state | drafts, writer mode, draft branch, Merge Request |

Runtime metadata is mode-scoped. Worktree drafts remain in `<data-dir>/drafts/*.json`; the
single internal direct workspace is stored in `<data-dir>/drafts/direct/DRF-LOCAL.json`.
Switching modes therefore does not reinterpret, overwrite, or delete the other mode's metadata
or working trees.

## `direct`

GitPM owns a single ordinary Git repository with a working copy:

```text
<data-dir>/repository/
  .git/
  projects/
  people/
  teams/
  calendars/
```

GitPM reads and writes files directly in this working copy, works on the
configured default branch, commits onto it, and — on an explicit user action —
pushes it to `origin/main`.

The shared domain services use one internal `DRF-LOCAL` workspace, but direct mode has no public
draft lifecycle. Creating another draft, changing writer mode, closing, reopening, cleaning up,
or creating a revert draft through the HTTP draft API returns
`DIRECT_MODE_DRAFT_OPERATION_UNAVAILABLE`. At startup GitPM reconciles `DRF-LOCAL` with the
canonical `<data-dir>/repository` checkout and keeps it in `ui`/`open` state.

If files change outside the running UI, optimistic writes remain blocked until the user reviews
the current checkout and explicitly acknowledges it. The acknowledgement updates only the
runtime fingerprint; it does not edit, discard, commit, or validate repository files. The next
domain mutation still performs the normal full repository validation.

When `<data-dir>/repository` is absent, GitPM performs an ordinary clone from the
configured source (the local path in `repository`/`GITPM_REPOSITORY_PATH`, or
`repositoryUrl`). When the directory already exists, GitPM reuses it and never
destroys uncommitted changes, local commits, or user files.

Legacy direct metadata from `<data-dir>/drafts/*.json` is migrated automatically into
`<data-dir>/drafts/direct/`. Metadata whose path belongs to a worktree is left untouched. This
makes `worktree -> direct -> worktree` switching reversible while both physical checkouts remain
available.

Push always performs a `fetch` first and only allows a safe fast-forward. GitPM
never does rebase, merge commit, hard reset, stash, or force push. When the local
and remote branches have diverged, GitPM returns a clear error.

A `direct`-mode CLI session looks like this:

```text
gitpm status --json
gitpm entity create --file /tmp/entity.yaml --project P-26-MGP84K --json
gitpm entity update --type task --id T-26-RHBNH8 --set status=done --project P-26-MGP84K --json
gitpm format --json
gitpm validate --changed --json
gitpm diff --semantic --json
gitpm commit --all -m "Add Q3 capacity plan" --json
gitpm push --json
```

`gitpm status --json` returns the mode, the checkout path, the current branch,
the HEAD commit, the dirty state, and ahead/behind counts versus the remote.

## `worktree`

This is the original GitPM draft workflow. It keeps a bare repository, creates one
`git worktree` per draft on its own `gitpm/<owner>/<draft>` branch, enforces one
writer mode per draft, pushes the draft branch, and opens a Merge Request against
the default branch. Existing commands with `--draft` continue to work unchanged.

Enable it explicitly:

```json
{
  "repositoryMode": "worktree",
  "repository": "D:\\projects\\portfolio-data"
}
```

or:

```text
GITPM_REPOSITORY_MODE=worktree
```

## Configuration summary

```json
{
  "repositoryMode": "direct",
  "repository": "D:\\projects\\portfolio-data",
  "repositoryUrl": "https://gitlab.example/group/portfolio.git",
  "defaultBranch": "main"
}
```

| Field | Env var | Notes |
| --- | --- | --- |
| `repositoryMode` | `GITPM_REPOSITORY_MODE` | `direct` (default) or `worktree`. Env wins. |
| `repository` | `GITPM_REPOSITORY_PATH` | Local source repository (clone source in direct mode). |
| `repositoryUrl` | — | Optional HTTPS remote for the managed checkout. |
| `defaultBranch` | `GITPM_DEFAULT_BRANCH` | Default branch; `main` when unset. |

## Docker

`compose.yaml` and `compose.server.yaml` default to `direct`. The managed
checkout lives in the persistent `gitpm-data` volume at `/data/repository` and is
reused across container restarts. Switch to the draft/MR workflow with
`GITPM_REPOSITORY_MODE=worktree`.

```bash
# direct (default)
docker compose -f compose.yaml -f compose.server.yaml up -d --build

# worktree
GITPM_REPOSITORY_MODE=worktree docker compose -f compose.yaml -f compose.server.yaml up -d --build
```

## Implementation note

Mode differences live behind a single seam: `DraftBackend`
(`packages/drafts/src/draft-backend.ts`) with `WorktreeDraftBackend` and
`DirectDraftBackend` implementations, plus matching push strategies. The rest of
GitPM (domain, changes, history, publishing, UI) is mode-agnostic and reuses the
same single-workspace API surface; the server runtime picks the backend from the
resolved mode.
