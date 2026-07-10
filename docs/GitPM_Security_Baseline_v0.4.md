# GitPM: ранний baseline безопасности

Версия документа: 0.4  
Статус: обязательный до P03

## 1. Принцип

Security controls добавляются вместе с рискованным компонентом. P13A подтверждает существующую защиту, а не впервые создает ее.

## 2. Assets

- bare repository and worktrees;
- local-only draft data;
- in-memory user OAuth token;
- mounted read-only fetch credential;
- user identity and project role;
- server filesystem and availability;
- logs without secrets.

Webhook secret, backup assets, safety refs, token keyring, quota state and MCP credentials отсутствуют.

## 3. Trust boundaries

- Browser -> GitPM HTTP;
- Agent process -> dedicated external-mode worktree and CLI;
- GitPM -> Git child process;
- GitPM -> worktree filesystem;
- GitPM -> GitLab OAuth/API/Git transport;
- Operator -> external server configuration and mounted secrets.

## 4. Git runner

- argv array without shell;
- allowlisted subcommands and options;
- controlled repository URL and branch/ref validation;
- isolated HOME and system/global Git config disabled;
- empty controlled `core.hooksPath`;
- external diff, textconv, filters and submodule initialization disabled;
- unsafe protocols including `file://` disabled;
- static controlled `GIT_ASKPASS`;
- user token only in child environment;
- timeout, output limit and process-group kill;
- no force push in v0.1.

## 5. Filesystem and YAML

- canonical realpath inside worktree;
- every path component checked for symlink;
- `.git` inaccessible through domain API;
- same-filesystem temp file and atomic rename;
- duplicate keys, anchors, aliases and custom tags rejected;
- static file size, depth, node count and line length limits;
- unknown repository content rejected;
- absolute server paths never returned to client.

## 6. Browser surface

- descriptions, labels, commit messages and GitLab metadata are untrusted;
- raw HTML disabled in Markdown;
- allowlist sanitizer and safe URL schemes;
- Content Security Policy and clickjacking protection;
- same-origin CORS and CSRF protection;
- Secure, HttpOnly, SameSite cookies;
- binary/large files not rendered inline;
- diff rendering limits;
- DOM XSS tests.

## 7. OAuth 2.0

- Authorization Code with PKCE;
- exact redirect URI and `state`;
- scopes `api` and `write_repository`;
- no OIDC nonce;
- access token only in process memory;
- refresh token not persisted;
- session <= token lifetime and 8 hours;
- restart requires login;
- project membership and role refreshed before publish operations;
- token absent from URL, argv, Git config, temp files, logs and metrics.

## 8. Authorization

- Guest/non-member denied;
- Reporter read-only;
- Developer owns and edits normal drafts;
- Maintainer controls administrative repository entities and cleanup;
- server configuration is external;
- backend checks role, ownership and writer mode before mutation;
- UI controls are not a security boundary.

## 9. Draft and agent workflow

- one writer mode per draft;
- external mode makes UI read-only;
- direct external change invalidates stale UI mutation;
- CLI may restrict allowed Project ID and delete flag;
- format and validate required before commit/push;
- no MCP and no arbitrary command API.

## 10. Minimal observability

- structured logs and correlation ID;
- Git duration, exit code and timeout;
- GitLab OAuth/API errors;
- stable security error codes;
- no secret or complete sensitive payload logging.

## 11. P00S spikes

- command/ref injection;
- malicious hooks/filter/textconv/submodule config;
- symlink swap during atomic write;
- hard kill during worktree add and file rename;
- GIT_ASKPASS token leakage inspection;
- YAML resource exhaustion;
- XSS through repository and GitLab metadata.

## 12. P13A confirmation

- hostile browser content suite;
- malicious repository suite;
- role revocation and token lifecycle tests;
- dependency/container scan;
- residual risk record.
