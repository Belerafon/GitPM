# GitPM

GitPM — Git-first система управления проектами. Проекты, задачи, этапы, люди,
команды, календари, представления и комментарии хранятся в обычных YAML-файлах;
Git остаётся единственным источником бизнес-данных. Web UI и CLI используют один
доменный слой, одну валидацию и одни правила публикации.

Текущая версия пакетов — `0.1.0`. Release baseline v0.1 принят, после него продукт
продолжил развиваться: появился режим прямой работы с веткой по умолчанию,
транзакционные CLI-команды создания/изменения/импорта, project-centric интерфейс,
комментарии и уведомления, просмотр файлов, подробная история и Docker-профили.

## Что уже работает

- Project workspace с этапами, иерархией и ручным порядком задач;
- редактор задач, Board, read-only Gantt и расчёт Workload;
- каталог людей, профили, доступность, команды, календари и настройки справочников;
- комментарии к задачам, упоминания и уведомления;
- файловый и semantic diff, restore, commit-all, push и GitLab Merge Request;
- история коммитов, история сущности и diff отдельных файлов;
- read-only просмотр рабочего дерева с защитой от traversal, symlink и бинарных файлов;
- русский и английский интерфейс, адаптивная навигация и адресуемые маршруты;
- CLI для агентов без отдельного MCP/API и без прямого редактирования domain YAML;
- два режима репозитория: `direct` по умолчанию и изолированные draft worktree.

## Быстрый запуск на Windows

Требуются Node.js `20.19.2`, pnpm `10.12.1` через Corepack и системный Git.

```powershell
corepack pnpm install --frozen-lockfile
.\run-gitpm.bat
```

Launcher подготовит актуальный русскоязычный demo repository, запустит API на
`http://127.0.0.1:3000`, web UI на `http://127.0.0.1:5173` и откроет браузер.
Демо содержит 3 проекта, 6 этапов, 30 задач, 10 сотрудников, команды, календари
и сохранённые представления.

Чтобы использовать существующий GitPM repository, укажите его корень в
`.gitpm/config.json`:

```json
{
  "repositoryMode": "direct",
  "repository": "D:\\projects\\portfolio-data",
  "defaultBranch": "main"
}
```

В `direct` mode указанная папка и есть единственная рабочая копия: GitPM не
создаёт второй clone и remote `source`. Она должна быть обычным Git checkout на
настроенной основной ветке. Изменения коммитятся в ней и явным действием
публикуются fast-forward push в её единственный `origin`. Локальные изменения и
коммиты не требуют входа.

Credential-free HTTPS URL `origin`, GitLab project и OAuth Application ID можно
настроить в «Администрирование → Настройки репозитория», если их не зафиксировали
переменные окружения. OAuth token после входа хранится только в памяти процесса и
передаётся Git через controlled ASKPASS; в URL и Git config он не записывается.

Пустой schema-v1 repository можно создать CLI:

```powershell
node apps/cli/dist/index.js init D:\projects\portfolio-data
```

## Режимы репозитория

| | `direct` (по умолчанию) | `worktree` |
| --- | --- | --- |
| Рабочая копия | выбранный существующий checkout | bare repository и отдельный `git worktree` на draft |
| Ветка | настроенная основная ветка | `gitpm/<owner>/<draft>` |
| CLI | без `--draft` | с `--draft <id>` |
| Публикация | safe fast-forward push | push draft branch и GitLab MR |
| Writer mode | отсутствует | `ui` или `external` |

Режим задаётся через `repositoryMode` или `GITPM_REPOSITORY_MODE`; переменная
окружения имеет приоритет. GitPM не делает force push, rebase, автоматический
merge, hard reset или stash. Подробнее: [режимы репозитория](docs/Repository_Modes.md).

## CLI

После сборки CLI находится в `apps/cli/dist/index.js`; Docker-образ устанавливает
его как `gitpm` на `PATH`. Все команды поддерживают locale-neutral `--json`.

```bash
gitpm status --json
gitpm schema list --json
gitpm schema show task --example

gitpm entity create --type task --file /tmp/task.yaml --project P-26-7VWANM
gitpm entity update --type task --id T-26-5K0WZ2 --set status=done --project P-26-7VWANM
gitpm entity import --type person --format csv --file /tmp/people.csv --dry-run

gitpm format --check
gitpm validate --changed
gitpm diff --semantic
gitpm commit --all -m "Update delivery plan"
gitpm push
```

`entity create`, `entity update` и `entity import` выполняются транзакционно:
GitPM проверяет весь repository и откатывает затронутые файлы при ошибке.
Импорт CSV/YAML/JSONL атомарен для всего пакета. В `worktree` mode к рабочим
командам добавляется `--draft <id>`, а публикация завершается `gitpm mr create`.
Полный контракт флагов и переменных окружения находится в [документации CLI](docs/CLI.md).

## Docker

Для локального доверенного запуска скопируйте `.env.example` в `.env`, укажите
host path GitPM repository и запустите:

```bash
docker compose up -d --build
```

Будут опубликованы порты `3000` и `5173`, выбранный checkout смонтирован как
`/repository`, а runtime metadata сохраняется в volume `gitpm-data`. Для
LAN/server-профиля с одним опубликованным web-портом,
healthcheck, постоянной конфигурацией и GitLab OAuth используйте:

```bash
docker compose -f compose.yaml -f compose.server.yaml up -d --build
```

Обязательные и дополнительные переменные описаны в комментариях
`compose.server.yaml` и в [CLI/deployment reference](docs/CLI.md). Для публичного
доступа нужен отдельный TLS/reverse proxy и deployment review; встроенная GitLab
авторизация защищает remote-операции, а не заменяет perimeter authentication.

Версия сборки (штамп даты коммита, например `2026.07.23 1045`) захватывается из
`.git` единственный раз при сборке образа в `build-version.json` и показывается в
подвале сайдбара; без неё отображается прочерк `—`. Профиль в одной сборке с
OpenCode (Caddy + basic-auth) и полный порядок сборки/обновления описаны в
[docs/Deployment.md](docs/Deployment.md).

## Формат данных

```text
.gitpm/
  repository.yaml
  statuses.yaml
  issue-types.yaml
people/
teams/
calendars/
projects/
  P-26-....../
    project.yaml
    milestones/
    tasks/
    views/
    comments/<task-id>/
uploads/                 # ignored входные документы, не business data
```

У сущности один immutable ID вида `P-26-7K4M9Q`: префикс типа, две цифры
UTC-года и шесть криптографически случайных символов Crockford Base32. Project
является единственным path exception: его ID совпадает с именем каталога, а сама
сущность хранится в `project.yaml`.

JSON Schema 2020-12 лежат в `schemas/v1`. Канонический YAML использует UTF-8,
LF и два пробела; duplicate keys, aliases, custom tags, неизвестные схемы и
нарушения ссылок отклоняются. Полный контракт: [repository format v1](docs/GitPM_Repository_Format_v1.md).

`gitpm init` также создаёт `.gitignore` и `uploads/.gitkeep`. В `uploads/` можно
положить исходные PDF/DOCX/XLSX для разбора агентом; их содержимое игнорируется
Git и не входит в GitPM validation, semantic diff или публикацию.

## Архитектура репозитория исходного кода

- `apps/cli` — CLI и agent workflow;
- `apps/server` — HTTP API, runtime, OAuth и publication wiring;
- `apps/web` — React UI и locale packs;
- `packages/domain`, `validation`, `repository-format` — бизнес-операции и формат;
- `packages/drafts`, `git-client`, `gitlab`, `publishing` — рабочие копии и Git;
- `packages/changes`, `history`, `calendar`, `workload` — read models и расчёты;
- `schemas/v1`, `fixtures/schema-v1/demo`, `demo/portfolio` — контракты и примеры.

Бизнес-базы данных нет. Credentials живут только в памяти процесса и не должны
попадать в URL, Git config, argv, файлы или логи. Agent читает repository для
контекста, но изменяет GitPM-данные только через CLI.

## Разработка и проверка

Дополнительно нужен Python 3.11 с PyYAML для planning validators.

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm schema:verify
corepack pnpm planning:verify
```

`corepack pnpm verify` запускает полный набор, включая E2E и smoke; для локальной
итерации лучше начинать с узкого package/test target.

Низкоуровневые проверки завершённого planning/evidence set доступны отдельно:

```bash
python scripts/validate_planning.py
python scripts/test_planning_validator.py
python scripts/test_release_gate.py
python scripts/check_release_gate.py --gate release
```

## Документация

Навигация по актуальным руководствам, нормативным контрактам и историческим
release-планам собрана в [docs/README.md](docs/README.md). Начинать обычно стоит с:

- [CLI и environment reference](docs/CLI.md);
- [режимы репозитория](docs/Repository_Modes.md);
- [agent workflow](docs/GitPM_Agent_Workflow_v1.md);
- [repository format v1](docs/GitPM_Repository_Format_v1.md);
- [локальная эксплуатация](docs/runbooks/GitPM_Local_Operations_v0.1.md).
