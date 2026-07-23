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
gitpm entity list [--draft <id>] --type <type> [--project <id>]
gitpm entity show [--draft <id>] --type <type> --id <entity-id>
gitpm entity delete [--draft <id>] --type <type> --id <entity-id> [--unlink-references] [--dry-run] [--allow-delete] [--project <id>]
gitpm entity archive [--draft <id>] --type <type> --id <entity-id> [--project <id>]
gitpm entity move [--draft <id>] --type task --id <entity-id> --to-project <id> [--to-milestone <id>] [--allow-delete] [--project <id>]
gitpm comment list --project <id> --task <id>
gitpm comment create --project <id> --task <id> (--body <text> | --file <path>)
gitpm comment update --project <id> --task <id> --id <comment-id> (--body <text> | --file <path>)
gitpm comment delete --project <id> --task <id> --id <comment-id>
gitpm config show --kind statuses|issue-types
gitpm config update --kind statuses|issue-types [--file <yaml>] [--set <field>=<yaml-value>]... [--unset <field>]
gitpm schema list
gitpm schema show <type> [--example]
gitpm format [--draft <id>] [--project <id>] [--check] [--allow-delete]
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

`entity list` возвращает все сущности указанного типа (`--type`), опционально отфильтрованные
по Project (`--project`). `entity show` возвращает одну сущность по `--type` и `--id`.

`entity delete` физически удаляет файл сущности. При удалении Task автоматически каскадно
удаляются комментарии этой задачи. `--dry-run` выполняет превью без записи: возвращает
список ссылающихся документов (`restrictions`), каскадных комментариев (`cascaded_comments`)
и документов, которые будут отвязаны (`would_unlink`, только для Person). `--unlink-references`
удаляет ссылки на Person перед удалением (поддерживается только для `person`; другие типы
вызывают `DELETE_UNLINK_UNSUPPORTED`). Если сущность имеет ссылки и `--unlink-references`
не указан, возникает `DELETE_RESTRICTED` со структурированным списком затронутых файлов.

`entity archive` устанавливает `lifecycle: archived` (обратимо); файл остаётся, ссылки
остаются валидными.

`entity move` перемещает Task (и её комментарии) в другой Project и опционально другой
Milestone. Cross-project ссылки (`depends_on`, `parent`) блокируются validation.

`comment` управляет комментариями к Task: Markdown с упоминаниями `@[Name](person:U-...)`,
soft-delete (tombstone остаётся в Git history). Доступно в direct mode.

`config show/update` читает и обновляет конфигурацию репозитория (`.gitpm/statuses.yaml`,
`.gitpm/issue-types.yaml`). Доступно в direct mode.

В `direct` mode команды `status`, `entity create`, `entity update`, `entity import`, `entity list`,
`entity show`, `entity delete`, `entity archive`, `entity move`, `comment`, `config`, `format`,
`validate`, `diff`, `commit` и `push` работают с выбранным checkout без `--draft`.
В `worktree` mode `status`, `entity`, `format`, `validate`, `diff`, `commit` и `push`
требуют `--draft <id>`; `comment` и `config` в этом режиме не реализованы, а
`mr create` доступна только в нём. `--project <id>` проверяет, что все текущие
business changes принадлежат указанному Project, а физическое удаление требует явного
`--allow-delete` при format/validation/diff и commit, пока удалённые пути остаются в checkout.

Каждая команда поддерживает `--json` для машинно-читаемого вывода.
Неизвестная или повторно переданная нереплицируемая option отклоняется с
`CLI_USAGE`; CLI не игнорирует опечатки во флагах.

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
ID стандартного Calendar генерируется при запуске из текущего года и не
зашит в шаблон.

`gitpm diff --semantic` требует configured direct runtime либо `--draft` в
worktree mode. Переданный отдельно `--root` достаточен для `format`,
`validate` и `doctor`, но не создаёт Git before/after context для semantic
diff; в таком случае CLI возвращает `CLI_DIRECT_CONFIGURATION_REQUIRED`,
а не пустой успешный diff.

`gitpm init` генерирует ID календаря через общий генератор entity ID с текущим UTC-годом,
использует его и в `calendars/<id>.yaml`, и в `.gitpm/repository.yaml/default_calendar`.

`gitpm diff --semantic` требует настроенный direct runtime либо `--draft` с agent runtime.
Без runtime команда завершается ошибкой `CLI_DIRECT_CONFIGURATION_REQUIRED` и никогда не
подменяет отсутствующий Git baseline пустым semantic diff.

### Agent workflow (drafts, push, MR)

Нужный набор зависит от repository mode. В `direct` mode CLI может построить
runtime из `GITPM_REPOSITORY_PATH`, `GITPM_DATA_DIR` и mode; в `worktree` mode
draft/publish-командам дополнительно нужен remote runtime. `schema`, `doctor` и
`init` не требуют существующего runtime checkout.

| Переменная | Назначение |
|------------|------------|
| `GITPM_REPOSITORY_MODE` | `direct` (по умолчанию) или `worktree`. |
| `GITPM_REPOSITORY_PATH` | Выбранный существующий checkout в `direct`; repository source для `worktree`. |
| `GITPM_DATA_DIR` | Persistent каталог runtime metadata и worktrees; в `direct` второй checkout здесь не создаётся. |
| `GITPM_REMOTE_URL` | Fetch/push remote для `worktree` mode. Для file-path remote требует `GITPM_ALLOW_LOCAL_REPOSITORY=1` или `GITPM_ALLOW_LOCAL_TEST_REMOTE=1`; в `direct` не используется. |
| `GITPM_DEFAULT_BRANCH` | Основная ветка direct checkout и target MR (по умолчанию `main`). |
| `GITPM_ASKPASS_PATH` | Скрипт git askpass для авторизации при push. По умолчанию `scripts/git-askpass.mjs`. |
| `GITPM_ACCESS_TOKEN` | Токен GitLab API. В логи/commits не попадает, передаётся только в in-memory calls. |
| `GITPM_GITLAB_URL` | HTTPS base URL GitLab-инстанса для `mr create`. |
| `GITPM_GITLAB_PROJECT` | GitLab project path (`group/project`) для `mr create`. |
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
| `GITPM_GITLAB_URL` | — | HTTPS base URL GitLab-инстанса, например `https://gitlab.example`; HTTP разрешён только для localhost/127.0.0.1. |
| `GITPM_GITLAB_PROJECT` | — | `group/project` для MR. |
| `GITPM_GITLAB_CLIENT_ID` | — | OAuth Application ID, зарегистрированный в GitLab. |
| `GITPM_GITLAB_REDIRECT_URI` | `http://127.0.0.1:3000/api/auth/callback` | Redirect URI OAuth. На сервере указать внешний URL (например `http://10.0.0.1:86/api/auth/callback`). |
| `GITPM_COOKIE_SECURE` | `true` | Когда web UI опубликован по plain HTTP (без TLS-терминатора), поставьте `false` — иначе браузер не примет сессионную cookie. |
| `GITPM_PUSH_REMOTE_URL` | auto из `origin` | Override push-remote URL. Принимает только credential-free HTTPS. |

Если connection fields не заданы через environment, Maintainer может настроить
credential-free `origin`, GitLab project и OAuth Application ID в web UI.
Секреты через UI не принимаются; access token остаётся только в памяти процесса.

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
разработки и доверенной локальной сети; выбранный checkout bind-mount-ится в
`/repository`, а metadata сохраняется в volume `gitpm-data`.

### Docker (сервер)

См. `compose.server.yaml` и раздел README *Docker*. Профиль публикует только web
port на выбранном IP, добавляет healthcheck и persistent `.gitpm` volume. GitLab
OAuth защищает remote-операции; для публичного UI всё равно требуется reverse
proxy/TLS и отдельный deployment review. Для plain HTTP cookie `Secure` нужно
явно отключить через `GITPM_COOKIE_SECURE=false`.
