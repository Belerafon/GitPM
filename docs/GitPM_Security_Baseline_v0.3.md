# GitPM: ранний baseline безопасности

Версия документа: 0.3  
Статус: обязательный до P03

## 1. Принцип

Security controls добавляются вместе с рискованным компонентом. P13A проверяет и атакует уже существующую защиту.

## 2. Assets

- Git repository и worktrees;
- uncommitted draft data на persistent volume;
- in-memory OAuth token;
- webhook secret;
- user identity;
- server filesystem и availability;
- logs без secrets.

Safety refs, backup assets, token keyring, quota state и MCP credentials отсутствуют.

## 3. Trust boundaries

- Browser -> GitPM HTTP;
- Agent process -> dedicated worktree and CLI;
- GitPM -> Git process;
- GitPM -> worktree filesystem;
- GitPM -> GitLab OAuth/API/Git transport;
- GitLab -> webhook endpoint;
- Administrator -> server configuration and secrets.

## 4. Git runner

До P03 обязательны:

- запуск argv array без shell;
- allowlist subcommands и dangerous options;
- controlled repository URL;
- isolated system/global Git config;
- пустой controlled `core.hooksPath`;
- external diff и textconv disabled;
- filters и submodule initialization disabled;
- unsafe protocols, включая `file://`, disabled;
- credential helper только временный и controlled;
- timeout, output limit и process-group kill;
- branch/ref validation.

## 5. Filesystem and YAML

- canonical realpath внутри worktree;
- каждый path component проверяется на symlink;
- `.git` недоступен domain API;
- same-filesystem temp file и atomic rename;
- duplicate keys, anchors, aliases и custom tags запрещены;
- static technical limits file size, depth, node count и line length;
- partial bulk write запрещен;
- absolute server paths не возвращаются клиенту.

Технические limits не являются quota engine.

## 6. Browser surface

- task text, labels, commit messages и GitLab metadata считаются untrusted;
- raw HTML в Markdown disabled;
- allowlist sanitizer;
- safe URL schemes;
- Content Security Policy;
- clickjacking protection;
- same-origin CORS;
- CSRF protection;
- Secure, HttpOnly, SameSite cookies;
- large/binary files не рендерятся inline;
- Monaco/diff имеют static rendering limits;
- DOM XSS tests для repository и GitLab metadata.

## 7. OAuth

- Authorization Code Flow with PKCE;
- state и nonce;
- exact redirect URI;
- access token только в process memory;
- refresh token не сохраняется;
- logout удаляет session;
- restart требует повторный login;
- token отсутствует в URL, argv, filesystem, logs и metrics.

Нет token-at-rest encryption, master key или rotation subsystem.

## 8. Webhooks

- secret comparison;
- configured GitLab project ID;
- event ID idempotency в bounded in-memory/disk-light state;
- body size и content type limits;
- metadata sanitization;
- forged и foreign-project events не вызывают mutations.

## 9. Authorization

- простое GitLab role mapping из Delivery Policies;
- backend проверяет роль перед mutation, commit, push и MR;
- UI visibility не является security boundary;
- administrative routes требуют Maintainer или configured Administrator;
- нет repository permission DSL или custom decision engine.

## 10. Agent workflow

- отдельный OS/worktree context;
- agent edits files directly;
- CLI может ограничить allowed project ID и delete flag на конкретный запуск;
- format, validate и semantic diff обязательны перед commit/push;
- MCP и arbitrary command API отсутствуют.

## 11. Minimal observability

- structured logs и correlation ID;
- Git command duration, exit code и timeout;
- GitLab API/webhook errors;
- security failures со stable code;
- secrets и полные чувствительные payload не логируются.

Отдельная metrics platform не обязательна.

## 12. P00S spikes

- command/ref injection;
- symlink swap during atomic write;
- hard kill during worktree add и file rename;
- malicious hooks/filter/textconv/submodule fixtures;
- credential leakage inspection;
- webhook replay and foreign project;
- YAML resource exhaustion;
- XSS through domain and GitLab metadata.

Каждый spike создает ADR или regression test.

## 13. P13A confirmation

- review threat model;
- browser hostile-content suite;
- malicious repository suite;
- fault tests process restart and interrupted writes;
- dependency/container scan;
- residual risk record.
