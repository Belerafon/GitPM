# GitPM

Git-first система управления проектами и задачами с web UI, GitLab Merge Request workflow и файловой работой агентов через CLI.

## Current status

Статус: `v0.1_release_accepted`. P00-P14 закрыты; Alpha, Beta, release candidate и release gates пройдены. Русский web UI, локальная эксплуатация, performance smoke и полный набор автоматических тестов приняты. CLI остаётся нейтральным по локали и проверен на UTF-8 кириллицу.

## Обычный запуск на Windows

Запустите `run-gitpm.bat`. По умолчанию GitPM создаст рабочую копию русскоязычного демонстрационного портфеля из `demo/portfolio` в `.gitpm/demo-repository` и откроет её. В демо находятся 3 проекта, 30 задач, 10 сотрудников, общие команды, вехи, зависимости и сроки.

Чтобы открыть свой существующий репозиторий, измените поле `repository` в `.gitpm/config.json`:

```json
{
  "repository": "D:\\projects\\portfolio-data"
}
```

Локальная работа и локальные коммиты не требуют входа. Если у выбранного репозитория есть credential-free HTTPS `origin` GitLab, launcher определит адрес инстанса и путь проекта. Для входа через GitLab добавьте Application ID зарегистрированного OAuth-приложения в `.gitpm/config.json`:

```json
{
  "repository": "D:\\projects\\portfolio-data",
  "gitlab": {
    "baseUrl": "https://gitlab.com",
    "project": "group/portfolio-data",
    "clientId": "GITLAB_OAUTH_APPLICATION_ID"
  }
}
```

Redirect URI приложения: `http://127.0.0.1:3000/api/auth/callback`; scopes: `api` и `write_repository`. Вход предлагается только перед push/Merge Request. Регистрация OAuth Application описана в [документации GitLab](https://docs.gitlab.com/api/oauth2/).

## Development

Требуются Node.js 20.19.2, pnpm 10.12.1 через Corepack и Python 3.11 с PyYAML.

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm verify
set GITPM_REPOSITORY_PATH=D:\path\to\repository
corepack pnpm dev:server
```

Server предоставляет `GET /health/live` и `GET /health/ready` на
`http://127.0.0.1:3000`. Каждый ответ возвращает `x-correlation-id`, а
структурный request log содержит тот же идентификатор.

## Active documents

- `docs/GitPM_Implementation_Plan_v0.7.md` - architecture and normative domain model;
- `docs/GitPM_Work_Plan_v0.8.md` - executable stages, commit cadence and acceptance;
- `docs/GitPM_Requirements_Traceability_v0.5.yaml` - DAG, requirements, verification checks and gate composition;
- `docs/GitPM_Execution_Status_v0.1.yaml` - actual stage/check status and evidence;
- `docs/GitPM_Delivery_Policies_v0.5.md` - product and operational boundaries;
- `docs/GitPM_Security_Baseline_v0.5.md` - early security controls;
- `docs/GitPM_Planning_Maintenance_Guide_v0.3.md` - how to maintain planning and localization artifacts;
- `docs/GitPM_Repository_Format_v1.md` - approved schema v1 repository layout and reference rules;
- `docs/PROGRESS.md` - decisions, blockers and next action.

Old versions remain only in Git history.

## Planning and gate commands

```bash
python3 scripts/validate_planning.py
python3 scripts/test_planning_validator.py
python3 scripts/test_release_gate.py
python3 scripts/check_release_gate.py --gate alpha
corepack pnpm schema:verify
```

The planning validator checks document consistency. The gate checker checks actual status and evidence and is expected to fail until the milestone is completed.

## v0.1 principles

- Dedicated GitPM repository.
- One immutable ID; explicit Project directory exception.
- Approved schema v1 before parser implementation.
- Fetch current remote main before creating each draft.
- One writer mode per draft.
- One configured repository per server.
- No business database, backup, safety refs, migration engine or quota engine.
- OAuth 2.0 with memory-only user token; no webhook.
- No rebase or conflict UI.
- Commit always includes all draft changes.
- Read-only Gantt and approximate Workload.
- Agent edits files and uses CLI; no MCP.
- Physical delete and archive are both supported.
- Locale packs support multiple languages; Russian is mandatory and complete for v0.1.
