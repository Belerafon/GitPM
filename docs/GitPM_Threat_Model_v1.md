# GitPM threat model v1

Статус: действующий P00S baseline, расширенный для direct mode.

## Scope and assets

Модель покрывает Browser -> HTTP, GitPM -> filesystem/Git process и GitPM ->
GitLab OAuth/API/Git transport. Защищаемые активы: direct managed checkout или
bare repository/worktrees, неопубликованные workspace changes, OAuth access token, mounted fetch credential,
identity/role state, доступность server и безопасные logs.

Вне scope v0.1: multi-tenant isolation, backup, token keyring, webhook secret,
arbitrary command API и MCP.

## Trust boundaries and attacker capabilities

- Repository author контролирует YAML, Markdown, labels, commit metadata и часть Git config.
- Browser user может отправлять произвольные HTTP payload и stale mutations.
- Local attacker с правом записи в worktree может пытаться менять symlink/path во время операции.
- OAuth/GitLab responses и ошибки являются внешними недоверенными данными.
- Operator контролирует server configuration, mounted secrets и filesystem permissions.

## Threats and controls

| ID | Threat | Required controls | Residual risk |
|---|---|---|---|
| TM-GIT-01 | Command/option/ref injection | argv array without shell; allowlisted operations; strict ref and HTTPS URL validation | Future Git options require explicit review |
| TM-GIT-02 | Hooks, filters, textconv or protocol execution | isolated HOME; system config disabled; empty hooks path; protocol/file/ext disabled; no submodule init | Repository-local config must never be trusted by new code paths |
| TM-FS-01 | Traversal or symlink escape | relative domain paths only; canonical root; every existing component lstat; final containment check | Node path checks cannot remove all TOCTOU risk on attacker-writable parent directories |
| TM-FS-02 | Partial/interrupted write | same-directory exclusive temp file; fsync; recheck parent; atomic rename; cleanup | Hard kill can leave a harmless temp file for startup cleanup |
| TM-OAUTH-01 | Token leakage | memory-only token; controlled static ASKPASS; token only in child env; redacted logs; no credential URL/config/temp file | Privileged same-host process may inspect child environment |
| TM-WEB-01 | Stored/reflected XSS | raw HTML disabled; sanitizer and safe URL allowlist; CSP; escaped locale interpolation | Sanitizer regressions remain a release test responsibility |
| TM-YAML-01 | Parser exhaustion or unsafe construction | duplicate/alias/tag rejection and static size/depth/node/line limits | Limits require tuning against performance fixture |
| TM-AUTH-01 | Stale or UI-only authorization | backend role/ownership/writer checks and role refresh before publish | GitLab remains final push/MR authority |

## Security invariants

1. User-controlled data never selects a shell command, executable or Git option.
2. Domain writes resolve inside the canonical worktree and reject every symlink component.
3. Token bytes are absent from argv, repository URL, Git config, temp files, logs and metrics.
4. Repository content is rendered as untrusted text and cannot weaken CSP or authorization.
5. Failures return stable security codes without absolute server paths or sensitive payloads.

## Spike decisions

Accepted implementation direction is recorded in
`adr/0001-safe-git-filesystem-credential-boundaries.md`. P00S regression tests prove
the invariants that can be exercised before P03/P06. Browser sanitizer, YAML
resource limits and complete process-group timeout behavior remain attached to
the components that introduce those surfaces and are rechecked in P13A.
