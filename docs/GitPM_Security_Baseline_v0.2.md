# GitPM: ранний baseline безопасности

Версия документа: 0.2  
Статус: обязательный до P03

## 1. Принцип

Security controls appear with the risky component. P13A verifies and attacks them; it does not introduce the first protection.

## 2. Assets

- portfolio repository and history;
- dirty draft and local safety refs;
- OAuth access/refresh tokens;
- master key/keyring;
- webhook secrets;
- permission and agent policies;
- server filesystem and availability;
- user and agent identity;
- logs and metrics without secrets.

## 3. Trust boundaries

- Browser -> GitPM HTTP;
- Agent -> MCP/API;
- GitPM -> Git process;
- GitPM -> worktree filesystem;
- GitPM -> GitLab OAuth/API/Git transport;
- GitLab -> webhook endpoint;
- Administrator -> configuration and mounted secrets.

There is no backup process trust boundary because GitPM v0.1 does not implement backups.

## 4. Threat actors

- mistaken human user;
- malicious or over-privileged user;
- agent with wrong context;
- compromised agent credential;
- attacker controlling branch, path, YAML, Markdown or commit metadata;
- malicious repository content;
- forged/replayed webhook;
- operator losing master key or persistent volume.

## 5. Git runner and malicious repository content

Mandatory before P03 exit:

- no shell; argv array only;
- allowlist subcommands/options;
- `git check-ref-format` plus application policy;
- controlled repository URL;
- isolated Git config environment: system/global configs disabled or explicitly controlled;
- controlled `core.hooksPath` pointing to empty directory;
- no `--ext-diff` and no textconv execution;
- no recursive submodule initialization;
- unsafe protocols including `file://` denied;
- no repository-controlled credential helper;
- clean/smudge filter execution unavailable unless explicitly allowlisted, with none allowed in v0.1;
- `.gitattributes` treated as untrusted input and cannot enable process execution;
- command timeout, output limit, cancellation and process-group kill;
- credentials provided through controlled temporary helper, never argv/URL/log;
- branch, path and commit metadata limits.

## 6. Filesystem and YAML

- canonical realpath inside worktree root;
- every path component checked against symlink;
- no writes through symlink;
- `.git` inaccessible to domain file API;
- same-filesystem temp file and atomic rename;
- file size, depth, node count and line length limits;
- YAML aliases, anchors, custom tags and duplicate keys prohibited;
- request quota checked before write;
- partial bulk writes prohibited;
- absolute server paths removed from client errors.

## 7. Browser surface

- all YAML, task descriptions, labels, commit messages and GitLab metadata are untrusted;
- Markdown renderer uses strict allowlist sanitizer;
- raw HTML disabled by default;
- URL sanitizer permits only configured schemes and blocks javascript/data where unsafe;
- Content Security Policy without unsafe-inline for scripts;
- frame-ancestors or equivalent clickjacking protection;
- restrictive CORS; same-origin by default;
- CSRF protection for cookie-authenticated mutations;
- secure, HttpOnly and SameSite cookies;
- Monaco/diff limits for file size, line count and single-line length;
- large/binary content is not rendered inline;
- external links use safe rel attributes;
- DOM-based XSS tests cover fields from repository and GitLab.

## 8. OAuth, tokens and keyring

- Authorization Code Flow with PKCE;
- state and nonce;
- exact redirect URI;
- minimal scopes tested on real GitLab;
- access and refresh tokens encrypted at rest;
- production master key only from mounted secret file;
- keyring has active key ID and decrypt-only previous keys;
- authenticated encryption from maintained library;
- rotation dry-run and report;
- lost key makes affected tokens undecryptable and forces re-login;
- project files are not affected by token/key loss;
- token never appears in URL, process args, logs, metrics or error details;
- logout/revoke deletes local token and session;
- retry loops are bounded.

## 9. Webhooks

- secret comparison is constant-time;
- configured GitLab project ID must match;
- replay cache uses event ID plus bounded time window;
- handler is idempotent;
- body size and content type limited;
- event metadata sanitized before UI rendering;
- webhook failures and lag are measured;
- forged, replayed and foreign-project events cause no mutation.

## 10. Authorization

- decision engine implements precedence from Delivery Policies;
- API, commit, push and MR all check authorization;
- policy/config files are protected by diff inspection;
- UI visibility is not an authorization boundary;
- membership cache has bounded TTL and critical-operation refresh;
- deny decisions include stable code but do not disclose sensitive paths;
- agent identity never impersonates human identity.

## 11. Agents

- dedicated agent identity;
- immutable scope bound at draft creation;
- explicit allowed project ULIDs and operations;
- deny overrides allow;
- delete requires separate flag and limit;
- bulk preview and semantic diff;
- no raw Git command;
- no arbitrary path;
- rate/file/diff quotas;
- full validation and permission refresh before push/MR.

## 12. Early observability

- P00: health, structured logs and correlation IDs;
- P03: Git duration, process failures, locks, safety freshness;
- P04: HTTP/rate/quota metrics;
- P06: OAuth, token refresh, push/MR and webhook metrics;
- security events use stable codes and actor IDs;
- secrets and full sensitive entity text are not metrics/log labels.

## 13. Required P00S spikes

- branch/ref command injection;
- symlink swap during atomic write;
- hard kill during worktree add and rename;
- malicious hooks/filter/textconv/submodule fixtures;
- user credential push with process/log inspection;
- webhook replay and foreign project;
- YAML resource exhaustion;
- XSS through domain and GitLab metadata;
- local safety ref recovery with intact bare repository;
- explicit persistent-volume-loss behavior without backup claim.

Each spike produces an ADR, automated regression test or explicit rejection of the approach.

## 14. P13A confirmation

- final threat model review;
- browser penetration-oriented suite;
- malicious repository suite;
- fault injection;
- dependency/container scans;
- quota abuse;
- lost key and lost volume incident drills;
- residual risk acceptance.
