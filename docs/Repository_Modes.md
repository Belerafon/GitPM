# GitPM repository modes

GitPM can talk to a Git repository in two ways. The mode is selected in
`.gitpm/config.json` (`repositoryMode`) or with the `GITPM_REPOSITORY_MODE`
environment variable. The environment variable wins over the file. Unknown
non-empty values are rejected with a clear error. When nothing is set, GitPM uses
`direct`.

| | `direct` (default) | `worktree` |
| --- | --- | --- |
| Working copy | the normal checkout selected in `repository` | bare `<data-dir>/repository.git` plus one `git worktree` per draft |
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

GitPM works directly in the ordinary Git checkout selected by `repository` or
`GITPM_REPOSITORY_PATH`:

```text
<repository>/
  .git/
  projects/
  people/
  teams/
  calendars/
```

GitPM reads and writes files directly in this working copy, works on the
configured default branch, commits onto it, and — on an explicit user action —
pushes it to `origin/main`.

The checkout must already be on the configured default branch. GitPM does not
switch branches implicitly: a different branch is rejected as
`GIT_WRONG_BRANCH`, and detached HEAD is rejected as `GIT_DETACHED_HEAD`.

The shared domain services consume the mode-neutral `RepositoryWorkspace` contract. Direct mode
keeps one compatibility metadata record under the internal key `DRF-LOCAL`, but draft lifecycle
and writer mode are not part of the domain mutation boundary. Creating another draft, changing
writer mode, closing, reopening, cleaning up, or creating a revert draft through the HTTP draft API returns
`DIRECT_MODE_DRAFT_OPERATION_UNAVAILABLE`. At startup GitPM reconciles `DRF-LOCAL` with the
selected checkout and keeps it in `ui`/`open` state.

If files change outside the running UI, optimistic writes remain blocked until the user reviews
the current checkout and explicitly acknowledges it. The acknowledgement updates only the
runtime fingerprint; it does not edit, discard, commit, or validate repository files. The next
domain mutation still performs the normal full repository validation.

### Optimistic fingerprint scope

The fingerprint detects working-tree changes that may have occurred outside the current UI
runtime. Its scope is deliberately broader than GitPM semantic diff and repository validation.

It includes Git working-tree status and every discovered YAML file outside `.git`, including YAML
in permitted additional directories such as `uploads/`. It includes file size, modification time,
and content hash, so a file metadata change can invalidate the current UI revision even when the
file is not GitPM business data, is ignored by Git, and is excluded from semantic diff.

This is conservative protection against an unnoticed external write, not a test of repository
semantic correctness. Acknowledgement accepts the current state as the new optimistic-lock
baseline only; it neither validates nor modifies files.

The selected path must already be a Git checkout. GitPM does not create a second clone and does
not add a separate `source` remote. Local-path and bare repositories are supported only by the
development/test harness; a normal application installation works in the selected checkout and
publishes through that checkout's single `origin`.

Legacy direct metadata from `<data-dir>/drafts/*.json` is migrated automatically into
`<data-dir>/drafts/direct/`. Metadata whose path belongs to a worktree is left untouched. This
makes `worktree -> direct -> worktree` switching reversible while both physical checkouts remain
available.

Push always performs a `fetch` first and only allows a safe fast-forward. GitPM
never does rebase, merge commit, hard reset, stash, or force push. When the local
and remote branches have diverged, GitPM returns a clear error.

For an HTTP(S) origin, login supplies the OAuth access token only to the controlled
ASKPASS child environment. The token is not placed in the origin URL, Git config,
command arguments, files, or logs.

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

History mutations preserve the same branch boundary. Selecting an old commit is a read-only
snapshot view; GitPM never checks out a detached HEAD. A user may restore one or more files changed
by that commit into the current working tree, then review and commit the resulting diff, or create
a new validated reverse commit with `git revert`. Restore refuses to overwrite an already dirty
selected path. Direct revert requires a clean business working tree. Validation failures and Git
conflicts roll back the attempted mutation, so direct history actions never leave an unresolved
sequencer or a partially applied tree.

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
| `repository` | `GITPM_REPOSITORY_PATH` | Existing checkout used directly by `direct` mode. |
| `repositoryUrl` | `GITPM_PUSH_REMOTE_URL` | Credential-free HTTP(S) or SSH URL applied as the checkout's `origin` (`http://...`, `https://...`, `ssh://...`, or `git@host:path`). No embedded username/password/token. Plain HTTP is for trusted local networks only. |
| `defaultBranch` | `GITPM_DEFAULT_BRANCH` | Default branch; `main` when unset. |

Maintainers can edit `repositoryUrl` and the non-secret GitLab connection fields in the web
settings page when those values are not supplied by environment variables. Replacing or removing
an existing `origin` requires exact confirmation. GitPM verifies that the origin URL and GitLab
project identify the same host and project path.

The connection page groups fields into the remote `origin` and an optional GitLab integration
block, and shows the active connection method: GitLab (OAuth), SSH (administrator key), HTTP(S)
(administrator token), or Local (no remote). Any git host is accepted as `origin`; when GitLab is
not configured, publication runs over SSH (key provisioned via `GITPM_SSH_KEY_PATH` or an
ssh-agent) or HTTP(S) (token via `GITPM_REMOTE_TOKEN`). These credentials live only in process
memory and never enter the URL, argv, Git config, or logs. Merge Requests are GitLab-only; over
SSH or an HTTP(S) token GitPM pushes the branch to `origin` but cannot open an MR.
Plain HTTP leaves tokens and repository contents unencrypted in transit and is
intended only for trusted local-network deployments.

For a multi-user GitLab server, `oauth-identity-project-token` requires
`worktree` mode. Every draft is owned by the OAuth user's immutable GitLab user
ID, and draft reads, writes, commits, and publication are restricted to that
owner. The repository URL, GitLab origin, and `group/project` are supplied by
the administrator and cannot be overridden through the API. See
`docs/Deployment.md` for the complete environment and secret setup.

## Docker

`compose.yaml` and `compose.server.yaml` default to `direct`. The selected checkout is mounted at
`/repository`; `gitpm-data` contains runtime metadata, not another checkout. Switch to the draft/MR workflow with
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
`DirectRepositoryBackend` implementations, plus matching push strategies. The deprecated
`DirectDraftBackend` name remains only as a source-compatibility alias. The rest of
GitPM (domain, changes, history, publishing, UI) is mode-agnostic and reuses the
same `RepositoryWorkspace` and repository-mutation surface; direct mutations use
`repository` mode while worktree UI and agents explicitly use `ui` and `external`.
Both UI and CLI CRUD delegate to `EntityStore`, so validation, reference rewrites and
rollback have one implementation. CLI use cases shared by `DirectCliRuntime` and
`AgentWorkflow` additionally delegate to the mode-neutral `RepositoryWorkflow`: scope
checks, entity create/import/update/list/show/delete/archive/move and semantic diff are
implemented once. `RepositoryWorkflow` delegates commit, push and Merge Request
orchestration to the same `PublicationService` used by the server.
`PublicationService` is the single application service for commit, push, and Merge
Request orchestration. The server OAuth route and CLI runtimes only adapt local
author identity, in-memory credentials, and agent scope/writer-mode preconditions
before calling that service.
The CLI adapters retain only mode-specific preparation, draft lifecycle, status,
credentials, comments and configuration. The server runtime picks the backend from
the resolved mode.
