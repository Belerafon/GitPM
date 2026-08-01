# ADR 0004: Local trust, raw worktree access, and fingerprint boundaries

- Status: accepted
- Date: 2026-08-01

## Context

GitPM supports a local single-user profile alongside an authenticated multi-user
GitLab profile. It also exposes a worktree file manager and protects UI mutations
with a worktree fingerprint. These boundaries can look unsafe when interpreted as
multi-user authorization, a domain editor, or semantic validation respectively.

The product needs explicit decisions that describe the intended operating model
without introducing a business database, a second filesystem API, or weaker
external-change protection.

## Decision

1. The local single-user HTTP API trusts every network client that can reach it.
   Each such client acts as the one local Maintainer identity. Operators must bind
   this profile to loopback or provide perimeter authentication with a reverse
   proxy. GitLab OAuth in `user-oauth-publication` authenticates remote
   publication only. Per-user authorization requires worktree mode with
   `oauth-identity-project-token`.
2. The worktree file manager is a raw filesystem interface below the domain layer.
   It may change permitted non-Git paths, including domain paths. It enforces path
   containment, symlink protection, and optimistic fingerprint matching, but does
   not validate or canonicalize each change. Entity forms and the CLI remain the
   safe high-level interfaces for structured GitPM data.
3. The optimistic fingerprint covers Git status and all discovered YAML files
   outside `.git`, plus relevant file metadata and content. Its scope is wider
   than semantic diff and repository validation so that UI writes cannot silently
   proceed after an external worktree change.
4. Acknowledgement only accepts the current fingerprint as a new optimistic-lock
   baseline. It neither validates nor changes repository files.
5. The local profile supports one operator using one repository and one working
   tree at a time. Its mutexes and fingerprints make individual UI operations
   atomic and detect stale writes, but do not coordinate concurrent authors.
   Parallel editing is unsupported in this profile and must use Git
   branches/worktrees and the normal Git workflow instead.

## Alternatives considered

- Authenticate every local HTTP request in GitPM. Rejected because the supported
  local profile is intentionally single-user; perimeter authentication is the
  operator's responsibility when network access is shared.
- Restrict the file manager to non-domain directories. Rejected because it would
  create a second, incomplete editing model and would not make direct worktree
  edits safe or impossible.
- Fingerprint only semantic GitPM data or tracked Git files. Rejected because an
  ignored or non-domain YAML change could otherwise occur unnoticed while a stale
  UI mutation is accepted.
- Treat acknowledgement as validation. Rejected because acknowledgement must be
  safe to use for inspection and recovery without hiding invalid repository state.

## Consequences

- Exposing a local profile beyond a trusted boundary gives every reachable client
  Maintainer authority; public deployment needs an authenticating reverse proxy
  and deployment review.
- Concurrent local authors are not a supported workflow. A detected stale write
  does not turn direct mode into a multi-user synchronization system.
- Raw file operations can temporarily leave a repository invalid. Commit and push
  remain protected by full repository validation.
- Changes to ignored YAML files or file metadata can produce
  `DRAFT_CHANGED_EXTERNALLY`, even when they have no semantic GitPM effect.
- Operators and users must distinguish acknowledgement of an external change from
  confirmation that repository content is valid.
