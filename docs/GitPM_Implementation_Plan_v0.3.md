# GitPM: подробный план реализации

Версия документа: 0.3
Статус: актуальная архитектурная спецификация
Назначение: спецификация для последовательной разработки Git-first системы управления проектами и задачами с веб-интерфейсом, GitLab и агентами.

Авторитетные исполнимые документы:

- `GitPM_Work_Plan_v0.2.md` - этапы, зависимости, владельцы, проверки и release gates;
- `GitPM_Delivery_Policies_v0.1.md` - границы v0.1, права, квоты, сохранность draft и бюджеты производительности;
- `GitPM_Security_Baseline_v0.1.md` - ранняя модель угроз и обязательные контрмеры;
- `GitPM_Requirements_Traceability_v0.1.yaml` - машинно-проверяемая трассировка требований и тестов.

Архитектурный документ намеренно не дублирует исполнимый план этапов.


## 0. Связанные документы и порядок работы

Этот документ описывает целевую архитектуру и продуктовые решения.

Исполнение проекта ведется по отдельным документам:

- `docs/GitPM_Work_Plan_v0.2.md` - этапы разработки, зависимости, задачи, проверки, E2E-сценарии и критерии выхода;
- `docs/PROGRESS.md` - текущее состояние, завершенные работы, результаты проверок, блокировки и следующий шаг.

Правило работы:

1. Перед началом этапа обновить его статус в файле прогресса.
2. Выполнять задачи только в пределах активного этапа, если нет отдельно зафиксированного решения.
3. После реализации запустить все проверки, перечисленные в quality gate этапа.
4. Записать в файл прогресса команды, commit SHA, результаты тестов и известные ограничения.
5. Перевести этап в `done` только после выполнения всех критериев выхода.
6. При изменении архитектурного решения сначала обновить этот документ и добавить запись в журнал решений.

## 1. Цель проекта

GitPM должен предоставлять интерфейс управления проектами и задачами, сопоставимый по базовым возможностям с Jira, Linear и OpenProject, но с другой моделью хранения и публикации изменений.

Источник истины:

- обычный Git-репозиторий;
- проекты, задачи, сотрудники, этапы и календари хранятся в текстовых YAML-файлах;
- каждая сущность хранится в отдельном файле;
- все изменения доступны как обычный Git diff;
- рабочие изменения выполняются в отдельных ветках;
- публикация выполняется через commit, push и GitLab Merge Request;
- `main` защищена и не изменяется напрямую;
- восстановление удаленных или ошибочно измененных данных выполняется штатными средствами Git.

Система не должна строить собственный механизм версионирования поверх Git.

## 2. Зафиксированные продуктовые решения

### 2.1. Удаление

Физическое удаление разрешено.

Пользовательский интерфейс должен предоставлять две разные операции:

- Archive: сущность остается в репозитории, но исключается из активных представлений;
- Delete: файл сущности удаляется из рабочего дерева.

Удаление должно быть хорошо заметно в интерфейсе изменений, но не должно требовать специальной внутренней модели восстановления. Для восстановления используется Git.

Минимальные требования:

- перед удалением показывается подтверждение;
- удаленные файлы отображаются отдельной группой в разделе Changes;
- семантический diff показывает количество и типы удаленных сущностей;
- удаление не выполняется автоматически при совпадении названий;
- операции удаления всегда адресуются по неизменяемому ID;
- агенту разрешение на удаление задается политикой конкретного черновика или системной ролью.

### 2.2. Undo и восстановление

Отдельный механизм Undo не создается.

Используются штатные операции Git:

- discard изменений файла;
- discard выбранных строк или блоков;
- восстановление удаленного файла;
- восстановление файла из определенного commit;
- revert commit;
- закрытие или удаление ветки;
- создание revert Merge Request после merge.

Интерфейс должен быть похож по возможностям на GitExtensions, GitKraken или встроенный Git-интерфейс IDE, но ориентирован на пользователей системы управления проектами.

### 2.3. База данных

В первой версии постоянная база данных не используется.

Допустимое состояние вне Git:

- временные файлы сессий;
- OAuth-сессии;
- служебные lock-файлы;
- описание открытых worktree;
- кэш вычислений в памяти;
- локальный конфигурационный файл сервера;
- журналы приложения.

Ни одно бизнес-данное проекта не должно существовать только вне Git.

### 2.4. Модель параллельной работы

Каждый черновик пользователя или агента работает в отдельной Git-ветке и отдельном Git worktree.

Один пользователь может иметь несколько черновиков.

Черновик является основной рабочей единицей системы:

- создается от выбранной базовой ветки;
- имеет владельца;
- имеет собственное рабочее дерево;
- содержит незакоммиченные изменения;
- может иметь один или несколько commit;
- может быть отправлен в GitLab;
- может быть связан с Merge Request;
- после merge или закрытия может быть очищен.

## 3. Нефункциональные требования

### 3.1. Целевой масштаб

Первая версия проектируется для:

- 30 активных пользователей;
- 30 проектов;
- около 300-3000 задач;
- 1-10 одновременных активных черновиков;
- нескольких автоматических агентов;
- одного экземпляра GitPM Server.

Архитектура должна сохранять приемлемую производительность до примерно 100 000 YAML-файлов, но оптимизация под такой объем не входит в первую версию.

### 3.2. Развертывание

Минимальный production-вариант:

- один контейнер GitPM;
- persistent volume для bare-репозитория и worktree;
- доступ к существующему GitLab;
- reverse proxy;
- TLS;
- OAuth/OIDC авторизация через GitLab;
- установленный системный Git.

### 3.3. Надежность

Система должна быть устойчивой к:

- перезапуску процесса;
- незавершенной записи файла;
- конфликту обновления одного и того же файла;
- устаревшей базовой ветке;
- недоступности GitLab;
- ошибке push;
- ошибке создания Merge Request;
- падению процесса в момент commit;
- ручному изменению файлов в репозитории;
- невалидному YAML;
- попытке агента выйти за разрешенную область.

## 4. Предлагаемый технологический стек

### 4.1. Общий язык

TypeScript используется для:

- backend;
- frontend;
- CLI;
- MCP-сервера;
- модели данных;
- валидации;
- семантического diff;
- GitLab-клиента.

Преимущества:

- общие типы между клиентом и сервером;
- один набор схем и правил;
- проще повторно использовать код в CLI и сервере;
- меньше границ между компонентами;
- удобнее последующая генерация кода агентами.

### 4.2. Backend

Рекомендуемый стек:

- Node.js LTS;
- Fastify;
- Zod для runtime-типизации API;
- Ajv для JSON Schema;
- `yaml` или `yaml-eslint-parser` для строгого разбора YAML;
- системный бинарник `git`;
- `execa` для запуска процессов;
- `openid-client` или совместимая OIDC-библиотека;
- `pino` для журналирования;
- WebSocket или Server-Sent Events для обновления состояния UI.

### 4.3. Frontend

Рекомендуемый стек:

- React;
- TypeScript;
- Vite;
- React Router;
- TanStack Query;
- TanStack Table;
- Zustand или Redux Toolkit для локального состояния;
- dnd-kit для Kanban;
- Monaco Editor для YAML и diff;
- библиотека визуализации Gantt, выбираемая после прототипа;
- библиотека графов зависимостей при необходимости.

UI должен быть desktop-first, но оставаться работоспособным на планшете.

### 4.4. Monorepo

Рекомендуется pnpm workspace и Turborepo либо Nx.

Структура:

```text
gitpm/
  apps/
    web/
    server/
    cli/
    mcp/

  packages/
    domain/
    repository-format/
    validation/
    semantic-diff/
    git-client/
    gitlab-client/
    api-contract/
    ui-components/
    test-fixtures/

  schemas/
    project.schema.json
    task.schema.json
    person.schema.json
    team.schema.json
    milestone.schema.json
    calendar.schema.json
    repository.schema.json

  docs/
    architecture/
    format/
    api/
    agent/

  examples/
    demo-portfolio/

  scripts/
  docker/
  .gitlab-ci.yml
```

## 5. Формат репозитория данных

### 5.1. Общая структура

```text
portfolio/
  .gitpm/
    repository.yaml
    statuses.yaml
    issue-types.yaml
    permissions.yaml

  people/
    PER-0001.yaml
    PER-0002.yaml

  teams/
    TEAM-0001.yaml

  calendars/
    CAL-DEFAULT.yaml
    CAL-FINLAND.yaml

  projects/
    PRJ-0001/
      project.yaml

      milestones/
        MLS-0001.yaml

      tasks/
        TSK-000001.yaml
        TSK-000002.yaml

      attachments/
        TSK-000001/
          specification.pdf

    PRJ-0002/
      project.yaml
      milestones/
      tasks/

  views/
    portfolio.yaml
```

В первой версии attachments можно исключить или хранить через Git LFS.

### 5.2. Правила файлов

- одна сущность на файл;
- кодировка UTF-8;
- окончания строк LF;
- имена файлов соответствуют ID;
- ID не изменяется после создания;
- ID уникален в пределах всего репозитория;
- тип сущности определяется схемой и расположением файла;
- неизвестные файлы не должны ломать загрузку, но должны выдавать предупреждение;
- временные файлы редакторов игнорируются;
- все YAML-файлы приводятся к каноническому формату перед commit.

### 5.3. Формат ID

Предлагаемый формат:

```text
PER-0001
TEAM-0001
CAL-0001
PRJ-0001
MLS-000001
TSK-000001
```

Правила:

- префикс определяет тип;
- числовая часть не переиспользуется после удаления;
- ID выдается сервером;
- агент может запросить резервирование диапазона или создание сущности без самостоятельного выбора ID;
- генератор ID читает максимальное значение в репозитории и использует локальный lock внутри worktree.

Для предотвращения конфликтов между ветками лучше рассмотреть идентификаторы на базе ULID:

```text
TSK-01J2BZ7G4VJ57PX9K2Q0C6C5XP
```

Практический компромисс:

- человекочитаемый короткий project key;
- глобальный ULID для сущностей;
- отдельное поле `number` для отображения.

Пример:

```yaml
id: 01J2BZ7G4VJ57PX9K2Q0C6C5XP
key: TSK-142
```

Для первой версии допустимо использовать ULID как единственный технический ID и отдельный display key.

### 5.4. Пример project.yaml

```yaml
schema: gitpm/project@1

id: 01J2BZA35YJGY8Z4T1P8JZ2TYP
key: PRJ-0017
name: Импорт заказов

status: active
owner: PER-0007

start: 2026-07-15
due: 2026-09-04

description: |-
  Проект интеграции заказов из внешней системы.

labels:
  - integration
  - backend

lifecycle: active
```

### 5.5. Пример task.yaml

```yaml
schema: gitpm/task@1

id: 01J2BZ7G4VJ57PX9K2Q0C6C5XP
key: TSK-0142

project: PRJ-0017
title: Реализовать идемпотентный импорт заказов

type: task
status: planned
priority: normal

parent: null
milestone: MLS-000004

assignees:
  - person: PER-0007
    estimate_hours: 24

start: 2026-07-20
due: 2026-07-31

depends_on:
  - TSK-0138

labels:
  - backend
  - integration

description: |-
  Реализовать импорт заказов из внешней системы.

acceptance_criteria:
  - Повторный импорт не создает дубликаты.
  - Ошибочные строки попадают в отчет.

lifecycle: active
```

### 5.6. Архивирование

Архивирование не удаляет файл:

```yaml
lifecycle: archived
archived_at: 2026-07-10T12:30:00Z
archived_by: PER-0007
archive_reason: Заменена новой задачей
```

Архивированные сущности по умолчанию скрыты из активных представлений.

### 5.7. Удаление

Удаление означает удаление файла из worktree.

Зависимые сущности обрабатываются одним из режимов:

- `restrict`: удаление запрещено, пока есть ссылки;
- `cascade`: зависимые сущности также удаляются;
- `detach`: ссылки очищаются;
- `manual`: UI показывает зависимости и требует ручного решения.

Для первой версии используется только `restrict`.

При удалении задачи сервер проверяет:

- дочерние задачи;
- зависимости других задач;
- ссылки из milestones;
- упоминания в конфигурации представлений.

Если есть ссылки, удаление блокируется с понятным списком зависимостей.

## 6. Каноническое форматирование YAML

Нужен собственный formatter, который:

- сохраняет фиксированный порядок полей;
- использует два пробела;
- не использует flow-style объекты;
- нормализует пустые значения;
- форматирует даты как строки;
- запрещает anchors и aliases;
- сохраняет multiline-текст через `|-`;
- сортирует labels;
- сохраняет порядок assignees и acceptance criteria;
- не сортирует пользовательские списки, где порядок имеет значение.

Команда:

```bash
gitpm format
gitpm format --check
gitpm format path/to/file.yaml
```

Перед commit сервер автоматически запускает formatter.

## 7. Валидация и линтер

### 7.1. CLI

```bash
gitpm validate
gitpm validate --changed
gitpm validate --scope PRJ-0017
gitpm lint
gitpm lint --format json
gitpm doctor
```

Разница:

- `validate`: проверка данных и ссылочной целостности;
- `lint`: предупреждения и рекомендации;
- `doctor`: проверка репозитория, Git, конфигурации и окружения.

### 7.2. Уровни проверки

#### Уровень A. Синтаксис

- корректный YAML;
- запрет повторяющихся ключей;
- запрет anchors;
- запрет aliases;
- запрет пользовательских tags;
- UTF-8;
- допустимое имя файла;
- отсутствие BOM;
- отсутствие бинарного содержимого в YAML.

#### Уровень B. JSON Schema

- обязательные поля;
- типы;
- перечисления;
- форматы;
- ограничения чисел;
- неизвестные поля;
- версии схем.

#### Уровень C. Репозиторная целостность

- уникальные ID;
- уникальные display keys;
- существующие проекты;
- существующие люди;
- существующие milestones;
- существующие parent;
- существующие dependencies;
- отсутствие parent-циклов;
- отсутствие dependency-циклов;
- соответствие пути и project;
- соответствие имени файла и key/ID;
- корректные даты;
- задачи не выходят за допустимые границы проекта, если правило включено.

#### Уровень D. Политики изменений

- область разрешенных проектов;
- разрешенные типы операций;
- разрешено ли удаление;
- ограничение числа удалений;
- ограничение числа измененных файлов;
- запрет изменения `.gitpm/permissions.yaml`;
- запрет изменения людей агентом;
- запрет изменения основной конфигурации;
- запрет выхода за выделенный каталог;
- проверка base revision;
- проверка, что изменения основаны на ожидаемой версии файла.

### 7.3. Формат ошибок

Каждая ошибка имеет:

- код;
- severity;
- путь;
- сущность;
- поле;
- сообщение;
- технические детали;
- возможное исправление.

Пример:

```json
{
  "code": "E_REFERENCE_NOT_FOUND",
  "severity": "error",
  "path": "projects/PRJ-0017/tasks/TSK-0142.yaml",
  "entity": "TSK-0142",
  "field": "depends_on[0]",
  "message": "Зависимая задача TSK-0138 не найдена",
  "suggestion": "Исправьте ID или удалите ссылку"
}
```

### 7.4. Линтер для агентов

Агентам предоставляется тот же CLI и API:

```bash
gitpm lint --changed --format json
gitpm validate --changed --format json
gitpm diff --semantic --format json
```

Для агента желательно добавить команду:

```bash
gitpm explain E_REFERENCE_NOT_FOUND
```

Она возвращает:

- смысл правила;
- правильный пример;
- неправильный пример;
- способы исправления.

### 7.5. GitLab CI

Pipeline должен запускать:

```bash
gitpm format --check
gitpm validate
gitpm diff --semantic --base origin/main
gitpm report --output public/
```

Артефакты pipeline:

- semantic-diff.json;
- semantic-diff.md;
- workload-report.html;
- gantt-report.html;
- validation-report.json.

## 8. Git-модель

### 8.1. Bare clone

Сервер хранит bare clone:

```text
/data/repositories/<repository-id>.git
```

Рабочие деревья:

```text
/data/worktrees/<repository-id>/<draft-id>/
```

### 8.2. Создание draft

Команды:

```bash
git --git-dir=/data/repositories/portfolio.git fetch origin

git --git-dir=/data/repositories/portfolio.git \
  worktree add \
  -b users/<user-id>/<draft-id> \
  /data/worktrees/portfolio/<draft-id> \
  origin/main
```

Draft metadata:

```json
{
  "id": "drf_01J...",
  "owner": "gitlab-user-id",
  "branch": "users/42/drf_01J...",
  "baseBranch": "main",
  "baseCommit": "abc123",
  "worktreePath": "/data/worktrees/portfolio/drf_01J...",
  "createdAt": "2026-07-10T12:00:00Z",
  "mergeRequestIid": null
}
```

Metadata можно хранить в JSON-файлах. После перезапуска сервер дополнительно сверяет их с `git worktree list --porcelain`.

### 8.3. Статусы draft

```text
creating
ready
dirty
validating
invalid
committed
pushing
pushed
mr_open
mr_merged
mr_closed
conflicted
broken
deleting
deleted
```

### 8.4. Рабочие блокировки

Для каждого worktree используется файловая блокировка.

Операции, требующие exclusive lock:

- запись файла;
- format;
- validate с автоматическим исправлением;
- commit;
- rebase;
- checkout;
- restore;
- push;
- удаление worktree.

Чтение модели может выполняться параллельно.

### 8.5. Оптимистическая проверка файла

Каждая команда изменения отправляет:

- entity ID;
- ожидаемый Git blob SHA;
- набор изменений.

Если blob SHA не совпадает:

```text
409 CONFLICT
E_FILE_VERSION_MISMATCH
```

UI должен предложить:

- перезагрузить текущую версию;
- открыть diff;
- повторно применить изменения вручную.

### 8.6. Commit

Порядок:

1. проверить статус worktree;
2. выполнить format;
3. выполнить validate;
4. вычислить semantic diff;
5. показать commit dialog;
6. записать author;
7. выполнить `git add`;
8. выполнить `git commit`;
9. вернуть commit SHA.

Commit message:

```text
PRJ-0017: add import implementation tasks
```

Дополнительные trailers:

```text
GitPM-Draft: drf_01J...
GitPM-Actor: user:42
GitPM-Projects: PRJ-0017
```

### 8.7. Push

Перед push:

- `git fetch origin`;
- проверить, что remote branch не изменена неожиданно;
- проверить наличие локальных commit;
- проверить состояние target branch;
- при необходимости предложить rebase.

Push:

```bash
git push --set-upstream origin users/42/drf_01J...
```

### 8.8. Rebase

UI предоставляет:

- Update from main;
- Rebase onto main;
- Abort rebase;
- Continue rebase;
- Resolve conflicts.

Автоматический rebase разрешен только при отсутствии конфликтов.

При конфликте пользователь переходит в специальный экран conflict resolution.

### 8.9. Очистка

После merge или закрытия MR:

- worktree не удаляется автоматически немедленно;
- draft помечается завершенным;
- через настраиваемый срок предлагается очистка;
- ветка удаляется только отдельной операцией;
- удаление ветки не влияет на историю merge.

## 9. Git-интерфейс в UI

### 9.1. Раздел Changes

Раздел должен показывать:

- staged;
- unstaged;
- added;
- modified;
- deleted;
- renamed;
- conflicted;
- ignored.

В первой версии staging area можно скрыть и считать все изменения unstaged до commit. Однако backend должен поддерживать выборочную индексацию файлов, чтобы позже добавить staged workflow.

### 9.2. Файловый diff

Для каждого файла:

- имя;
- тип сущности;
- статус;
- количество добавленных и удаленных строк;
- side-by-side diff;
- unified diff;
- переход к следующему изменению;
- сворачивание неизмененных строк.

### 9.3. Операции восстановления

Минимальный набор:

- Restore entire file;
- Restore selected hunk;
- Restore deleted file;
- Restore file from commit;
- Discard all uncommitted changes.

Restore произвольного набора строк не входит в Alpha и MVP. Он рассматривается после Alpha только при наличии подтвержденной пользовательской потребности и отдельного набора property-based и cross-platform patch tests.

Реализация:

- файл: `git restore -- path`;
- staged файл: `git restore --staged -- path`;
- hunk: построение reverse patch и `git apply -R`;
- удаленный файл: `git restore --source=HEAD -- path`;
- файл из commit: `git restore --source=<sha> -- path`.

Операция над hunk должна выполняться только после проверки, что файл не изменился с момента построения diff.

### 9.4. История

Экран History:

- граф commit;
- ветки;
- автор;
- дата;
- сообщение;
- затронутые проекты;
- количество файлов;
- semantic summary;
- GitLab MR;
- pipeline status.

Операции:

- Open commit;
- Compare with current;
- Restore file from commit;
- Create revert draft;
- Copy SHA.

### 9.5. Revert commit

Revert выполняется в новой или текущей draft-ветке:

```bash
git revert <sha>
```

Если commit уже в `main`, рекомендуется:

1. создать новую draft от `main`;
2. выполнить revert;
3. показать diff;
4. отправить отдельный MR.

### 9.6. Удаленные файлы

Для deleted-файлов UI показывает:

- тип удаленной сущности;
- key;
- title из предыдущей версии;
- путь;
- commit, в котором файл появился;
- ссылки на зависимые изменения;
- кнопку Restore.

## 10. Семантический diff

### 10.1. Назначение

Обычный Git diff показывает строки. Semantic diff показывает смысл изменения.

### 10.2. Типы изменений

- project.created;
- project.updated;
- project.deleted;
- task.created;
- task.updated;
- task.archived;
- task.unarchived;
- task.deleted;
- milestone.created;
- milestone.updated;
- milestone.deleted;
- person.created;
- person.updated;
- person.deleted;
- assignment.changed;
- dependency.added;
- dependency.removed;
- schedule.changed;
- configuration.changed.

### 10.3. Поля semantic diff

Для каждой сущности:

```json
{
  "entityType": "task",
  "entityKey": "TSK-0142",
  "changeType": "updated",
  "path": "projects/PRJ-0017/tasks/TSK-0142.yaml",
  "before": {},
  "after": {},
  "fields": [
    {
      "field": "due",
      "before": "2026-07-31",
      "after": "2026-08-07"
    }
  ]
}
```

### 10.4. Агрегаты

- добавлено задач;
- изменено задач;
- удалено задач;
- архивировано задач;
- затронуто проектов;
- изменен срок проекта;
- изменена суммарная оценка;
- появилась перегрузка;
- исчезла перегрузка;
- добавлены циклы;
- удалены зависимости;
- изменены исполнители.

### 10.5. Представление

Semantic diff отображается:

- в UI;
- в commit dialog;
- в MR description;
- в CI artifact;
- в MCP output для агента.

## 11. Доменная модель backend

### 11.1. Основные сущности

- Repository;
- Draft;
- Project;
- Task;
- Milestone;
- Person;
- Team;
- Calendar;
- Assignment;
- Dependency;
- ViewConfiguration;
- ValidationIssue;
- SemanticChange;
- GitCommit;
- MergeRequest.

### 11.2. Загруженная модель

```ts
interface PortfolioModel {
  revision: string;
  projectsByKey: Map<string, Project>;
  tasksByKey: Map<string, Task>;
  peopleByKey: Map<string, Person>;
  milestonesByKey: Map<string, Milestone>;
  teamsByKey: Map<string, Team>;
  calendarsByKey: Map<string, Calendar>;
  taskChildren: Map<string, string[]>;
  taskDependencies: Map<string, string[]>;
  reverseDependencies: Map<string, string[]>;
}
```

### 11.3. Загрузка данных

Загрузка:

1. найти `.gitpm/repository.yaml`;
2. определить версию формата;
3. обойти известные директории;
4. разобрать YAML;
5. выполнить schema validation;
6. построить индексы;
7. выполнить cross-reference validation;
8. вычислить агрегаты.

### 11.4. Инкрементальное обновление

При сохранении одного файла:

1. прочитать старую сущность;
2. записать файл атомарно;
3. перечитать новую сущность;
4. обновить соответствующий индекс;
5. пересчитать зависимые агрегаты;
6. отправить событие UI.

Если инкрементальное обновление не удалось, полностью перечитать worktree.

### 11.5. Атомарная запись

Запись файла:

1. сериализовать в память;
2. записать во временный файл рядом;
3. `fsync`;
4. переименовать через atomic rename;
5. при необходимости `fsync` каталога.

## 12. REST API

### 12.1. Аутентификация

```text
GET  /api/auth/login
GET  /api/auth/callback
POST /api/auth/logout
GET  /api/auth/me
```

### 12.2. Репозитории

```text
GET  /api/repositories
GET  /api/repositories/:repositoryId
POST /api/repositories/:repositoryId/fetch
GET  /api/repositories/:repositoryId/status
```

### 12.3. Draft

```text
GET    /api/repositories/:repositoryId/drafts
POST   /api/repositories/:repositoryId/drafts
GET    /api/drafts/:draftId
DELETE /api/drafts/:draftId

POST /api/drafts/:draftId/update-from-base
POST /api/drafts/:draftId/rebase
POST /api/drafts/:draftId/rebase/abort
POST /api/drafts/:draftId/rebase/continue
```

### 12.4. Проекты

```text
GET  /api/drafts/:draftId/projects
GET  /api/drafts/:draftId/projects/:projectKey
POST /api/drafts/:draftId/projects
PATCH /api/drafts/:draftId/projects/:projectKey
POST /api/drafts/:draftId/projects/:projectKey/archive
POST /api/drafts/:draftId/projects/:projectKey/unarchive
DELETE /api/drafts/:draftId/projects/:projectKey
```

### 12.5. Задачи

```text
GET  /api/drafts/:draftId/tasks
GET  /api/drafts/:draftId/tasks/:taskKey
POST /api/drafts/:draftId/tasks
PATCH /api/drafts/:draftId/tasks/:taskKey
POST /api/drafts/:draftId/tasks/:taskKey/archive
POST /api/drafts/:draftId/tasks/:taskKey/unarchive
DELETE /api/drafts/:draftId/tasks/:taskKey
```

### 12.6. Люди

```text
GET  /api/drafts/:draftId/people
GET  /api/drafts/:draftId/people/:personKey
POST /api/drafts/:draftId/people
PATCH /api/drafts/:draftId/people/:personKey
DELETE /api/drafts/:draftId/people/:personKey
```

### 12.7. Валидация

```text
POST /api/drafts/:draftId/format
POST /api/drafts/:draftId/validate
GET  /api/drafts/:draftId/validation
```

### 12.8. Git changes

```text
GET  /api/drafts/:draftId/git/status
GET  /api/drafts/:draftId/git/diff
GET  /api/drafts/:draftId/git/diff/:path
GET  /api/drafts/:draftId/git/semantic-diff

POST /api/drafts/:draftId/git/restore/file
POST /api/drafts/:draftId/git/restore/hunk
POST /api/drafts/:draftId/git/restore/lines
POST /api/drafts/:draftId/git/restore/all

POST /api/drafts/:draftId/git/commit
POST /api/drafts/:draftId/git/push
POST /api/drafts/:draftId/git/revert
```

### 12.9. GitLab

```text
POST /api/drafts/:draftId/gitlab/merge-request
GET  /api/drafts/:draftId/gitlab/merge-request
POST /api/gitlab/webhook
```

### 12.10. История

```text
GET /api/repositories/:repositoryId/history
GET /api/repositories/:repositoryId/commits/:sha
GET /api/repositories/:repositoryId/compare
GET /api/repositories/:repositoryId/files/:path/history
```

## 13. GitLab-интеграция

### 13.1. Авторизация

Предпочтительный вариант:

- GitLab OIDC для входа;
- пользовательский OAuth token для API;
- push выполняется от имени пользователя;
- Git author устанавливается по данным GitLab;
- права проверяет GitLab.

### 13.2. Минимальные scopes

- `openid`;
- `profile`;
- `email`;
- `api`;
- `write_repository`.

### 13.3. Хранение token

- token шифруется на сервере;
- ключ шифрования передается через secret;
- token не пишется в log;
- token не помещается в URL;
- Git authentication выполняется через временный credential helper или `GIT_ASKPASS`;
- refresh token обновляется автоматически.

### 13.4. Создание MR

Поля:

- source branch;
- target branch;
- title;
- description;
- draft flag;
- labels;
- assignee;
- reviewer;
- remove source branch;
- squash option.

MR description генерируется из semantic diff.

### 13.5. Webhooks

Обрабатываются:

- push;
- merge request;
- pipeline;
- job;
- branch deletion.

Webhook должен проверять secret token.

### 13.6. Защита main

GitLab:

- direct push запрещен;
- merge только через MR;
- обязательный successful pipeline;
- минимум один approval;
- запрет self-approval при необходимости;
- CODEOWNERS для критичных конфигурационных файлов.

## 14. Пользовательский интерфейс

### 14.1. Общая компоновка

Левая панель:

- Portfolio;
- Projects;
- My work;
- Board;
- Gantt;
- Workload;
- People;
- Changes;
- History;
- Settings.

Верхняя панель:

- repository;
- draft;
- base branch;
- Git status;
- validation status;
- MR status;
- кнопки Commit и Push.

### 14.2. Portfolio

Показывает:

- список проектов;
- статус;
- owner;
- прогресс;
- start/due;
- просроченные задачи;
- перегрузки;
- последние изменения.

### 14.3. Project

Вкладки:

- Overview;
- Tasks;
- Board;
- Gantt;
- Milestones;
- Workload;
- Activity;
- Files.

### 14.4. Task list

Функции:

- виртуализированный список;
- сортировка;
- фильтрация;
- группировка;
- массовое редактирование;
- inline edit;
- изменение порядка;
- сохраненные views;
- выбор колонок.

### 14.5. Board

- колонки по status;
- drag-and-drop;
- фильтры;
- swimlanes по assignee или milestone;
- ограничение WIP опционально;
- изменения сразу записываются в YAML.

### 14.6. Task panel

Поля:

- title;
- description;
- status;
- type;
- priority;
- project;
- milestone;
- parent;
- assignees;
- estimates;
- dates;
- dependencies;
- labels;
- acceptance criteria;
- lifecycle.

Дополнительно:

- путь к файлу;
- last commit;
- last author;
- open in Changes;
- open raw YAML;
- delete;
- archive.

### 14.7. Workload

Расчет:

- по неделям;
- по сотрудникам;
- на основе estimate_hours;
- с учетом capacity;
- с учетом календаря;
- распределение оценки по рабочим дням между start и due.

Первая версия может использовать равномерное распределение.

### 14.8. Gantt

Минимально:

- задачи;
- milestones;
- dependencies;
- drag start/due;
- изменение длительности;
- сворачивание дерева;
- критические ошибки зависимостей;
- фильтр проекта;
- сохранение изменений в YAML.

Автоматическое планирование можно отложить.

### 14.9. Changes

Обязательный раздел первой версии.

Возможности:

- список измененных файлов;
- фильтр Added/Modified/Deleted/Renamed;
- обычный diff;
- semantic diff;
- restore file;
- restore hunk;
- restore lines;
- restore deleted file;
- validate;
- format;
- commit;
- push;
- create MR.

### 14.10. History

- commit graph;
- ветки;
- MR;
- semantic summary;
- просмотр файлов;
- сравнение commit;
- создание revert draft.

## 15. Agent API и MCP

### 15.1. Принцип

Агент работает в отдельном draft и не пишет в `main`.

### 15.2. MCP tools

```text
repository_list
repository_get

draft_create
draft_get
draft_delete
draft_validate
draft_diff
draft_commit
draft_push
draft_create_merge_request

project_list
project_get
project_create
project_update
project_delete
project_archive

task_search
task_get
task_create
task_update
task_delete
task_archive
task_bulk_create
task_bulk_update

person_list
person_get

git_status
git_diff
git_restore_file
git_restore_hunk
```

### 15.3. Политика агента

При создании draft задаются:

```yaml
actor: agent-planner

scope:
  projects:
    - PRJ-0017

operations:
  create: true
  update: true
  archive: true
  delete: false

limits:
  max_changed_files: 100
  max_created_tasks: 50
  max_deleted_tasks: 0
```

Для доверенного агента delete можно включить:

```yaml
operations:
  delete: true

limits:
  max_deleted_tasks: 20
```

### 15.4. Прямое редактирование файлов

Допускается два режима.

Доменный режим:

- предпочтительный;
- агент вызывает task_create/task_update;
- сервер форматирует и валидирует.

Файловый режим:

- агент получает путь worktree;
- редактирует YAML напрямую;
- перед commit обязательно запускает `gitpm format` и `gitpm validate`;
- сервер все равно применяет policy validation перед push.

### 15.5. Ответы агенту

Ошибки возвращаются структурированно.

Агент должен получать:

- ошибки;
- предупреждения;
- измененные файлы;
- semantic diff;
- рекомендации;
- список разрешенных операций;
- текущее base commit.

## 16. Безопасность

Обязательный baseline и ранняя модель угроз определены в `GitPM_Security_Baseline_v0.1.md`. Контрмеры реализуются вместе с соответствующими компонентами; финальный hardening только подтверждает их полноту.

### 16.1. Path traversal

Любой путь нормализуется и проверяется:

- должен находиться внутри worktree;
- symlink запрещены или строго контролируются;
- нельзя обращаться к `.git`;
- нельзя использовать `..`;
- нельзя читать произвольные файлы сервера.

### 16.2. Git command injection

- аргументы передаются массивом;
- shell не используется;
- branch names валидируются;
- commit message передается через stdin или файл;
- remote URL задается конфигурацией;
- пользователь не задает произвольные Git options.

### 16.3. YAML

- безопасный parser;
- запрет custom tags;
- запрет alias explosion;
- ограничение размера файла;
- ограничение глубины;
- ограничение длины строк.

### 16.4. OAuth

- PKCE;
- state;
- nonce;
- secure cookies;
- SameSite;
- CSRF protection;
- short-lived sessions;
- token encryption.

### 16.5. Permissions

Сервер проверяет:

- GitLab membership;
- repository access;
- branch permissions;
- operation policy;
- entity scope.

### 16.6. Audit

Отдельный бизнес-аудит не создается.

Достаточно:

- Git history;
- GitLab MR history;
- application logs для технических событий;
- trailers в commit;
- correlation ID.

## 17. Производительность

### 17.1. Загрузка

Для 300-3000 задач допустима полная загрузка worktree.

Целевые значения:

- загрузка portfolio до 1000 задач: менее 500 мс;
- до 10 000 задач: менее 2 секунд;
- semantic diff до 100 файлов: менее 1 секунды;
- validation до 10 000 файлов: менее 3 секунд.

### 17.2. Кэш в памяти

Допустимые кэши:

- parsed YAML;
- entity maps;
- dependency graph;
- workload aggregates;
- last Git status;
- last semantic diff.

Кэш инвалидируется по:

- записи через API;
- изменению worktree;
- webhook;
- явному refresh;
- периодическому lightweight scan.

### 17.3. File watching

Для открытых worktree можно использовать `chokidar`.

Watcher нужен только для обнаружения внешних изменений. Основной путь записи остается через сервер.

## 18. Тестирование

### 18.1. Unit tests

- YAML parser;
- formatter;
- schemas;
- ID generation;
- dependency graph;
- cycle detection;
- workload;
- semantic diff;
- policy validation;
- path validation;
- Git command builder.

### 18.2. Integration tests

Каждый тест создает временный Git-репозиторий.

Сценарии:

- create draft;
- edit task;
- delete task;
- restore deleted task;
- commit;
- push в тестовый remote;
- rebase;
- conflict;
- revert;
- MR API mock;
- webhook.

### 18.3. End-to-end tests

Playwright:

- login;
- create draft;
- create project;
- create task;
- edit task;
- delete task;
- view diff;
- restore file;
- commit;
- push;
- create MR;
- увидеть pipeline status.

### 18.4. Property-based tests

Полезны для:

- formatter idempotence;
- parse/serialize round-trip;
- semantic diff reversibility;
- графов зависимостей;
- случайных path inputs.

### 18.5. Fault injection

Проверить:

- process kill во время записи;
- GitLab timeout;
- push rejection;
- disk full;
- permission denied;
- corrupted YAML;
- stale blob SHA;
- конфликт rebase;
- worktree missing;
- branch manually removed.

## 19. Наблюдаемость

### 19.1. Logs

Structured JSON logs:

- request ID;
- user;
- repository;
- draft;
- Git operation;
- duration;
- exit code;
- error code.

### 19.2. Metrics

- active drafts;
- open worktrees;
- Git operation duration;
- validation duration;
- failed pushes;
- failed rebases;
- webhook failures;
- memory usage;
- loaded entities.

### 19.3. Health endpoints

```text
GET /health/live
GET /health/ready
GET /health/git
GET /health/gitlab
```

## 20. Развертывание

### 20.1. Docker

Контейнер содержит:

- Node.js;
- Git;
- CA certificates;
- приложение;
- непривилегированного пользователя.

Volumes:

```text
/data/repositories
/data/worktrees
/data/state
```

### 20.2. Конфигурация

Environment:

```text
GITPM_BASE_URL
GITPM_DATA_DIR
GITPM_SESSION_SECRET
GITPM_TOKEN_ENCRYPTION_KEY

GITLAB_URL
GITLAB_CLIENT_ID
GITLAB_CLIENT_SECRET
GITLAB_WEBHOOK_SECRET

GITPM_REPOSITORY_URL
GITPM_DEFAULT_BRANCH
```

### 20.3. Backup и сохранность dirty draft

Committed и pushed данные находятся в GitLab. Dirty draft до пользовательского commit дополнительно защищается safety snapshots.

Обязательная модель v0.1:

- текущий worktree хранится на persistent volume;
- GitPM создает commit object текущего tree и обновляет `refs/gitpm/safety/<draft-id>`, не перемещая пользовательскую branch и не добавляя WIP commit в MR history;
- bare repository вместе с safety refs резервируется на отдельный носитель или backup remote;
- UI показывает состояния `local only`, `safety snapshotted` и `pushed`;
- RPO и RTO определены в `GitPM_Delivery_Policies_v0.1.md`;
- hard-kill, primary-volume loss и restore входят в обязательные E2E/fault tests.

Master key не архивируется вместе с application data без отдельной защищенной процедуры. Его lifecycle, rotation и recovery определены в `GitPM_Security_Baseline_v0.1.md`.

## 21. Исполнимый план поставки

Архитектурная спецификация не содержит второго набора этапов реализации.

Единственным авторитетным источником последовательности работ, зависимостей, владельцев, размеров, критериев входа и выхода, автоматической верификации, ручной приемки и release gates является:

```text
docs/GitPM_Work_Plan_v0.2.md
```

Изменение последовательности поставки выполняется только выпуском новой версии Work Plan. Архитектурный документ обновляется лишь тогда, когда меняются архитектурные или продуктовые решения.

## 22. Приоритет MVP

Обязательное:

- GitLab login;
- ровно один сконфигурированный portfolio repository на экземпляр GitPM; пользователь не может добавлять репозитории через UI;
- draft/worktree;
- projects;
- tasks;
- people;
- task list;
- task edit;
- delete/archive;
- validation;
- Changes;
- file diff;
- semantic diff;
- restore file;
- restore hunk;
- commit;
- push;
- create MR;
- GitLab webhook.

После MVP:

- Board;
- History graph;
- restore selected lines;
- conflict resolution;
- Gantt;
- workload;
- MCP;
- multi-repository и пользовательское подключение новых репозиториев;
- attachments.

Не включать в MVP:

- комментарии к задачам вне Git; YAML-комментарии в доменных файлах запрещены, поскольку канонический formatter является авторитетным;
- чат;
- уведомления по email;
- real-time collaborative editing;
- собственный event sourcing;
- собственный undo;
- PostgreSQL;
- Elasticsearch;
- плагины;
- мобильное приложение;
- сложный конструктор workflow;
- автоматическое планирование ресурсов.

## 23. Критические технические риски

### 23.1. Частичный restore строк после Alpha

Эта функция не входит в Alpha и MVP. До включения в план должна быть подтверждена отдельным продуктовым решением.

Риск:

- построение корректного patch;
- файл мог измениться;
- YAML после частичного restore может стать невалидным.

Меры:

- blob SHA;
- preview reverse patch;
- apply with check;
- немедленная validation;
- возможность restore всего файла.

### 23.2. Rebase conflicts

Риск:

- пользователи не знают Git;
- конфликт YAML может быть непонятен.

Меры:

- one entity per file;
- специальный conflict UI;
- three-way diff;
- semantic representation;
- возможность abort rebase;
- возможность создать новую ветку от main и перенести изменения вручную.

### 23.3. GitLab token handling

Риск:

- утечка OAuth token;
- неправильные scopes.

Меры:

- encryption;
- masked logs;
- short-lived credentials;
- отдельный threat model;
- integration tests.

### 23.4. Параллельная генерация ID

Риск:

- две ветки создают одинаковый короткий ID.

Меры:

- использовать ULID как технический ID;
- display key может корректироваться при merge;
- либо GitLab-backed allocation service, но это противоречит простоте.

Рекомендация: ULID.

### 23.5. Массовые изменения агентом

Риск:

- агент создает или удаляет сотни файлов.

Меры:

- scope;
- operation permissions;
- limits;
- validation;
- semantic diff;
- MR approval;
- protected main.

### 23.6. Незапушенные данные

Риск:

- серверный диск потерян до commit/push.

Меры:

- гарантии сохранности и RPO/RTO определяются до Alpha в `GitPM_Delivery_Policies_v0.1.md`;
- dirty worktree переживает restart процесса и контейнера на persistent volume;
- safety snapshot создается как отдельный Git ref без изменения пользовательской ветки;
- bare repository и safety refs резервируются на отдельный носитель;
- UI явно показывает, какие изменения еще не имеют удаленной копии;
- восстановление dirty draft входит в обязательные fault и E2E tests.

## 24. Правила разработки проекта

- никакой бизнес-логики только во frontend;
- Git операции инкапсулированы в одном package;
- формат данных не зависит от UI;
- CLI и server используют один validation package;
- все destructive operations имеют preview;
- все операции адресуются по ID;
- названия не используются как идентичность;
- все Git команды покрыты integration tests;
- новые поля требуют schema versioning;
- миграции формата выполняются отдельной CLI-командой;
- API не принимает произвольный путь к файлу без серверной проверки;
- MR является единственным способом изменения protected branch;
- собственные механизмы истории и undo не добавляются.

## 25. Первая последовательность разработки

Практический порядок первых задач:

1. Создать monorepo.
2. Добавить demo portfolio.
3. Описать task/project/person schemas.
4. Реализовать parser.
5. Реализовать formatter.
6. Реализовать full validation.
7. Реализовать CLI.
8. Реализовать bare clone и worktree manager.
9. Реализовать status/diff.
10. Реализовать create/update/delete task через backend.
11. Реализовать restore file.
12. Реализовать commit.
13. Реализовать push.
14. Подключить GitLab login.
15. Реализовать create MR.
16. Сделать минимальный React shell.
17. Сделать task list.
18. Сделать task editor.
19. Сделать Changes.
20. Сделать semantic diff.
21. Сделать restore hunk.
22. Сделать Board.
23. Сделать webhook.
24. Сделать Gantt.
25. Сделать MCP.

## 26. Определение готовности первой полезной версии

Первая полезная версия готова, когда пользователь может:

1. войти через GitLab;
2. выбрать portfolio repository;
3. создать draft от `main`;
4. открыть проект;
5. создать, изменить, архивировать и удалить задачу;
6. увидеть соответствующее изменение YAML;
7. увидеть обычный и semantic diff;
8. восстановить файл или отдельный hunk;
9. запустить validation;
10. сделать commit;
11. push ветки;
12. создать GitLab MR;
13. увидеть состояние pipeline;
14. после merge увидеть обновленный `main`;
15. создать revert draft для ошибочного commit.

## 27. Итоговая архитектурная формула

```text
GitLab repository
        |
        v
bare clone on GitPM server
        |
        +--> worktree user draft
        |
        +--> worktree agent draft
        |
        +--> worktree another user draft
                    |
                    v
             YAML domain model
                    |
          +---------+---------+
          |                   |
          v                   v
     Web interface        MCP / CLI
          |                   |
          +---------+---------+
                    |
                    v
        validate -> diff -> commit
                    |
                    v
             push -> GitLab MR
                    |
                    v
                approval
                    |
                    v
                   main
```

Система должна оставаться Git-приложением, а не базой данных с декоративной кнопкой Export to Git.
