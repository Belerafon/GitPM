# GitPM: архитектура и техническая спецификация

Версия документа: 0.4  
Статус: архитектурный baseline v0.1

## 1. Цель

GitPM предоставляет Jira/Linear-подобный web UI, но хранит все бизнес-данные в обычном Git repository. Пользователь или агент изменяет отдельный draft worktree, просматривает Git diff, выполняет validation, commit и push, после чего создает GitLab Merge Request.

## 2. Границы v0.1

- Один заранее настроенный portfolio repository на экземпляр сервера.
- Нет repository picker и пользовательского добавления repositories.
- Нет persistent database для бизнес-данных.
- Нет собственного Undo или event store.
- Физическое удаление разрешено; archive является отдельной операцией.
- Restore v0.1: whole file, deleted file и hunk. Arbitrary selected-lines restore отсутствует.
- GitPM не выполняет backup, replication или off-volume copy.
- Alpha и MVP означают один и тот же milestone.

## 3. Источник истины и поток изменений

```text
GitLab main
   -> bare clone on GitPM server
   -> draft branch + dedicated worktree
   -> YAML changes from UI or agent
   -> format + validate + semantic diff
   -> commit
   -> push
   -> GitLab Merge Request
   -> approval and merge
```

`main` защищена. GitPM не создает обходной путь записи в нее.

## 4. Единая модель идентичности

### 4.1. Canonical identity

Каждая сущность имеет immutable technical ID в формате ULID:

```yaml
id: 01J2BZ7G4VJ57PX9K2Q0C6C5XP
key: TSK-142
```

Правила:

- `id` никогда не меняется и является идентичностью объекта;
- filenames, directory names, внутренние ссылки, lock keys и mutation API используют `id`;
- `key` является отображаемым атрибутом. Display key не является identity;
- `key` можно изменить без переименования файла и без переписывания графа ссылок;
- lookup/search может принимать `key`, но server сначала однозначно разрешает его в ULID;
- mutation endpoint принимает ULID;
- ambiguous или отсутствующий key возвращает явную ошибку;
- title/name никогда не используются для идентификации.

### 4.2. URL и API

Canonical mutation route:

```text
PATCH /api/drafts/:draftId/tasks/:taskId
```

`taskId` здесь только ULID.

Convenience lookup:

```text
GET /api/drafts/:draftId/task-lookup?key=TSK-142
```

Lookup возвращает canonical ULID и не выполняет mutation.

## 5. Формат repository

```text
portfolio/
  .gitpm/
    repository.yaml
    statuses.yaml
    issue-types.yaml
    permissions.yaml

  people/
    01J...yaml

  teams/
    01J...yaml

  calendars/
    01J...yaml

  projects/
    01JPROJECT.../
      project.yaml
      milestones/
        01JMILESTONE...yaml
      tasks/
        01JTASK...yaml

  views/
    01JVIEW...yaml
```

`project.yaml` содержит тот же ULID, что directory name. Task и milestone filenames равны `<id>.yaml`.

Internal references всегда используют ULID fields:

```yaml
id: 01JTASK...
key: TSK-142
project_id: 01JPROJECT...
parent_id: null
milestone_id: 01JMILESTONE...
assignees:
  - person_id: 01JPERSON...
    estimate_hours: 24
depends_on_ids:
  - 01JTASKOTHER...
```

## 6. YAML profile

- YAML 1.2 safe subset.
- UTF-8 and LF.
- Duplicate keys, aliases, anchors и custom tags запрещены.
- Domain YAML comments не поддерживаются.
- Canonical formatter определяет field order и multiline style.
- Manual editing разрешено, но commit блокируется без format/validate.
- Один entity file не может превышать настроенный limit.

## 7. Runtime без базы данных

Server строит in-memory model из выбранного revision/worktree:

- maps by ULID;
- secondary indexes by display key;
- parent/dependency graphs;
- schedule and workload aggregates;
- validation and semantic diff cache.

Cache полностью перестраиваем и не является источником истины. Состояние OAuth session, encrypted tokens, worktree registry и locks является служебным, а не бизнес-данными проекта.

## 8. Доменная модель и delete

v0.1 поддерживает Project, Task, Milestone, Person, Team, Calendar и ViewConfiguration.

Delete:

- удаляет entity file;
- обращается к объекту по ULID;
- default relation policy: `restrict`;
- UI показывает references, блокирующие delete;
- deleted files являются обычным Git change и восстанавливаются Git restore;
- cascade delete отсутствует в v0.1.

Archive меняет lifecycle fields и сохраняет файл.

## 9. Validation и migrations

Validation layers:

1. syntax and safe YAML profile;
2. JSON Schema;
3. filename/path/id consistency;
4. unique ULID and display key policy;
5. cross references by ULID;
6. parent/dependency cycles;
7. domain dates and capacity;
8. change policy and authorization;
9. quota and scope limits.

Migration:

```bash
gitpm migrate --check
gitpm migrate --dry-run
gitpm migrate --from 1 --to 2
```

Implicit migration on read is prohibited. Apply happens in a draft, creates normal diff and separate commit, and is reversible with Git.

## 10. Git core, drafts и local durability

Каждый draft имеет:

- owner identity;
- base branch and base commit;
- unique branch;
- dedicated worktree;
- local safety ref;
- optional local commits;
- optional pushed branch and MR.

Safety states:

- `local-dirty`;
- `local-safety-ref`;
- `committed-local`;
- `pushed`.

Safety ref создается локально как `refs/gitpm/safety/<draft-id>` без движения user branch. Он защищает от сбоя процесса и удаления worktree directory, если bare repository на persistent volume сохранился.

GitPM v0.1 не делает резервных копий. Потеря всего persistent volume означает потерю незапушенных worktree, local commits и local safety refs. UI и runbooks обязаны сообщать это прямо.

## 11. Changes и restore

Changes API/UI предоставляет:

- Git status;
- file diff;
- semantic diff;
- restore whole file;
- restore deleted file;
- restore hunk;
- discard all uncommitted changes;
- validation;
- commit and push.

Hunk restore строит reverse patch, проверяет исходный blob/hash, выполняет apply check и затем full validation затронутой модели.

Arbitrary selected-lines restore не входит в v0.1; отдельного endpoint для восстановления произвольных строк нет.

## 12. History, revert, rebase и conflicts

- History читает native Git commits and refs.
- Revert merged change создается в новом draft и проходит MR.
- Rebase поддерживает start, continue и abort.
- Conflict UI использует three-way data: base, ours, theirs.
- После resolution запускаются formatter и validation.
- Отдельный custom undo log отсутствует.

## 13. Backend API principles

- Mutations use ULID.
- Every write includes expected blob SHA or entity revision.
- Atomic write uses temp file and rename in the same filesystem.
- Bulk operation is all-or-nothing unless endpoint explicitly documents another model.
- Server validates path, role, entity scope, quotas and diff policy before write.
- Commit, push and MR repeat authorization checks.
- API never accepts arbitrary server filesystem paths.

Representative routes:

```text
POST   /api/drafts
GET    /api/drafts/:draftId
DELETE /api/drafts/:draftId

POST   /api/drafts/:draftId/tasks
PATCH  /api/drafts/:draftId/tasks/:taskId
DELETE /api/drafts/:draftId/tasks/:taskId

GET    /api/drafts/:draftId/git/status
GET    /api/drafts/:draftId/git/diff
POST   /api/drafts/:draftId/git/restore/file
POST   /api/drafts/:draftId/git/restore/hunk
POST   /api/drafts/:draftId/git/commit
POST   /api/drafts/:draftId/git/push
```

## 14. GitLab integration

P06 is split:

- P06A stabilizes OIDC, keyring and authorization contract;
- P06B verifies real GitLab push, MR, protected branch and webhooks.

A real self-hosted GitLab test project is mandatory evidence. Test doubles are supplementary only.

GitLab integration includes:

- Authorization Code Flow with PKCE;
- user-scoped push;
- MR create/update;
- pipeline and approval state;
- webhook authentication, replay protection and idempotency;
- single configured project routing;
- retry without duplicate side effects.

## 15. UI

Top bar always shows:

- configured repository name;
- draft/branch;
- dirty and safety state;
- validation state;
- local commit/push state;
- MR and pipeline state.

Main areas:

- Portfolio;
- Project/Task/Milestone;
- People/Teams administration;
- Changes;
- History;
- Board;
- Calendar;
- Gantt;
- Workload.

There is no repository selector in v0.1.

## 16. Semantic diff

Semantic diff parses before/after entity states by ULID and reports:

- create/update/archive/delete;
- changed fields;
- changed references;
- schedule and workload impact;
- affected projects;
- policy violations;
- deleted entities with prior display key/title.

It never relies on title or display key to correlate identity.

## 17. Calendar, Gantt и Workload

Scheduling model is implemented before Gantt and Workload:

- timezone;
- working weekdays;
- holidays;
- person capacity;
- date ranges;
- deterministic allocation rules;
- DST fixtures.

Gantt and Workload are separate stages and separate acceptance gates.

## 18. Observability

Observability is incremental:

- P00: liveness, readiness, structured logs, correlation IDs;
- P03: Git duration, worktree locks, safety ref freshness;
- P04: HTTP latency, rate/quota rejects;
- P06: OAuth errors, push/MR duration, webhook lag/replay rejects;
- P09: UI workflow and validation timings;
- P13B: dashboards, alerts and full operational runbooks.

Metrics and logs must not contain tokens or sensitive repository contents.

## 19. Agents and MCP

Agent works only in a dedicated draft through domain tools. Policy binds:

- allowed project ULIDs;
- allowed operations;
- delete permission and limit;
- file/diff/request quotas;
- base revision;
- actor identity.

Agent cannot request arbitrary path or raw Git command. Full validation and authorization run again before commit, push and MR.

## 20. Security

Detailed controls are in `GitPM_Security_Baseline_v0.2.md`.

Required surfaces include:

- filesystem and symlink races;
- isolated Git config, hooks, filters, textconv, protocols and submodules;
- YAML limits;
- OAuth/keyring;
- webhook replay;
- browser XSS, Markdown, CSP, clickjacking, CORS and dangerous URLs;
- permission changes in repository diff;
- agent scope;
- disk and request quotas.

## 21. Performance methodology

Budgets and benchmark protocol are in `GitPM_Delivery_Policies_v0.2.md`.

Measurements retain:

- runner manifest;
- fixture revision;
- warm/cold classification;
- concurrency;
- raw samples;
- p50/p95/max;
- memory peak;
- Git and filesystem versions.

## 22. Deployment

One server instance:

- Node.js application;
- system Git;
- persistent volume for bare repository, worktrees and encrypted service state;
- reverse proxy and TLS;
- existing GitLab.

Configuration:

```text
GITPM_BASE_URL
GITPM_DATA_DIR
GITPM_SESSION_SECRET_FILE
GITPM_MASTER_KEY_FILE
GITLAB_URL
GITLAB_CLIENT_ID
GITLAB_CLIENT_SECRET_FILE
GITLAB_WEBHOOK_SECRET_FILE
GITPM_REPOSITORY_URL
GITPM_GITLAB_PROJECT_ID
GITPM_DEFAULT_BRANCH
```

Production master key is not accepted from a plain environment variable.

## 23. Исполнение

Этот документ не содержит второй sequence of implementation. Единственный исполнимый stage plan находится в `GitPM_Work_Plan_v0.3.md`; formal DAG and exact release gates находятся в `GitPM_Requirements_Traceability_v0.2.yaml`.
