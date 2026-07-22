# GitPM CLI

CLI живёт в `apps/cli` и собирается в `apps/cli/dist/index.js`. В Docker-образе
он доступен как `gitpm` на `PATH` (через симлинк `/usr/local/bin/gitpm`).

## Команды

```
gitpm init [path]                    Создать skeleton схемы v1 в path (по умолчанию cwd)
gitpm status [--draft <id>]
gitpm draft create|open|status --draft <id> [--owner <id>]
gitpm draft set-writer ui|external --draft <id> [--owner <id>]
gitpm entity create [--draft <id>] --file <file> [--type <type>] [--project <id>]
gitpm entity update [--draft <id>] --type <type> --id <entity-id> [--file <yaml-patch>] [--set <field>=<yaml-value>]... [--unset <field>]... [--project <id>]
gitpm entity import [--draft <id>] --type <type> --format csv|yaml|jsonl (--file <file>|--path <file>) [--dry-run]
gitpm schema list
gitpm schema show <type> [--example]
gitpm format [--draft <id>] [--project <id>] [--check]
gitpm validate [--draft <id>] [--project <id>] [--changed] [--allow-delete]
gitpm diff --semantic [--draft <id>] [--project <id>] [--allow-delete]
gitpm commit --all [--draft <id>] -m <message> [--project <id>] [--allow-delete]
gitpm push [--draft <id>]
gitpm mr create --draft <id> --owner <id> --title <title> [--description <text>]
gitpm doctor
gitpm --version [--json]
```

`entity create` принимает YAML mapping. При наличии `--type` поля `schema`, `id` и
`lifecycle` во входе можно опустить: CLI подставляет schema, генерирует ID формата
`<prefix>-<UTC YY>-<6 Crockford Base32>` и использует `lifecycle: active`. Явно переданный
корректный ID сохраняется, а не игнорируется. Для Person отсутствующий `calendar`
материализуется из `.gitpm/repository.yaml/default_calendar`; `weekly_capacity_hours`
остаётся обязательным явным значением. Сохранённый repository YAML всегда содержит полный
канонический документ.

`entity update` атомарно изменяет любую поддерживаемую сущность. `--type` и `--id` однозначно
выбирают существующую сущность. Небольшой patch задаётся повторяемыми `--set field=yaml-value` и
`--unset field`; для большого patch можно использовать YAML mapping через `--file`. Источники можно
комбинировать, inline-поля имеют приоритет. `schema`, `id` и владеющий Project неизменяемы; `null`
в YAML patch и `--unset` удаляют необязательное поле. После записи CLI проверяет весь репозиторий и
откатывает все затронутые файлы при ошибке validation или Project scope.

`entity import` (alias: `entity bulk-import`) выполняет пакет атомарно: сначала планирует все ID, затем записывает пакет,
один раз валидирует полный репозиторий и откатывает все файлы при любой ошибке. `--dry-run`
выполняет тот же pipeline без сохранения изменений. CSV использует строку заголовков;
числовые поля (`weekly_capacity_hours`, `estimate_hours`) разбираются как числа, а списочные
поля задаются JSON-массивами. YAML import содержит массив mappings, JSONL — один object на
строку. В JSON-результате элементы содержат `source_index`, `row`, сгенерированный `id` и
канонический `path`.

`schema list/show` доступны без runtime configuration. `schema list` возвращает восемь
domain schemas (включая `comment`) и три repository configuration schemas.
`gitpm --version --json` дополнительно
возвращает digest набора схем и optional build commit из `GITPM_BUILD_COMMIT`, что позволяет
обнаруживать устаревшую установленную сборку.

В `direct` mode команды `status`, `entity create`, `entity update`, `entity import`, `format`, `validate`, `diff`, `commit` и
`push` работают с managed checkout без `--draft`. В `worktree` mode для них требуется
`--draft <id>`; `mr create` доступна только в `worktree` mode. `--project <id>` проверяет, что
все текущие business changes принадлежат указанному Project, а физическое удаление требует
явного `--allow-delete` при проверке diff/validation и commit.

Каждая команда поддерживает `--json` для машинно-читаемого вывода.

Каждый черновик создаёт в worktree локальные `AGENTS.md` и
`.agents/skills/gitpm/SKILL.md`, чтобы агент мог подключиться на любом этапе. Они описывают GitPM и CLI-only правила, автоматически
восстанавливаются и не входят в business diff, commit или MR. Корневой `AGENTS.md` исходного
репозитория GitPM относится только к разработке программы; runtime skill в корне не создаётся.

## Переменные окружения

### Инициализация репозитория (`gitpm init`)

| Переменная | По умолчанию | Назначение |
|------------|--------------|------------|
| `GITPM_INIT_BRANCH` | `main` | Имя ветки для initial commit. |
| `GITPM_INIT_AUTHOR_NAME` | `GitPM` | `user.name` для initial commit. |
| `GITPM_INIT_AUTHOR_EMAIL` | `gitpm@localhost` | `user.email` для initial commit. |
| `GITPM_INIT_MESSAGE` | `Initialise GitPM repository` | Текст initial commit. |

`gitpm init` создаёт валидный schema-v1 skeleton, корневой `.gitignore` и
`uploads/.gitkeep`. Входные файлы под `uploads/` игнорируются Git; каталог
разрешён через `allowed_top_level_directories` и не является domain storage.

### Agent workflow (drafts, push, MR)

Нужный набор зависит от repository mode. В `direct` mode CLI может построить
runtime из `GITPM_REPOSITORY_PATH`, `GITPM_DATA_DIR` и mode; в `worktree` mode
draft/publish-командам дополнительно нужен remote runtime. `schema`, `doctor` и
`init` не требуют существующего managed checkout.

| Переменная | Назначение |
|------------|------------|
| `GITPM_REPOSITORY_MODE` | `direct` (по умолчанию) или `worktree`. |
| `GITPM_REPOSITORY_PATH` | Source/managed repository path, в зависимости от launcher/runtime. |
| `GITPM_DATA_DIR` | Persistent каталог managed checkout, draft metadata и worktrees. |
| `GITPM_REMOTE_URL` | URL push-remote. Для file-path remote требует `GITPM_ALLOW_LOCAL_REPOSITORY=1` или `GITPM_ALLOW_LOCAL_TEST_REMOTE=1`. |
| `GITPM_DEFAULT_BRANCH` | Бранч под который идут MR (по умолчанию `main`). |
| `GITPM_ASKPASS_PATH` | Скрипт git askpass для авторизации при push. По умолчанию `scripts/git-askpass.mjs`. |
| `GITPM_ACCESS_TOKEN` | Токен GitLab API. В логи/commits не попадает, передаётся только в in-memory calls. |
| `GITPM_AGENT_AUTHOR_NAME` | `user.name` для коммитов от лица агента (по умолчанию `GitPM Agent`). |
| `GITPM_AGENT_AUTHOR_EMAIL` | `user.email` для коммитов от лица агента. |
| `GITPM_BUILD_COMMIT` | Optional commit identifier в `gitpm --version --json`. |

### Сервер (web UI, OAuth)

| Переменная | По умолчанию | Назначение |
|------------|--------------|------------|
| `GITPM_REPOSITORY_PATH` | из `.gitpm/config.json` | Путь к git-репозиторию со схемой v1. |
| `GITPM_REPOSITORY_MODE` | `direct` | `direct` или `worktree`; env имеет приоритет над config. |
| `GITPM_DEFAULT_BRANCH` | `main` | Основная/target ветка. |
| `GITPM_DATA_DIR` | `<repository>/.gitpm-data` | Каталог под drafts сервера. |
| `GITPM_BIND_HOST` | `127.0.0.1` | Хост, на котором сервер слушает. |
| `GITPM_SERVER_PORT` (`PORT`) | `3000` | Порт API. |
| `GITPM_WEB_PORT` | `5173` | Порт web UI. |
| `GITPM_RUNTIME_MODE` | — | `production` собирает web и запускает Vite `preview`. |
| `GITPM_API_TARGET` | `http://127.0.0.1:3000` | Куда Vite проксирует `/api`. На сервере не нужен, если web и api в одном хосте. |
| `GITPM_NO_BROWSER` | — | Значение `1` отключает попытку открыть браузер на Windows. |
| `GITPM_WEB_URL` | `http://127.0.0.1:5173` | Базовый URL web UI. |
| `GITPM_AUTHOR_NAME` / `GITPM_AUTHOR_EMAIL` | из git config | Подпись коммитов от лица UI-пользователя. |
| `LOG_LEVEL` | `error` | Уровень логов сервера. |

### GitLab OAuth

| Переменная | По умолчанию | Назначение |
|------------|--------------|------------|
| `GITPM_GITLAB_URL` | — | Base URL GitLab-инстанса, например `http://10.0.0.1:81`. |
| `GITPM_GITLAB_PROJECT` | — | `group/project` для MR. |
| `GITPM_GITLAB_CLIENT_ID` | — | OAuth Application ID, зарегистрированный в GitLab. |
| `GITPM_GITLAB_REDIRECT_URI` | `http://127.0.0.1:3000/api/auth/callback` | Redirect URI OAuth. На сервере указать внешний URL (например `http://10.0.0.1:86/api/auth/callback`). |
| `GITPM_COOKIE_SECURE` | `true` | Когда web UI опубликован по plain HTTP (без TLS-терминатора), поставьте `false` — иначе браузер не примет сессионную cookie. |
| `GITPM_PUSH_REMOTE_URL` | auto из `origin` | Override push-remote URL. Принимает только credential-free HTTPS. |

## Сценарии

### Локально на Windows

`run-gitpm.bat` запускает сервер и web UI в dev-режиме. Авторизация не
требуется для локальных операций; наличие безопасного HTTPS remote и GitLab OAuth
определяет доступность push/MR. Без `.gitpm/config.json` launcher создаёт и открывает
актуальную копию bundled demo.

### Docker (локально)

```bash
GITPM_REPOSITORY_PATH=/path/to/portfolio docker compose up -d --build
```

Открывает `:3000` и `:5173` на `0.0.0.0` без perimeter auth. Подходит для
разработки и доверенной локальной сети; managed checkout и metadata сохраняются
в volume `gitpm-data`.

### Docker (сервер)

См. `compose.server.yaml` и раздел README *Docker*. Профиль публикует только web
port на выбранном IP, добавляет healthcheck и persistent `.gitpm` volume. GitLab
OAuth защищает remote-операции; для публичного UI всё равно требуется reverse
proxy/TLS и отдельный deployment review. Для plain HTTP cookie `Secure` нужно
явно отключить через `GITPM_COOKIE_SECURE=false`.
