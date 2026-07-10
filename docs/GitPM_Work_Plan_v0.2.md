# GitPM: план работ, верификации и поставки

Версия документа: 0.2  
Статус: авторитетный исполнимый план  
Связанная архитектура: `GitPM_Implementation_Plan_v0.3.md`

## 1. Назначение

Это единственный авторитетный источник этапов реализации GitPM. Архитектурный документ не дублирует этапы.

План отвечает на вопросы:

- что делается;
- в какой последовательности;
- кто отвечает;
- сколько относительно стоит этап;
- какие зависимости обязательны;
- чем подтверждается результат;
- какие E2E-сценарии должны пройти;
- что записывается в `PROGRESS.md`;
- когда разрешен переход к следующему release gate.

## 2. Статусы

Допустимые статусы этапа:

- `not_started`;
- `ready`;
- `in_progress`;
- `blocked`;
- `verification`;
- `done`;
- `superseded`.

`done` разрешен только после выполнения exit gate и записи доказательств.

## 3. Роли владельцев

- `PO`: владелец продукта и приемки;
- `ARCH`: архитектурный владелец;
- `BE`: backend/Git;
- `FE`: frontend;
- `QA`: автоматизация тестов и release evidence;
- `SEC`: безопасность и эксплуатация.

Один человек может выполнять несколько ролей, но accountability каждого этапа фиксируется одной или несколькими ролями.

## 4. Размеры и правило декомпозиции

- `S`: до 3 инженерных дней;
- `M`: 4-7 инженерных дней;
- `L`: 8-15 инженерных дней;
- `XL`: запрещен.

Если уточненная оценка превышает L, этап делится до начала реализации. Именно поэтому прежний P11 разделен на P11A, P11B и P11C.

## 5. Definition of Done любой задачи

Задача может считаться выполненной, если:

- код и документация находятся в Git;
- typecheck, lint и релевантные tests проходят;
- ошибка имеет стабильный code и не раскрывает секреты;
- destructive behavior имеет preview или явное confirmation;
- новая функция имеет traceability requirement;
- критичная ветвь имеет regression test;
- изменения формата имеют migration strategy;
- `PROGRESS.md` содержит commit, команды и evidence;
- незакрытые риски явно записаны.

## 6. Общие quality gates

### Gate A. Реализация

- scope этапа выполнен;
- архитектурные отклонения оформлены ADR;
- публичные контракты документированы.

### Gate B. Автоматическая верификация

- unit/component/integration tests зеленые;
- mandatory E2E этапа зеленые;
- security tests этапа зеленые;
- performance budget этапа не нарушен;
- traceability validator проходит.

### Gate C. Ручная приемка

- выполнены перечисленные пользовательские сценарии;
- результат проверен на reference environment;
- ошибки и recovery path понятны без терминала, если этап относится к UI.

### Gate D. Доказательства

В `PROGRESS.md` записаны:

- stage status;
- commit SHA;
- pipeline/job URL или local report path;
- команды проверки;
- E2E IDs;
- manual acceptance result;
- performance/security results;
- exceptions и next step.

## 7. Тестовая стратегия

- Unit: чистая доменная логика, parser, graph, policies;
- Component: UI components и service modules;
- Integration: real Git repositories, filesystem, GitLab test project;
- Contract: GitLab API/webhook и MCP schemas;
- E2E: браузер -> server -> Git -> GitLab;
- Security: path, symlink, command injection, secrets, authz;
- Fault: hard kill, disk/full, network failure, corrupted state;
- Performance: фиксированные fixtures и reference hardware;
- Migration: previous-version fixtures, dry-run и revert.

## 8. Обязательные E2E-сценарии

### Core и Git

- `E2E-001`: вход и создание draft;
- `E2E-002`: создание задачи через UI;
- `E2E-003`: изменение задачи;
- `E2E-004`: архивирование задачи;
- `E2E-005`: физическое удаление задачи;
- `E2E-006`: блокировка удаления связанной задачи;
- `E2E-007`: restore deleted file;
- `E2E-008`: restore selected hunk;
- `E2E-009`: validation blocks commit;
- `E2E-010`: commit draft;
- `E2E-011`: push branch;
- `E2E-012`: create MR;
- `E2E-013`: webhook updates UI;
- `E2E-014`: merge and refresh main;
- `E2E-015`: revert merged commit;
- `E2E-016`: stale edit conflict;
- `E2E-017`: rebase without conflict;
- `E2E-018`: YAML three-way conflict;
- `E2E-019`: abort rebase;
- `E2E-020`: restart recovery.

### Отказы, безопасность и GitLab

- `E2E-021`: GitLab unavailable without data loss;
- `E2E-022`: scoped agent creation;
- `E2E-023`: cross-project agent deletion blocked;
- `E2E-024`: trusted agent deletion within limit;
- `E2E-025`: protected main rejects direct push;
- `E2E-026`: token absent from logs, URL и process arguments;
- `E2E-027`: forged/replayed webhook rejected;
- `E2E-028`: symlink/path traversal rejected;
- `E2E-029`: quota violation is atomic;
- `E2E-030`: clean installation.

### Формат, сохранность и представления

- `E2E-031`: migration dry-run produces diff only;
- `E2E-032`: migration commit and revert;
- `E2E-033`: dirty draft survives process/container restart;
- `E2E-034`: dirty draft restored from safety backup after primary volume loss drill;
- `E2E-035`: master key rotation preserves token access;
- `E2E-036`: lost key forces re-authentication without project data loss;
- `E2E-037`: Board drag changes YAML and diff;
- `E2E-038`: Gantt date change changes YAML and diff;
- `E2E-039`: Calendar CRUD changes scheduling;
- `E2E-040`: Workload overload warning;
- `E2E-041`: Team membership and capacity administration;
- `E2E-042`: saved view persists as ViewConfiguration;
- `E2E-043`: single-repository boundary rejects foreign webhook/project;
- `E2E-044`: 3 000-task performance budget;
- `E2E-045`: 10 000-task extended performance budget.

Restore произвольного набора строк не входит в Alpha или MVP и поэтому не имеет обязательного E2E в v0.1.

## 9. Критический путь и параллельность

Критический путь:

```text
P00 -> P00S -> P01 -> P02 -> P03 -> P04 -> P05 -> P06 -> P07 -> P08 -> P09 -> P10 -> P12 -> P13 -> P14
```

Допустимая параллельность:

- P00S и P01 могут частично идти параллельно после P00;
- frontend shell P07 может начинаться после стабилизации draft API contract;
- P11A и P11B могут идти параллельно после P09;
- P11C начинается после календарной модели P11B;
- P12 может идти параллельно с P11C, но Beta требует оба результата;
- P13 начинается только после закрытия всех функциональных stages v0.1.

## 10. Этапы

## P00. Bootstrap и воспроизводимое окружение

- Владелец: `ARCH`
- Размер: `M`
- Зависимости: нет
- Параллельность: P00S, P01

### Цель

Получить воспроизводимый monorepo и pipeline, на котором можно честно измерять последующие этапы.

### Entry criteria

- актуальные планы находятся в Git;
- reference versions Node.js, pnpm и Git выбраны.

### Работы

- pnpm monorepo и workspace boundaries;
- apps/packages skeleton;
- lint, typecheck, unit test, build;
- deterministic lockfile;
- Docker development image;
- baseline CI;
- fixture directories;
- planning traceability validation в CI.

### Артефакты

- bootstrapped repository;
- `scripts/validate_planning.py` подключен к CI;
- clean-install instructions.

### Автоматическая верификация

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
python3 scripts/validate_planning.py
```

### Manual acceptance

На чистом Linux environment выполнить установку и получить зеленый pipeline без локальных, незадокументированных зависимостей.

### E2E

- E2E-030 skeleton/smoke.

### Exit gate

- clean install воспроизводим;
- CI зеленый;
- tool versions зафиксированы;
- `PROGRESS.md` содержит evidence.

## P00S. Security baseline и риск-ориентированные spikes

- Владелец: `ARCH/SEC`
- Размер: `M`
- Зависимости: P00
- Параллельность: P01, P02

### Цель

Снять ключевые архитектурные и security-риски до появления production-кода Git, filesystem и OAuth.

### Entry criteria

- P00 done;
- доступен disposable Linux environment;
- доступен real GitLab test project той же major/minor версии, что production, либо P00S получает `blocked` по GitLab-specific spikes.

### Работы

- утвердить threat boundaries и security baseline;
- spike Git worktree recovery after hard kill;
- spike safety refs через temporary index и `git commit-tree`;
- проверить backup/restore dirty draft;
- проверить custom refs в GitLab и зафиксировать fallback;
- push с user credentials без token leakage;
- reverse patch одного hunk;
- YAML three-way conflict;
- benchmark 10 000 файлов;
- webhook delivery/replay;
- symlink swap/path traversal prototype;
- ADR по master key/keyring lifecycle;
- ADR по Gantt library evaluation criteria, без окончательного выбора.

### Артефакты

- `GitPM_Security_Baseline_v0.1.md` подтвержден;
- ADR/spike reports;
- reproducible proof-of-concept tests;
- уточненные estimates stages.

### Автоматическая верификация

- spike tests воспроизводятся одной командой;
- process list/log scan не содержит token;
- hard-kill recovery test проходит;
- safety ref восстановим;
- path/symlink exploit tests отклонены.

### Manual acceptance

ARCH и SEC просматривают результаты и выбирают один поддерживаемый путь для credentials, safety refs и conflict handling.

### E2E

- preconditions для E2E-018, E2E-026, E2E-027, E2E-028, E2E-033, E2E-034.

### Exit gate

- нет неизвестного критического риска, отложенного к P13;
- master key lifecycle решен;
- safety snapshot mechanism решен;
- P03 разрешено начинать.

## P01. Формат репозитория и доменная модель

- Владелец: `ARCH/BE`
- Размер: `L`
- Зависимости: P00
- Параллельность: P02

### Цель

Зафиксировать стабильный текстовый формат и доменную модель для одного repository.

### Entry criteria

- P00 done;
- решения ID, YAML subset и comments policy утверждены.

### Работы

- Project, Task, Milestone, Person, Team, Calendar, ViewConfiguration types;
- ULID technical ID и display key;
- one entity per file;
- JSON Schemas;
- strict YAML parser;
- canonical formatter;
- comments prohibited rule;
- demo portfolio;
- loader и indexes;
- editable/read-only entity matrix.

### Артефакты

- schemas;
- parser/formatter package;
- fixtures valid/invalid;
- format specification;
- demo repository.

### Автоматическая верификация

- parse/serialize round-trip;
- formatter idempotence;
- duplicate key/alias/tag rejection;
- filename/path/ID consistency;
- comments fixture yields documented error or normalization warning.

### Manual acceptance

Открыть demo repository обычным editor, изменить разрешенное поле, запустить formatter и убедиться, что diff стабилен и читаем.

### E2E

- foundations для E2E-002, E2E-003, E2E-039, E2E-041, E2E-042.

### Exit gate

- schema v1 заморожена для P02;
- формат не зависит от UI;
- политика комментариев явно документирована.

## P02. Валидация, линтер и миграции схем

- Владелец: `BE/QA`
- Размер: `L`
- Зависимости: P01
- Параллельность: P03 после P00S

### Цель

Реализовать полную семантическую проверку и ранний механизм миграций.

### Entry criteria

- P01 done;
- fixture schema v0 и v1 существуют.

### Работы

- syntax/schema/cross-reference validation;
- parent и dependency cycle detection;
- deletion restrict;
- policy validation;
- semantic diff core;
- CLI `validate`, `lint`, `doctor`;
- `migrate --check`, `--dry-run`, actual migration;
- migration diff и отдельный commit workflow;
- structured error codes;
- traceability requirement updates.

### Артефакты

- validation package;
- CLI;
- migration engine;
- previous-version fixtures;
- reports JSON/Markdown.

### Автоматическая верификация

- unit/property tests графов;
- invalid references and cycles rejected;
- migration dry-run не меняет files;
- migration produces canonical v1;
- Git revert возвращает fixture к исходному tree;
- 3 000-task full validation budget measured.

### Manual acceptance

Запустить dry-run на старом fixture, просмотреть diff, выполнить migration в draft-like temp repository и revert.

### E2E

- E2E-009;
- E2E-031;
- E2E-032.

### Exit gate

- никакой implicit migration;
- error reports пригодны UI и agent;
- performance budget P02 выполнен.

## P03. Git core, worktree и safety refs

- Владелец: `BE/SEC`
- Размер: `L`
- Зависимости: P00S, P02
- Параллельность: нет

### Цель

Создать безопасный Git core, lifecycle worktree и механизм safety snapshots.

### Entry criteria

- P00S done;
- P02 done;
- security controls P03 из baseline утверждены.

### Работы

- safe Git process runner;
- bare clone/fetch;
- worktree create/list/recover/remove;
- branch/ref validation;
- file locks;
- status/diff/commit/rebase/revert/push primitives;
- safety ref creation without moving branch HEAD;
- startup reconciliation;
- credentials injection without argv/URL leakage;
- symlink/path controls;
- quotas for worktree count/disk.

### Артефакты

- git-client package;
- worktree manager;
- safety snapshot manager;
- integration test harness with real Git.

### Автоматическая верификация

- hard-kill recovery;
- stale locks cleanup;
- concurrent draft creation;
- command injection rejected;
- symlink/path traversal rejected;
- token leakage scan;
- create worktree performance budget;
- safety snapshot and restore.

### Manual acceptance

Создать несколько worktree, убить процесс в разных точках, перезапустить и восстановить работоспособное состояние без ручной правки `.git`.

### E2E

- E2E-020;
- E2E-026;
- E2E-028;
- E2E-033;
- foundation E2E-034.

### Exit gate

- Git core не запускает shell;
- safety ref доказан;
- P04 может безопасно писать файлы.

## P04. Backend draft API и файловые операции

- Владелец: `BE`
- Размер: `L`
- Зависимости: P03
- Параллельность: P05

### Цель

Предоставить draft API и безопасные атомарные операции над доменными сущностями.

### Entry criteria

- P03 done;
- HTTP/YAML limits из security baseline настроены.

### Работы

- single configured repository API;
- draft create/read/delete;
- Project/Task/Milestone/Person/Team CRUD;
- Calendar admin API;
- archive/unarchive/delete;
- deletion restrict;
- atomic write;
- optimistic blob SHA;
- request/body/YAML limits;
- CSRF/rate limits;
- quota enforcement;
- SSE events;
- structured errors without absolute paths.

### Артефакты

- Fastify server;
- API contract;
- domain services;
- integration tests.

### Автоматическая верификация

- API contract tests;
- stale write returns 409;
- quota violation atomic;
- delete linked entity rejected;
- restart preserves worktree;
- foreign repository/project routing rejected.

### Manual acceptance

Через API client создать, изменить, архивировать и удалить задачу. Восстановление на этом этапе проверяется через Git API/CLI, а не через еще не существующий Changes UI.

### E2E

- API-level E2E-003, E2E-004, E2E-005, E2E-006, E2E-016, E2E-029, E2E-043.

### Exit gate

- P08 не зависит от P09;
- все declared editable entities имеют API path;
- destructive operations адресуются только по ID.

## P05. Git changes API и восстановление file/hunk

- Владелец: `BE/QA`
- Размер: `L`
- Зависимости: P04
- Параллельность: P06

### Цель

Дать серверный Git diff и восстановление на уровне whole file, deleted file и hunk.

### Entry criteria

- P04 done;
- reverse-hunk spike P00S принят.

### Работы

- status API;
- unified/side-by-side diff model;
- semantic diff API;
- restore whole file;
- restore deleted file;
- restore hunk via checked reverse patch;
- discard all;
- commit API;
- history/read commit API;
- stale diff protection.

Не входит:

- restore arbitrary selected lines;
- staging UI.

### Артефакты

- Git changes service;
- patch test corpus LF/CRLF/Unicode;
- semantic diff reports.

### Автоматическая верификация

- reverse patch property tests;
- stale blob rejects restore;
- YAML validation after hunk restore;
- deleted file restoration;
- semantic diff budget.

### Manual acceptance

Через API/test client изменить два файла, удалить третий, восстановить whole file и hunk, затем commit.

### E2E

- E2E-007;
- E2E-008;
- E2E-010.

### Exit gate

- Alpha scope restore полностью работает server-side;
- selected lines остается явно post-Alpha.

## P06. GitLab OIDC, push, MR и webhooks

- Владелец: `BE/SEC`
- Размер: `L`
- Зависимости: P05
- Параллельность: P07

### Цель

Интегрировать реальный self-hosted GitLab: login, encrypted tokens, push, MR и webhooks.

### Entry criteria

- P05 done;
- реальный GitLab test project обязателен;
- OAuth application создана;
- master key/keyring lifecycle из security baseline утвержден и test keyring доступен;
- protected main настроена.

### Работы

- OIDC/OAuth Authorization Code + PKCE;
- encrypted token records;
- key ID и rotation command;
- push от имени пользователя;
- MR create/read/update;
- webhook secret/replay protection;
- pipeline status;
- logout/revoke;
- GitLab unavailable handling;
- single-project webhook routing.

### Артефакты

- GitLab client;
- auth module;
- token/keyring service;
- mandatory integration environment documentation.

### Автоматическая верификация

- unit/contract tests с test double;
- обязательный integration suite на real GitLab project;
- scopes проверены;
- protected main rejects direct push;
- author/committer и MR author проверены;
- webhook/replay проверены;
- key rotation/lost-key tests;
- logs/process scan без token.

### Manual acceptance

Реальный пользователь входит, push выполняется от его имени, MR виден в GitLab, webhook обновляет server state. Затем token отзывается и система требует повторный вход.

### E2E

- E2E-001;
- E2E-011;
- E2E-012;
- E2E-013;
- E2E-021;
- E2E-025;
- E2E-026;
- E2E-027;
- E2E-035;
- E2E-036;
- E2E-043.

### Exit gate

- отсутствие real GitLab integration автоматически означает `blocked`, не `done`;
- token lifecycle подтвержден end-to-end.

## P07. Frontend shell и управление draft

- Владелец: `FE`
- Размер: `M`
- Зависимости: P04, API contract P06
- Параллельность: P06 integration

### Цель

Создать frontend shell, login flow и видимое состояние draft/Git.

### Entry criteria

- P04 API стабилен;
- P06 auth contract стабилен.

### Работы

- app shell/navigation;
- login/logout;
- один repository без user-added repository selector;
- draft selector/create/delete;
- top Git status bar;
- validation/MR/safety status;
- SSE reconnect;
- error boundaries;
- accessibility baseline.

### Артефакты

- React application shell;
- shared UI components;
- Playwright smoke suite.

### Автоматическая верификация

- component tests;
- browser login mock tests;
- real GitLab smoke;
- reconnect/restart UI test;
- no multi-repository creation controls.

### Manual acceptance

Пользователь входит, создает draft, видит branch, dirty/safety/pushed state и может безопасно удалить пустой draft.

### E2E

- E2E-001;
- E2E-020;
- E2E-033.

### Exit gate

- shell не скрывает Git state;
- single-repository boundary видима пользователю.

## P08. Core UI: Projects, Tasks, Milestones, People, Teams

- Владелец: `FE/BE`
- Размер: `L`
- Зависимости: P07
- Параллельность: P09

### Цель

Дать полезный CRUD UI основных сущностей без зависимости от будущего Changes UI.

### Entry criteria

- P07 done;
- P04 entity APIs done.

### Работы

- Portfolio и Project screens;
- task list и task panel;
- Project/Task/Milestone/Person/Team CRUD;
- archive/unarchive/delete;
- linked-delete errors;
- optimistic concurrency;
- admin entry point для Team membership;
- raw YAML read-only view;
- visible file path и last blob SHA.

Calendar CRUD выполняется в P11B, statuses/issue types остаются config read-only.

### Артефакты

- core entity UI;
- component and browser tests.

### Автоматическая верификация

- create/edit/archive/delete UI tests;
- stale edit conflict;
- delete confirmation;
- linked delete blocked;
- entity matrix coverage test.

### Manual acceptance

Создать проект, milestone, team и задачи; назначить людей; удалить несвязанную задачу; убедиться через API status, что файл удален. Restore через UI не является критерием P08 и переносится в P09.

### E2E

- E2E-002;
- E2E-003;
- E2E-004;
- E2E-005;
- E2E-006;
- E2E-016;
- E2E-041 partial.

### Exit gate

- UI не заявляет полный CRUD сущностей, которых еще нет;
- P08 закрывается без реализации P09.

## P09. Changes UI, semantic diff, commit и Alpha gate

- Владелец: `FE/BE/QA`
- Размер: `L`
- Зависимости: P05, P06, P08
- Параллельность: нет

### Цель

Завершить пользовательский Git workflow и пройти Alpha gate.

### Entry criteria

- P05, P06 и P08 done.

### Работы

- Changes screen;
- added/modified/deleted/renamed/conflicted groups;
- Monaco unified/side-by-side diff;
- semantic diff;
- restore whole/deleted file;
- restore hunk;
- validation/format controls;
- commit dialog;
- push и create draft MR;
- safety snapshot status/warnings;
- pipeline/MR status.

Не входит restore arbitrary selected lines.

### Артефакты

- complete UI -> GitLab MR path;
- Alpha acceptance report.

### Автоматическая верификация

- full browser E2E on real GitLab;
- hunk patch corpus;
- validation blocks commit;
- deleted file restore;
- token secrecy;
- 3 000-task core performance budget.

### Manual acceptance

Пользователь создает/удаляет задачи, открывает Changes, восстанавливает удаленный файл и hunk, commit, push и создает MR. Reviewer видит ordinary и semantic diff.

### E2E

- E2E-007;
- E2E-008;
- E2E-009;
- E2E-010;
- E2E-011;
- E2E-012;
- E2E-013;
- E2E-026;
- E2E-033;
- E2E-044.

### Exit gate: Alpha

- mandatory Alpha E2E green;
- dirty draft RPO/RTO evidence есть;
- real GitLab gate green;
- никаких selected-lines обещаний в Alpha.

## P10. История, revert, rebase и conflicts

- Владелец: `FE/BE`
- Размер: `L`
- Зависимости: P09
- Параллельность: P11A, P11B, P12

### Цель

Предоставить историю, revert и понятное разрешение Git conflicts.

### Entry criteria

- P09 Alpha done.

### Работы

- commit graph/history;
- compare revisions;
- restore file from commit;
- create revert draft;
- rebase/update from main;
- three-way YAML conflict UI;
- abort/continue rebase;
- conflict validation;
- cleanup completed drafts.

### Артефакты

- History UI;
- conflict UI;
- recovery runbook draft.

### Автоматическая верификация

- real Git rebase/conflict integration suite;
- restart during conflict;
- revert merged commit through new MR;
- cleanup does not remove dirty/blocked draft.

### Manual acceptance

Создать конфликт двумя draft, разрешить его через UI, abort повторный rebase, затем создать revert MR для merged commit.

### E2E

- E2E-014;
- E2E-015;
- E2E-017;
- E2E-018;
- E2E-019;
- E2E-020.

### Exit gate

- пользователь может восстановиться без ручного редактирования `.git`;
- conflict state переживает restart.

## P11A. Board и сохраненные views

- Владелец: `FE`
- Размер: `M`
- Зависимости: P09
- Параллельность: P11B, P12

### Цель

Добавить Board и сохраненные views без календарной математики.

### Entry criteria

- P09 done.

### Работы

- Kanban columns;
- drag-and-drop;
- swimlanes;
- filters/grouping;
- saved ViewConfiguration;
- virtualization;
- WIP limits optional.

### Артефакты

- Board UI;
- ViewConfiguration CRUD through user-facing actions.

### Автоматическая верификация

- DnD component/browser tests;
- saved view round-trip;
- 3 000-task board performance;
- YAML and semantic diff assertions.

### Manual acceptance

Перетащить задачу, сохранить filter/view, перезагрузить UI и проверить соответствующий file diff.

### E2E

- E2E-037;
- E2E-042;
- E2E-044 board subset.

### Exit gate

- Board полностью является проекцией YAML;
- отдельный gate не зависит от Gantt/workload.

## P11B. Calendar administration и Gantt

- Владелец: `FE/BE`
- Размер: `L`
- Зависимости: P09, P02
- Параллельность: P11C

### Цель

Реализовать управляемые календари и Gantt на единой календарной модели.

### Entry criteria

- P09 done;
- P02 data model supports Calendar;
- Gantt library decision принято по P00S criteria.

### Работы

- Calendar admin UI/CLI;
- holidays/workdays/time zones rules;
- task/milestone Gantt;
- dependency lines;
- date drag/resize;
- tree collapse;
- scheduling validation;
- semantic schedule diff.

### Артефакты

- calendar service;
- admin screen;
- Gantt UI;
- visual regression suite.

### Автоматическая верификация

- calendar property tests;
- timezone/DST cases;
- Gantt visual tests;
- date drag changes canonical YAML;
- 10 000-task exploratory benchmark, release budget only where specified.

### Manual acceptance

Создать Calendar, добавить holiday, назначить проекту, изменить Gantt dates и увидеть корректный diff.

### E2E

- E2E-038;
- E2E-039;
- E2E-045 relevant subset.

### Exit gate

- Calendar реально управляем, а не только referenced;
- Gantt не хранит отдельное состояние вне Git.

## P11C. Workload, capacity и overload

- Владелец: `FE/BE`
- Размер: `L`
- Зависимости: P11B
- Параллельность: P12

### Цель

Добавить capacity и workload поверх проверенной календарной модели.

### Entry criteria

- P11B done;
- Person/Team administration path существует.

### Работы

- weekly capacity;
- team membership and allocation;
- uniform estimate distribution v0.1;
- overload detection;
- workload filters;
- semantic overload changes;
- performance optimization.

### Артефакты

- workload engine;
- capacity admin UI;
- workload view.

### Автоматическая верификация

- allocation property tests;
- holidays/capacity cases;
- overload regression tests;
- 3 000 и 10 000-task budgets;
- no derived state persisted outside Git.

### Manual acceptance

Изменить capacity и calendar, получить перегрузку, исправить сроки и увидеть исчезновение предупреждения.

### E2E

- E2E-040;
- E2E-041;
- E2E-044;
- E2E-045.

### Exit gate

- workload расчет воспроизводим из repository;
- performance budgets выполнены.

## P12. MCP и безопасная работа агентов

- Владелец: `BE/SEC/QA`
- Размер: `L`
- Зависимости: P10, P11A
- Параллельность: P11C может идти параллельно до Beta

### Цель

Дать агентам безопасные domain tools и тот же MR workflow, что людям.

### Entry criteria

- P10 done;
- P11A done;
- agent threat model review выполнен до написания write tools.

### Работы

- MCP transport/auth;
- draft-bound scope;
- project and operation policies;
- create/update/archive/delete tools;
- delete explicit permission and limits;
- bulk preview;
- structured validation errors;
- semantic diff tool;
- commit/push/MR tools;
- quotas/rate limits;
- agent identity in commit trailers.

### Артефакты

- MCP server;
- agent security appendix;
- sample workflows.

### Автоматическая верификация

- cross-project and config attacks;
- delete denied/allowed cases;
- bulk quota atomicity;
- no raw path/Git command exposure;
- full server-side validation before push;
- compromised-token rate scenarios.

### Manual acceptance

Агент получает ТЗ для одного проекта, создает задачи, показывает semantic diff и draft MR. Затем тестовый агент пытается удалить объекты другого проекта и получает policy error без файловых изменений.

### E2E

- E2E-022;
- E2E-023;
- E2E-024;
- E2E-029.

### Exit gate

- Beta невозможна без agent threat model и attack tests;
- agent имеет не больше возможностей, чем policy explicitly grants.

## P13. Hardening, fault tests и эксплуатация

- Владелец: `SEC/QA/BE`
- Размер: `L`
- Зависимости: P10, P11A, P11B, P11C, P12
- Параллельность: нет

### Цель

Подтвердить безопасность, надежность и эксплуатационную готовность всей уже реализованной системы.

### Entry criteria

- P10, P11A, P11B, P11C и P12 done;
- ранние security controls уже реализованы на своих этапах.

### Работы

- final threat model audit;
- dependency/container scans;
- fault injection;
- disk full/permission/network failures;
- backup and dirty draft restore drill;
- key rotation/lost-key drill;
- quota/load tests;
- cleanup/retention worker;
- metrics/health/logging;
- recovery and incident runbooks;
- production Docker/image hardening.

### Артефакты

- security audit report;
- fault/performance reports;
- backup/restore evidence;
- operational runbooks.

### Автоматическая верификация

- full security suite;
- full fault suite;
- E2E-026..036;
- E2E-044/045;
- no high/critical unresolved findings;
- traceability 100% for release requirements.

### Manual acceptance

Оператор выполняет backup/restore, key rotation, GitLab outage recovery и cleanup на production-like environment.

### E2E

- E2E-021;
- E2E-026 - E2E-036;
- E2E-043 - E2E-045.

### Exit gate: Release Candidate

- P13 подтверждает, а не впервые создает security;
- RPO/RTO измерены;
- runbooks воспроизводимы другим оператором.

## P14. Release candidate и приемка v0.1

- Владелец: `PO/QA/ARCH`
- Размер: `M`
- Зависимости: P13
- Параллельность: нет

### Цель

Провести финальную приемку v0.1 и выпустить воспроизводимый release.

### Entry criteria

- P13 done;
- все critical requirements traceable;
- no unresolved blocker/high severity issue.

### Работы

- clean install;
- upgrade/migration rehearsal;
- full mandatory E2E;
- release notes;
- image/SBOM/signature;
- acceptance report;
- tag and rollback plan.

### Артефакты

- release candidate image;
- signed acceptance evidence;
- release tag;
- rollback instructions.

### Автоматическая верификация

- full test matrix;
- real GitLab integration;
- clean install;
- migration dry-run and actual rehearsal;
- traceability validator;
- performance/security gates.

### Manual acceptance

PO, ARCH, QA и SEC проходят пользовательский сценарий от login до MR, recovery after deletion, agent workflow и backup restore.

### E2E

- E2E-001 - E2E-045, где обязательность указана release registry.

### Exit gate: v0.1

- acceptance report approved;
- tag создан;
- artifacts опубликованы;
- rollback проверен;
- `PROGRESS.md` закрывает release evidence.


## 11. Release gates

### Alpha

Требует P00-P09 и обязательные E2E:

- E2E-001 - E2E-013;
- E2E-016;
- E2E-020;
- E2E-025 - E2E-036, где применимо к ранним компонентам;
- E2E-043;
- E2E-044 core budget.

Отдельно обязательны:

- real GitLab test project;
- dirty draft RPO/RTO evidence;
- migration dry-run;
- no selected-lines restore.

### Beta

Требует:

- P10;
- P11A;
- P11B;
- P11C;
- P12;
- E2E-014 - E2E-024;
- E2E-037 - E2E-045.

### Release Candidate

Требует P13, full security/fault/performance matrix и backup/restore drill.

### Release v0.1

Требует P14, full traceability, clean installation, migration rehearsal и approved acceptance report.

## 12. Правила обновления PROGRESS.md

`PROGRESS.md` не дублирует детальные task checklists этого документа.

Он содержит только:

- текущий stage и status;
- owner;
- start/finish dates;
- commit SHA;
- evidence links/paths;
- выполненные E2E IDs;
- исключения;
- blockers;
- следующее проверяемое действие;
- журнал решений и отклонений.

Шаблон записи:

```markdown
## YYYY-MM-DD - <stage>: <результат>

Status: verification
Owner: BE/QA
Commit: <sha>

Evidence:
- `<command>`: passed
- Pipeline: <URL>
- Report: <path>

E2E:
- E2E-007: passed
- E2E-008: passed

Manual acceptance:
- <что проверено и кем>

Exceptions:
- none

Next:
- <одно конкретное проверяемое действие>
```

## 13. Правило изменения плана

- scope/sequence/owner/size меняются выпуском новой версии Work Plan;
- архитектурное решение меняется выпуском Implementation Plan или ADR;
- release requirement добавляется в traceability registry;
- старые versioned files удаляются из рабочего дерева и остаются в Git history;
- этап не может быть закрыт задним числом без evidence.
