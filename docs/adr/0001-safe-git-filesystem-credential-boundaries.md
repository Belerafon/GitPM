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
  repository URLs before argv construction. URLs are classified as HTTP, HTTPS,
  or SSH; all must be credential-free (no embedded password; HTTP(S) also
  forbids a username since GitPM injects the OAuth identity via ASKPASS).
  Schemes such as `file`, `ext::`, and `git+http` are rejected. Plain HTTP is
  supported for trusted local-network deployments, with the explicit
  consequence that credentials and repository data are not encrypted in transit.
- Use isolated HOME/XDG config, disable system config and terminal prompts, set an
  empty controlled hooks directory, and deny unsafe Git protocols.
- Use a static ASKPASS helper. Pass the token only in `GITPM_ASKPASS_TOKEN` in the
  child environment; never place it in argv, URL, Git config or generated helper files.
- For SSH transports, build a controlled `GIT_SSH_COMMAND` from an allowlist of
  options sourced exclusively from administrator environment (`GITPM_SSH_KEY_PATH`,
  `GITPM_SSH_KNOWN_HOSTS_FILE`, `GITPM_SSH_STRICT_HOST_KEY_CHECKING`,
  `GITPM_SSH_COMMAND`, or an `SSH_AUTH_SOCK` passthrough). GitPM never reads,
  copies, or logs the key; the remote host/user/path reach ssh only as arguments
  passed by Git without a shell. An HTTP(S) token for non-GitLab remotes
  (`GITPM_REMOTE_TOKEN`) flows through the same in-memory ASKPASS path.
- Resolve domain paths from a canonical worktree root, reject absolute/traversal
  input and symlinks, and use same-directory exclusive temp files plus atomic rename.
- Treat an attacker-writable parent directory as outside the supported deployment
  boundary. P03 must preserve ownership/permission isolation around worktrees.

## Rejected approaches

- Shell escaping: platform-specific and too easy to bypass as options evolve.
- Token in remote URL or temporary credential file: leaks through process/config/filesystem inspection.
- Persisted credentials (PAT/password in config or OS keyring): breaks the
  memory-only credential invariant; SSH key + in-memory env token cover the same
  use cases without weakening the threat model.
- Accepting user-supplied `GIT_SSH_COMMAND` or ssh options: would let user data
  select a command or option, violating the command-selection invariant.
- Repository-provided hooks, filters, credential helpers or ASKPASS: crosses the trust boundary.
- Silently upgrading an operator-provided HTTP URL to HTTPS: breaks local GitLab
  instances that intentionally do not terminate TLS and changes the configured origin.
- Lexical `startsWith(root)` containment: vulnerable to sibling prefixes, traversal and symlinks.
- Backup copies before writes: conflicts with the explicit no-backup v0.1 policy.

## Consequences

Git features enter through narrow reviewed builders rather than a generic runner.
Some local filesystem TOCTOU risk is controlled operationally by exclusive
worktree ownership; a future native `openat`/handle-relative implementation may
replace the Node spike without changing the domain API.
