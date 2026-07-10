# ADR 0001: Safe Git, filesystem and credential boundaries

Status: accepted for v0.1.

## Context

P03 will operate on repositories containing attacker-controlled names and Git
configuration. P06 will pass a user OAuth token to Git over HTTPS. Shell command
construction, credential-bearing URLs and path-prefix string checks are not
acceptable boundaries.

## Decision

- Spawn Git directly with an argv array and an allowlisted operation builder.
- Validate branch names against the v0.1 ASCII allowlist and validate configured
  credential-free HTTPS repository URLs before argv construction.
- Use isolated HOME/XDG config, disable system config and terminal prompts, set an
  empty controlled hooks directory, and deny unsafe Git protocols.
- Use a static ASKPASS helper. Pass the token only in `GITPM_ASKPASS_TOKEN` in the
  child environment; never place it in argv, URL, Git config or generated helper files.
- Resolve domain paths from a canonical worktree root, reject absolute/traversal
  input and symlinks, and use same-directory exclusive temp files plus atomic rename.
- Treat an attacker-writable parent directory as outside the supported deployment
  boundary. P03 must preserve ownership/permission isolation around worktrees.

## Rejected approaches

- Shell escaping: platform-specific and too easy to bypass as options evolve.
- Token in remote URL or temporary credential file: leaks through process/config/filesystem inspection.
- Repository-provided hooks, filters, credential helpers or ASKPASS: crosses the trust boundary.
- Lexical `startsWith(root)` containment: vulnerable to sibling prefixes, traversal and symlinks.
- Backup copies before writes: conflicts with the explicit no-backup v0.1 policy.

## Consequences

Git features enter through narrow reviewed builders rather than a generic runner.
Some local filesystem TOCTOU risk is controlled operationally by exclusive
worktree ownership; a future native `openat`/handle-relative implementation may
replace the Node spike without changing the domain API.
