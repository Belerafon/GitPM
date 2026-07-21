# GitPM CLI

CLI живёт в `apps/cli` и собирается в `apps/cli/dist/index.js`. В Docker-образе
он доступен как `gitpm` на `PATH` (через симлинк `/usr/local/bin/gitpm`).

## Команды

```
gitpm init [path]                    Создать skeleton схемы v1 в path (по умолчанию cwd)
gitpm draft create|open|status|set-writer --draft <id> [--owner <id>]
gitpm entity create --draft <id> --file <file> [--project <id>]
gitpm format [--draft <id>] [--project <id>] [--check]
gitpm validate [--draft <id>] [--project <id>] [--changed]
gitpm diff --semantic [--draft <id>] [--project <id>]
gitpm commit --all --draft <id> -m <message>
gitpm push --draft <id>
gitpm mr create --draft <id> --owner <id> --title <title> [--description <text>]
gitpm doctor
gitpm --version
```

Каждая команда поддерживает `--json` для машинно-читаемого вывода.

## Переменные окружения

### Инициализация репозитория (`gitpm init`)

| Переменная | По умолчанию | Назначение |
|------------|--------------|------------|
| `GITPM_INIT_BRANCH` | `main` | Имя ветки для initial commit. |
| `GITPM_INIT_AUTHOR_NAME` | `GitPM` | `user.name` для initial commit. |
| `GITPM_INIT_AUTHOR_EMAIL` | `gitpm@localhost` | `user.email` для initial commit. |
| `GITPM_INIT_MESSAGE` | `Initialise GitPM repository` | Текст initial commit. |

### Agent workflow (drafts, push, MR)

Эти переменные нужны для команд `draft/entity/commit/push/mr`. Без них CLI
работает в режиме read-only (`format`, `validate`, `diff`, `doctor`, `init`).

| Переменная | Назначение |
|------------|------------|
| `GITPM_DATA_DIR` | Каталог под drafts/worktrees (он же `dataDirectory` сервера). |
| `GITPM_REMOTE_URL` | URL push-remote. Для file-path remote требует `GITPM_ALLOW_LOCAL_REPOSITORY=1` или `GITPM_ALLOW_LOCAL_TEST_REMOTE=1`. |
| `GITPM_DEFAULT_BRANCH` | Бранч под который идут MR (по умолчанию `main`). |
| `GITPM_ASKPASS_PATH` | Скрипт git askpass для авторизации при push. По умолчанию `scripts/git-askpass.mjs`. |
| `GITPM_ACCESS_TOKEN` | Токен GitLab API. В логи/commits не попадает, передаётся только в in-memory calls. |
| `GITPM_AGENT_AUTHOR_NAME` | `user.name` для коммитов от лица агента (по умолчанию `GitPM Agent`). |
| `GITPM_AGENT_AUTHOR_EMAIL` | `user.email` для коммитов от лица агента. |

### Сервер (web UI, OAuth)

| Переменная | По умолчанию | Назначение |
|------------|--------------|------------|
| `GITPM_REPOSITORY_PATH` | из `.gitpm/config.json` | Путь к git-репозиторию со схемой v1. |
| `GITPM_DATA_DIR` | `<repository>/.gitpm-data` | Каталог под drafts сервера. |
| `GITPM_BIND_HOST` | `127.0.0.1` | Хост, на котором сервер слушает. |
| `GITPM_SERVER_PORT` (`PORT`) | `3000` | Порт API. |
| `GITPM_WEB_PORT` | `5173` | Порт web UI. |
| `GITPM_RUNTIME_MODE` | — | `production` переключает Vite в `preview` режим и включает Warning при отсутствии `GITPM_API_TARGET`. |
| `GITPM_API_TARGET` | `http://127.0.0.1:3000` | Куда Vite проксирует `/api`. На сервере не нужен, если web и api в одном хосте. |
| `GITPM_NO_BROWSER` | — | Любое непустое значение отключает попытку открыть браузер на Windows. |
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
требуется, push/MR отключён.

### Docker (локально)

```bash
GITPM_REPOSITORY_PATH=/path/to/portfolio docker compose up -d --build
```

Открывает `:3000` и `:5173` на `0.0.0.0` без auth. Подходит для разработки
и локального мульти-пользовательского доступа в доверенной сети.

### Docker (сервер)

См. `compose.server.yaml` и раздел README *Server deployment*. Привязка к
конкретному IP, OAuth к GitLab, опциональная cookie `Secure=false` для
plain-HTTP публикаций.
