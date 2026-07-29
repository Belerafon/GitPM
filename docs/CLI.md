# GitPM CLI

CLI живёт в `apps/cli` и собирается в `apps/cli/dist/index.js`. В Docker-образе
он доступен как `gitpm` на `PATH` (через симлинк `/usr/local/bin/gitpm`).

## Команды

```
gitpm init [path]                    Создать skeleton схемы v2 (schedules, schedule-tracks, work-categories) в path (по умолчанию cwd)
gitpm status [--draft <id>]
gitpm draft create|open|status --draft <id> [--owner <id>]
gitpm draft set-writer ui|external --draft <id> [--owner <id>]
gitpm entity create [--draft <id>] --file <file> [--type <type>] [--project <id>] [--allow-delete]
gitpm entity update [--draft <id>] --type <type> --id <entity-id> [--file <yaml-patch>] [--set <field>=<yaml-value>]... [--unset <field>]... [--project <id>] [--allow-delete]
gitpm entity import [--draft <id>] --type <type> --format csv|yaml|jsonl (--file <file>|--path <file>) [--dry-run] [--project <id>] [--allow-delete]
gitpm entity list [--draft <id>] --type <type> [--project <id>]
gitpm entity show [--draft <id>] --type <type> --id <entity-id>
gitpm entity delete [--draft <id>] --type <type> --id <entity-id> [--unlink-references|--cascade-references] [--dry-run] [--allow-delete] [--project <id>]
gitpm entity archive [--draft <id>] --type <type> --id <entity-id> [--project <id>] [--allow-delete]
gitpm entity move [--draft <id>] --type task --id <entity-id> --to-project <id> [--to-milestone <id>] [--to-parent <task-id>] [--allow-delete] [--project <id>]
gitpm comment list --project <id> --task <id>
gitpm comment create --project <id> --task <id> (--body <text> | --file <path>)
gitpm comment update --project <id> --task <id> --id <comment-id> (--body <text> | --file <path>)
gitpm comment delete --project <id> --task <id> --id <comment-id>
gitpm time-entry list --project <id> --task <id> [--json]
gitpm time-entry summary --project <id> --task <id> [--after <yyyy-mm-dd>] [--json]
gitpm time-entry create --project <id> --task <id> --person <id> --date <yyyy-mm-dd> --hours <n> --category <slug> [--note <text>] [--json]
gitpm time-entry void --project <id> --task <id> --id <entry-id> [--json]
gitpm config show --kind statuses|issue-types|work-categories|schedule-tracks
gitpm config update --kind statuses|issue-types|work-categories|schedule-tracks [--file <yaml>] [--set <field>=<yaml-value>]... [--unset <field>] [--allow-delete]
gitpm schema list
gitpm schema show <type> [--example]
gitpm format [--draft <id>] [--project <id>] [--check] [--allow-delete]
gitpm validate [--draft <id>] [--project <id>] [--changed] [--allow-delete]
gitpm diff --semantic [--draft <id>] [--project <id>] [--allow-delete]
gitpm export [--draft <id>] --format pdf|html|csv|repository [--locale en|ru] [--section projects|people|project-details|gantt]... [--include-git] [--output <path>] [--force]
gitpm commit --all [--draft <id>] -m <message> [--project <id>] [--allow-delete]
gitpm push [--draft <id>]
gitpm mr create --draft <id> --owner <id> --title <title> [--description <text>]
gitpm doctor
gitpm --version [--json]
```

`gitpm export` использует единый с web/API сервис экспорта. PDF по умолчанию содержит
разделы Projects и People; повторяемый `--section` добавляет или явно задаёт состав.
HTML создаётся одним автономным файлом без мутаций, CSV — ZIP с таблицей для каждой
repository schema, repository ZIP — без `.git` по умолчанию или с переносимой
историей при `--include-git`. Имя связано с датой `HEAD`-коммита и его short hash.
Подробнее: [`Export.md`](Export.md).

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
числовые поля (`weekly_capacity_hours`, а также `effort_hours` внутри `schedules.<track>`) разбираются как числа, а списочные
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
и сущностей внутри удаляемого Project (`cascaded_entities`), а также документов, которые будут
отвязаны (`would_unlink`, только для Person). `--unlink-references` удаляет ссылки на Person перед
удалением (поддерживается только для `person`; другие типы вызывают `DELETE_UNLINK_UNSUPPORTED`).
`--cascade-references` атомарно удаляет все принадлежащие Project сущности перед удалением самого
Project (поддерживается только для `project`; другие типы вызывают `DELETE_CASCADE_UNSUPPORTED`).
Без подходящего явного режима подтверждения ссылки вызывают `DELETE_RESTRICTED` со
структурированным списком всех затронутых файлов.

`entity archive` устанавливает `lifecycle: archived` (обратимо); файл остаётся, ссылки
остаются валидными.

`entity move` атомарно перемещает Task, всё её поддерево и комментарии в другой Project
и опционально другой Milestone. `--to-parent` прикрепляет корень перемещаемого поддерева
к Task целевого Project и Milestone; циклы запрещены. Все потомки получают целевые
`project` и `milestone`, а их внутренние связи `parent` сохраняются. Cross-project
зависимости `schedules.<track>.depends_on` блокируются validation.

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
`--allow-delete` при каждой следующей мутации, а также при format/validation/diff и commit,
пока удалённые пути остаются в checkout. Флаг подтверждает весь текущий набор физических
удалений; он не создаёт новые удаления сам по себе.

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

`gitpm init` создаёт валидный schema-v2 skeleton (включая `.gitpm/schedule-tracks.yaml` и `.gitpm/work-categories.yaml`), корневой `.gitignore`,
корневой `.ignore` и `uploads/.gitkeep`. Входные файлы под `uploads/`
игнорируются Git; каталог разрешён через `allowed_top_level_directories` и не
является domain storage. `.ignore` возвращает `uploads/` в область поиска
инструментов на базе `ripgrep` (включая OpenCode), не отменяя правил Git.
ID стандартного Calendar генерируется при запуске из текущего года и не
зашит в шаблон.

`gitpm diff --semantic` требует configured direct runtime либо `--draft` в
worktree mode. Переданный отдельно `--root` достаточен для `format`,
`validate` и `doctor`, но не создаёт Git before/after context для semantic
diff; в таком случае CLI возвращает `CLI_DIRECT_CONFIGURATION_REQUIRED`,
а не пустой успешный diff.

В JSON-ответе semantic diff поле `file_entities` классифицирует каждый
изменённый GitPM-файл по `path` и `schema`. Для сущностей оно также содержит
`id` и, когда документ имеет `name` или `title`, нормализованное
`display_name`. Это позволяет интерфейсам показывать предметный тип и
читаемое имя независимо от того, какое именно поле сущности изменилось.

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
| `GITPM_GITLAB_URL` | HTTP(S) base URL GitLab-инстанса для `mr create`. |
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
| `GITPM_GITLAB_URL` | — | HTTP(S) base URL GitLab-инстанса, например `http://gitlab.local` или `https://gitlab.example`. Обычный HTTP используйте только в доверенной локальной сети. |
| `GITPM_GITLAB_PROJECT` | — | `group/project` для MR. |
| `GITPM_GITLAB_CLIENT_ID` | — | OAuth Application ID, зарегистрированный в GitLab. |
| `GITPM_GITLAB_REDIRECT_URI` | `http://127.0.0.1:3000/api/auth/callback` | Redirect URI OAuth. На сервере указать внешний URL (например `http://10.0.0.1:86/api/auth/callback`). |
| `GITPM_GITLAB_AUTH_MODE` | — | `oauth-identity-project-token` для многопользовательского режима либо отдельный legacy-режим `user-oauth-publication`. |
| `GITPM_GITLAB_PROJECT_TOKEN` | — | Серверный Project Access Token единственного настроенного проекта; не сохраняется и не возвращается через HTTP. |
| `GITPM_GITLAB_PROJECT_TOKEN_FILE` | — | Альтернативный путь к Docker Secret с Project Access Token. Нельзя задавать вместе с `GITPM_GITLAB_PROJECT_TOKEN`. |
| `GITPM_COOKIE_SECURE` | `true` | Когда web UI опубликован по plain HTTP (без TLS-терминатора), поставьте `false` — иначе браузер не примет сессионную cookie. |
| `GITPM_PUSH_REMOTE_URL` | auto из `origin` | Override push-remote URL. Принимает credential-free HTTP(S) или SSH (`http://...`, `https://...`, `ssh://...`, `git@host:path`). Логин/пароль/токен в самом URL запрещены. |

Если connection fields не заданы через environment, Maintainer может настроить
credential-free `origin`, GitLab project и OAuth Application ID в web UI.
Секреты через UI не принимаются; access token остаётся только в памяти процесса.

### Репозиторий без GitLab (SSH или HTTP(S)-токен)

GitPM публикует не только в GitLab: origin может указывать на любой git-хостинг.
Способ авторизации определяется транспортом URL и переменными окружения ниже.
Секреты (ключи и токены) хранятся только в памяти процесса и никогда не попадают
в URL, argv, git config, временные файлы или логи.

| Переменная | Назначение |
|------------|------------|
| `GITPM_SSH_KEY_PATH` | Абсолютный путь к приватному SSH-ключу вне worktree (например, примонтированный Docker secret). Используется как `ssh -i`. Без значения применяется проброс `SSH_AUTH_SOCK` (ssh-agent). |
| `GITPM_SSH_KNOWN_HOSTS_FILE` | Путь к `known_hosts`. По умолчанию файл под контролируемым home GitPM. |
| `GITPM_SSH_STRICT_HOST_KEY_CHECKING` | `yes` (только заранее известные хосты) или `accept-new` (по умолчанию: добавлять новые, отвергать изменённые). |
| `GITPM_SSH_COMMAND` | Полная переопределённая команда запуска ssh (только для администратора; пользовательский ввод не попадает в argv). |
| `GITPM_REMOTE_TOKEN` | Токен (PAT/deploy token) для HTTP(S)-репозиториев без GitLab. Передаётся в git через controlled `GIT_ASKPASS`, в логи/config не пишется. Для SSH игнорируется. |

Для SSH: задайте `GITPM_PUSH_REMOTE_URL=git@host:group/project.git` и подведите
ключ через `GITPM_SSH_KEY_PATH` или ssh-agent. Для HTTP(S) без GitLab: задайте
`GITPM_PUSH_REMOTE_URL=http://gitlab.local/group/project.git` (или HTTPS URL) и `GITPM_REMOTE_TOKEN`.
Merge Requests через GitPM доступны только для GitLab; по SSH/HTTP(S)-токену
ветка пушится в origin, но MR не создаётся.

При HTTP OAuth token/PAT и содержимое репозитория передаются без транспортного
шифрования. Такой режим предназначен только для доверенной локальной сети; для
любого недоверенного сегмента используйте HTTPS или SSH.

## Сценарии

### Локально на Windows

`run-gitpm.bat` запускает сервер и web UI в dev-режиме. Авторизация не
требуется для локальных операций; наличие поддерживаемого HTTP(S)/SSH remote и GitLab OAuth
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
