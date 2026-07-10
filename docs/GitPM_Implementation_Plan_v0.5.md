# GitPM: архитектура и техническая спецификация

Версия документа: 0.5  
Статус: активная архитектура v0.1

## 1. Цель

GitPM является Git-first системой управления проектами и задачами. Пользователь и агент изменяют обычные YAML-файлы в отдельной ветке и worktree, просматривают file diff и semantic diff, выполняют validation, commit, push и создают GitLab Merge Request.

Git остается единственным источником бизнес-данных. Веб-интерфейс является редактором и представлением Git worktree, а не отдельной базой истины.

## 2. Границы v0.1

В v0.1 входят:

- один заранее настроенный GitLab repository;
- Project, Task, Milestone, Person, Team и Calendar;
- task list, административный UI, Board, History;
- Changes с file diff, упрощенным semantic diff и restore file/hunk;
- commit, push и GitLab MR;
- read-only Gantt;
- упрощенный Workload;
- работа агента через редактирование файлов и CLI.

В v0.1 не входят:

- база данных бизнес-данных;
- backup и replication;
- local safety refs;
- migration engine;
- quota engine;
- собственный authorization DSL;
- rebase API, conflict editor и three-way merge UI;
- интерактивное редактирование Gantt;
- автоматический scheduling engine;
- MCP server или отдельный agent API;
- обязательный live integration test с реальным GitLab project.

Alpha и MVP означают один и тот же milestone.

## 3. Поток изменений

```text
GitLab main
   -> draft branch + worktree
   -> UI или прямое редактирование файлов агентом
   -> format + validate
   -> file diff + semantic diff
   -> commit
   -> push
   -> GitLab Merge Request
   -> approval and merge in GitLab
```

`main` защищается средствами GitLab. GitPM не предоставляет обход protected branch.

## 4. Единая идентичность

У каждой сущности есть ровно один immutable ID с типовым префиксом и ULID:

```text
PRJ-01J2BZA35YJGY8Z4T1P8JZ2TYP
TSK-01J2BZ7G4VJ57PX9K2Q0C6C5XP
PER-01J2C01M9QHPMQ2ZK5F7N8S4VA
```

Правила:

- отдельного display key нет;
- имя YAML-файла равно ID;
- внутренние ссылки содержат ID;
- mutation API принимает ID;
- title и name не являются идентичностью;
- ID не меняется и не переиспользуется после delete.

Пример пути:

```text
projects/PRJ-01J2BZA35YJGY8Z4T1P8JZ2TYP/tasks/TSK-01J2BZ7G4VJ57PX9K2Q0C6C5XP.yaml
```

## 5. Формат repository

```text
.gitpm/
  repository.yaml
  statuses.yaml
  issue-types.yaml

people/
  PER-....yaml
teams/
  TEM-....yaml
calendars/
  CAL-....yaml
projects/
  PRJ-.../
    project.yaml
    milestones/
      MLS-....yaml
    tasks/
      TSK-....yaml
    views/
      VIW-....yaml
```

Одна сущность хранится в одном YAML-файле. `project.yaml` содержит ID, совпадающий с каталогом проекта.

## 6. YAML profile

Поддерживается ограниченный YAML 1.2 profile:

- UTF-8 и LF;
- два пробела;
- duplicate keys запрещены;
- anchors, aliases и custom tags запрещены;
- даты являются строками `YYYY-MM-DD`;
- formatter задает порядок полей;
- доменные YAML-комментарии не поддерживаются и могут быть удалены formatter;
- manual editing разрешено только при успешном `gitpm format --check` и `gitpm validate`.

Schema version присутствует в каждом объекте. Неизвестная версия отклоняется. Migration engine в v0.1 отсутствует; переход на следующую версию формата требует отдельного будущего плана и отдельного преобразующего инструмента.

## 7. Runtime без базы данных

Server загружает YAML в память и строит:

- maps сущностей по ID;
- дерево задач;
- dependency graph;
- project aggregates;
- простые workload aggregates.

После restart модель перечитывается из worktree. Разрешено служебное filesystem state для sessions и draft metadata, но бизнес-сущности не существуют только там.

## 8. Draft и локальная сохранность

Каждый draft имеет отдельную ветку и `git worktree`.

Поддерживается:

- сохранность завершенной атомарной записи при restart процесса или контейнера с тем же persistent volume;
- восстановление runtime model путем перечитывания файлов;
- явное предупреждение о незакоммиченных и незапушенных данных.

Не поддерживается:

- local safety refs;
- автоматические safety commits;
- backup worktree;
- восстановление после удаления worktree directory или потери persistent volume.

GitPM v0.1 не делает резервных копий. Пользователь отвечает за своевременный commit и push.

## 9. Delete и archive

Archive меняет `lifecycle: archived` и оставляет файл.

Delete удаляет файл из worktree. Перед delete сервер проверяет прямые ссылки. В v0.1 используется режим `restrict`: сущность с активными children или dependencies удалить нельзя, пока ссылки не устранены.

Восстановление удаленного файла выполняется через Git restore до commit или через revert draft после commit/merge.

## 10. Validation и CLI

Общие команды используются UI, CI и агентом:

```bash
gitpm format
gitpm format --check
gitpm validate
gitpm validate --changed
gitpm diff --semantic
gitpm doctor
```

Проверяются:

- syntax и schema;
- ID и соответствие пути;
- уникальность ID;
- ссылки и циклы;
- даты;
- delete restrictions;
- измененные файлы вне разрешенного agent scope, когда scope передан CLI.

Нет `gitpm migrate` и нет отдельного quota state.

## 11. Git changes и restore

Changes показывает Added, Modified, Deleted и Renamed files.

Поддерживаются:

- restore целого modified file;
- restore deleted file;
- restore selected hunk;
- discard all uncommitted changes;
- restore file from commit;
- `git revert` в новом draft.

Restore selected lines отсутствует. Staging area может быть скрыт в первой версии: commit индексирует выбранные пользователем файлы или все изменения draft.

## 12. History без rebase

History показывает commit graph, author, message, files, semantic summary и ссылку на MR.

Поддерживается создание revert draft через `git revert`.

GitPM не выполняет rebase и не реализует conflict editor. Если branch отстала или GitLab сообщает conflict, UI показывает статус и предлагает:

- продолжить работу внешним Git-клиентом;
- закрыть draft и создать новый от текущего `main`;
- исправить branch непосредственно средствами GitLab, если это доступно.

## 13. Backend API

Mutation routes используют immutable ID:

```text
POST   /api/drafts/:draftId/tasks
PATCH  /api/drafts/:draftId/tasks/:taskId
DELETE /api/drafts/:draftId/tasks/:taskId
```

Основные группы:

- auth/session;
- configured repository status;
- draft lifecycle;
- domain CRUD;
- format/validate;
- Git status/diff/restore/commit/push;
- GitLab MR and webhook;
- history/revert.

Repository selector отсутствует.

## 14. Авторизация и OAuth

Модель прав намеренно проста:

- Guest/Reporter: read-only;
- Developer: собственные draft, domain edits, commit, push, MR;
- Maintainer: права Developer плюс Person, Team, Calendar и cleanup abandoned draft;
- Administrator: server configuration, назначается в конфигурации GitPM.

Отдельного policy engine, permission DSL и каскада deny/allow нет. Backend проверяет mapped role для каждой mutation; GitLab остается окончательным контролем push и MR.

OAuth access token хранится только в памяти процесса. Refresh token не сохраняется. После restart пользователь выполняет login повторно. Master key, keyring и token rotation subsystem отсутствуют.

## 15. GitLab integration

Используются GitLab OAuth/OIDC, Git transport, Merge Request API и webhooks.

Автоматические тесты используют локальный protocol-level test double, который фиксирует запросы и возвращает контролируемые ответы. Обязательного live GitLab test project в плане v0.1 нет.

Webhook проверяет secret, configured project ID и idempotency event ID.

## 16. UI

Обязательные области:

- Portfolio;
- Projects;
- Tasks;
- Board;
- People and Teams;
- Calendar administration;
- Workload;
- read-only Gantt;
- Changes;
- History;
- Settings.

Верхняя панель всегда показывает draft branch, dirty state, validation status, commit/push/MR status и предупреждение о local-only changes.

## 17. Упрощенный semantic diff

Semantic diff не дублирует всю бизнес-логику. Он сообщает:

- created, updated, archived и deleted entities;
- измененные поля before/after;
- количество changed files;
- затронутые projects;
- invalid references и cycles из validation report.

Он не рассчитывает authorization impact, scheduling plan или сложную resource delta.

## 18. Calendar, read-only Gantt и Workload

Calendar хранит date-only рабочие дни недели и optional holiday dates. Timezone, DST и автоматическое перепланирование отсутствуют.

Gantt только читает `start`, `due`, hierarchy, milestone и dependency. Drag, resize и inline date editing отсутствуют.

Workload является приблизительным отчетом:

- task estimate равномерно делится между ISO-неделями от start до due;
- часы суммируются по assignee;
- результат сравнивается с `weekly_capacity`;
- UI объясняет формулу и не выдает ее за точный календарный план.

## 19. Agents через files and CLI

Агент получает выделенный draft worktree и редактирует YAML непосредственно.

Рекомендуемый цикл:

```bash
gitpm format
gitpm validate --changed
gitpm diff --semantic
git add ...
git commit ...
gitpm push
gitpm mr create
```

При запуске CLI можно передать разрешенный project ID и флаг delete. Validation отклоняет изменения вне указанного scope. Это draft guard, а не отдельная authorization platform.

MCP server, agent domain API и raw command proxy не реализуются.

## 20. Security

Ранние обязательные меры:

- safe argv execution без shell;
- controlled Git config и disabled hooks/filters/textconv/submodules;
- path containment и symlink checks;
- atomic file writes;
- технические limits request/file/output для защиты процесса;
- CSP, CSRF, safe Markdown и XSS tests;
- OAuth token не попадает в filesystem, URL, argv или logs;
- webhook secret и idempotency.

Технические limits не являются quotas и не требуют отдельного quota engine.

## 21. Минимальная наблюдаемость

Обязательны:

- `/health/live` и `/health/ready`;
- structured logs;
- correlation ID;
- duration и exit code Git operations;
- GitLab API/webhook errors;
- отсутствие secrets в logs.

Prometheus, dashboards, distributed tracing и отдельная metrics platform не являются требованиями v0.1.

## 22. Smoke performance

На reference machine выполняются три измерения, используется median:

- cold load 3000 tasks: до 5 секунд;
- изменение и validation одной task: до 1 секунды;
- semantic diff 100 files: до 3 секунд.

Это smoke gate, а не полноценная нагрузочная лаборатория. Сценарий 30 пользователей проверяется функционально через несколько параллельных draft, без отдельного performance SLA.

## 23. Deployment

Один Node.js process, системный Git и persistent volume:

```text
/data/repository.git
/data/worktrees
/data/state
```

Server обслуживает один configured repository. Потеря volume считается потерей local-only данных. Backup не входит в продукт.

## 24. Исполнение и поддержка планов

Исполнимый порядок находится в `GitPM_Work_Plan_v0.4.md`, формальный DAG и тесты - в `GitPM_Requirements_Traceability_v0.3.yaml`.

Правила обновления документов, traceability и `PROGRESS.md` находятся в `GitPM_Planning_Maintenance_Guide_v0.1.md`. Эти правила являются частью Definition of Done для изменений плана.
