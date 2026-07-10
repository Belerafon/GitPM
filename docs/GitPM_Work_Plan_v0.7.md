# GitPM: исполнимый план работ, верификации и поставки

Версия документа: 0.7
Статус: активный план v0.1

## 1. Источники истины

- Архитектура: `GitPM_Implementation_Plan_v0.7.md`.
- Формальный DAG, requirements и verification checks: `GitPM_Requirements_Traceability_v0.5.yaml`.
- Фактические statuses and evidence: `GitPM_Execution_Status_v0.1.yaml`.
- Правила поддержки: `GitPM_Planning_Maintenance_Guide_v0.3.md`.
- Человекочитаемый журнал: `PROGRESS.md`.

## 2. Milestones

- Alpha = MVP.
- Beta = feature-complete v0.1.
- Release Candidate = hardening and operations evidence.
- Release = successful machine-readable gate and tag.

## 3. Оценки

- `engineer-days` означает суммарный труд всех ролей, а не календарный срок.
- Оценки используются для сравнения размера и не являются обещанием даты.
- Critical path вычисляется из DAG и size weights только как качественный индикатор.
- Этап, устойчиво выходящий за верхнюю границу, должен быть разделен отдельной revision плана.

## 4. Общий Definition of Done

- Код, docs и tests находятся в одной reviewed commit series.
- Mandatory automated verification проходит.
- Manual acceptance имеет наблюдаемый expected result и evidence artifact.
- Stage status, accepted_by и evidence обновлены в `GitPM_Execution_Status_v0.1.yaml`.
- `PROGRESS.md` содержит краткий итог, blocker и next action.
- Working tree clean.

### Ритм коммитов

- Во время выполнения stage коммиты делаются регулярно: не реже чем после каждого завершенного work package и перед плановой паузой или передачей работы другому исполнителю.
- Каждый commit является независимо проверяемым, содержит одно связное изменение и включает относящиеся к нему tests и docs.
- Перед commit запускаются проверки, пропорциональные изменению. Заведомо сломанное состояние не коммитится только ради соблюдения ритма; крупный work package делится на меньшие проверяемые части.
- Stage evidence содержит commit SHA или диапазон commit series, реализующей этап.

## 5. Verification strategy

- `verification_checks` является общим реестром acceptance checks, а не обещанием, что каждый check является browser E2E.
- `test_type` различает smoke, unit, integration, fault, security, browser, agent, performance и acceptance.
- Live GitLab project не является gate.
- Exact gate проверяется `python3 scripts/check_release_gate.py --gate <name>`.

## 6. DAG

Формальный DAG хранится только в traceability YAML. Ручное поле параллельности отсутствует.

## 7. Этапы

## P00. Bootstrap, CI и минимальная наблюдаемость

- Size: `M`
- Estimate: `4-7 engineer-days`
- Dependencies: `none`
- Accountable: `ARCH`
- Responsible: `BE, FE, QA`
- Acceptance: `ARCH, QA`
- Milestone: `foundation`

### Objective

Создать воспроизводимый monorepo skeleton, CI и минимальные средства диагностики.

### Entry criteria

- Planning validator passes and no blocking decision remains.
- Нет unresolved blocker, запрещающего работу этапа.

### Work packages

- Инициализировать pnpm workspace для web, server, cli и shared packages.
- Настроить lint, typecheck, unit tests и clean build.
- Добавить health endpoints, structured logs и correlation ID.
- Подключить planning validator, execution status validator и gate checker к CI.

### Artifacts

- monorepo skeleton
- CI pipeline
- health endpoints
- logging package

### Automated verification

- clean install, build, lint, typecheck and unit smoke
- planning validator, mutation self-tests and release-gate self-test

### Manual acceptance

1. Запустить server из чистого checkout.
2. Проверить HTTP 200 от live/ready и наличие одного correlation ID в request log.
3. Сохранить command log и sample structured log в evidence.

### Owned verification checks

- `VFY-001`
- `VFY-002`

### Exit gate

- Все artifacts присутствуют и reviewed.
- Automated verification и owned checks successful.
- Acceptance roles записаны в execution status.
- Evidence paths/URLs существуют и доступны reviewer.
- `PROGRESS.md` содержит outcome, limitations and next action.

## P00S. Модель угроз и технические spikes

- Size: `M`
- Estimate: `4-7 engineer-days`
- Dependencies: `P00`
- Accountable: `SEC`
- Responsible: `ARCH, BE, QA`
- Acceptance: `SEC, ARCH`
- Milestone: `foundation`

### Objective

Закрыть наиболее рискованные filesystem, Git process, browser и OAuth assumptions до Git core.

### Entry criteria

- Stages P00 имеют status `done`, accepted_by и evidence.
- Нет unresolved blocker, запрещающего работу этапа.

### Work packages

- Threat model browser, filesystem, Git process и OAuth boundaries.
- Spike command/ref injection и malicious Git configuration.
- Spike symlink swap и interrupted atomic rename.
- Spike OAuth credential transfer через controlled GIT_ASKPASS.

### Artifacts

- threat model
- ADRs or rejected approaches
- security fixtures

### Automated verification

- regression tests for accepted spike solutions

### Manual acceptance

1. Выполнить hostile repository fixture.
2. Подтвердить отсутствие token в argv, URL, filesystem и logs.
3. SEC и ARCH подписывают residual risks в evidence.

### Owned verification checks

- `VFY-003`

### Exit gate

- Все artifacts присутствуют и reviewed.
- Automated verification и owned checks successful.
- Acceptance roles записаны в execution status.
- Evidence paths/URLs существуют и доступны reviewer.
- `PROGRESS.md` содержит outcome, limitations and next action.

## P01. Schema v1 baseline и формат repository

- Size: `L`
- Estimate: `8-12 engineer-days`
- Dependencies: `P00`
- Accountable: `ARCH`
- Responsible: `BE, QA, PO`
- Acceptance: `ARCH, PO, QA`
- Milestone: `foundation`

### Objective

Утвердить конечную минимальную domain model, identity rules и dedicated repository layout.

### Entry criteria

- Stages P00 имеют status `done`, accepted_by и evidence.
- Нет unresolved blocker, запрещающего работу этапа.

### Work packages

- Зафиксировать Project path exception и единый immutable ID.
- Утвердить schemas v1 для Project, Task, Milestone, Person, Team, Calendar и Saved View.
- Утвердить repository.yaml, statuses.yaml и issue-types.yaml.
- Зафиксировать archive behavior, Markdown fields, estimate units и reference rules.
- Создать deterministic demo portfolio и invalid fixtures.

### Artifacts

- approved schema v1 baseline
- repository format specification
- demo portfolio
- invalid fixtures

### Automated verification

- schema fixtures validate field, path and reference rules

### Manual acceptance

1. Создать один связанный набор Project, Tasks, Milestone, People, Team и Calendar.
2. Проверить, что cross-project dependency и неверный Project directory отклоняются.
3. Сохранить approved schema review record.

### Owned verification checks

- `VFY-004`

### Exit gate

- Все artifacts присутствуют и reviewed.
- Automated verification и owned checks successful.
- Acceptance roles записаны в execution status.
- Evidence paths/URLs существуют и доступны reviewer.
- `PROGRESS.md` содержит outcome, limitations and next action.

## P02. Parser, formatter, validation, calendar utilities и CLI

- Size: `L`
- Estimate: `8-12 engineer-days`
- Dependencies: `P01`
- Accountable: `BE`
- Responsible: `BE, QA`
- Acceptance: `ARCH, QA`
- Milestone: `foundation`

### Objective

Реализовать общий parser, formatter, validation и CLI по утвержденному schema baseline.

### Entry criteria

- Stages P01 имеют status `done`, accepted_by и evidence.
- Нет unresolved blocker, запрещающего работу этапа.

### Work packages

- Safe YAML parser and canonical serializer.
- JSON Schema validation.
- Cross-reference, cycles, dates, archived warnings and delete-restrict validation.
- Date-only Calendar utilities for weekdays and holidays.
- CLI format, validate, semantic diff skeleton and doctor.
- Stable error codes and JSON output.

### Artifacts

- repository-format package
- validation package
- calendar utility package
- gitpm CLI
- fixtures

### Automated verification

- round-trip and formatter idempotence tests
- invalid schema, reference, cycle and calendar fixtures

### Manual acceptance

1. Изменить demo files вручную и получить ожидаемые stable error codes.
2. Исправить файлы только по CLI output.
3. Сохранить command transcript and final clean validation report.

### Owned verification checks

- `VFY-005`
- `VFY-006`

### Exit gate

- Все artifacts присутствуют и reviewed.
- Automated verification и owned checks successful.
- Acceptance roles записаны в execution status.
- Evidence paths/URLs существуют и доступны reviewer.
- `PROGRESS.md` содержит outcome, limitations and next action.

## P03. Git synchronization, worktree и draft runtime

- Size: `L`
- Estimate: `8-12 engineer-days`
- Dependencies: `P00S, P02`
- Accountable: `BE`
- Responsible: `BE, SEC, QA`
- Acceptance: `SEC, QA`
- Milestone: `foundation`

### Objective

Реализовать controlled clone/fetch, current-main draft creation, ownership и one-writer runtime.

### Entry criteria

- Stages P00S, P02 имеют status `done`, accepted_by и evidence.
- Нет unresolved blocker, запрещающего работу этапа.

### Work packages

- Bare repository initialization and explicit fetch refspec.
- Repository-wide and draft locks.
- Create draft only after successful fetch from exact origin/default branch commit.
- Draft metadata, branch naming, owner, state and explicit cleanup.
- UI/external writer mode and conflict-free mode switching.
- Per-draft runtime reload via polling fingerprint.
- Atomic writes and optimistic Git blob ID.
- Restart recovery by scanning existing worktrees.

### Artifacts

- git-client package
- draft manager
- runtime model manager
- restart recovery procedure

### Automated verification

- temporary remote integration tests
- hard-kill tests for worktree add and file rename
- external-change and one-writer tests

### Manual acceptance

1. Создать draft, записать base_commit и сверить его с fetched origin/main.
2. Переключить draft в external mode и подтвердить read-only UI contract.
3. Перезапустить server с тем же volume и сохранить status/recovery evidence.

### Owned verification checks

- `VFY-007`
- `VFY-008`

### Exit gate

- Все artifacts присутствуют и reviewed.
- Automated verification и owned checks successful.
- Acceptance roles записаны в execution status.
- Evidence paths/URLs существуют и доступны reviewer.
- `PROGRESS.md` содержит outcome, limitations and next action.

## P04. Backend draft API и доменные операции

- Size: `L`
- Estimate: `8-12 engineer-days`
- Dependencies: `P03`
- Accountable: `BE`
- Responsible: `BE, QA`
- Acceptance: `ARCH, QA`
- Milestone: `alpha`

### Objective

Предоставить domain CRUD API поверх draft runtime.

### Entry criteria

- Stages P03 имеют status `done`, accepted_by и evidence.
- Нет unresolved blocker, запрещающего работу этапа.

### Work packages

- Draft and entity REST contracts.
- Project, Task, Milestone, Person, Team, Calendar and Saved View operations.
- Archive and physical delete with restrict references.
- Atomic API writes and optimistic content revision.
- Maintainer routes for statuses and issue types.
- Static technical request/file limits without quota state.

### Artifacts

- Fastify API
- API contract
- error mapping

### Automated verification

- API integration tests for CRUD, stale revision, archive and delete restrictions

### Manual acceptance

1. Выполнить CRUD каждого editable entity через HTTP client.
2. Проверить точный набор измененных YAML files.
3. Сохранить API transcript and Git diff.

### Owned verification checks

- `VFY-009`
- `VFY-010`
- `VFY-011`

### Exit gate

- Все artifacts присутствуют и reviewed.
- Automated verification и owned checks successful.
- Acceptance roles записаны в execution status.
- Evidence paths/URLs существуют и доступны reviewer.
- `PROGRESS.md` содержит outcome, limitations and next action.

## P05. Git changes API и restore file/hunk

- Size: `M`
- Estimate: `4-7 engineer-days`
- Dependencies: `P04`
- Accountable: `BE`
- Responsible: `BE, QA`
- Acceptance: `QA`
- Milestone: `alpha`

### Objective

Сделать Git status/diff и восстановление file, deleted file и hunk.

### Entry criteria

- Stages P04 имеют status `done`, accepted_by и evidence.
- Нет unresolved blocker, запрещающего работу этапа.

### Work packages

- Parse Git status and unified diff.
- Expose Added, Modified and Deleted only.
- Restore modified and deleted file.
- Build and apply reverse hunk patch with stale-diff protection.
- Expose semantic diff base model.

### Artifacts

- changes API
- diff parser
- restore service

### Automated verification

- file, delete and hunk restore integration tests
- CRLF, Unicode and stale diff tests

### Manual acceptance

1. Изменить один YAML двумя hunks.
2. Восстановить один hunk и проверить, что второй остался.
3. Сохранить before/after diff as evidence.

### Owned verification checks

- `VFY-012`
- `VFY-013`
- `VFY-014`

### Exit gate

- Все artifacts присутствуют и reviewed.
- Automated verification и owned checks successful.
- Acceptance roles записаны в execution status.
- Evidence paths/URLs существуют и доступны reviewer.
- `PROGRESS.md` содержит outcome, limitations and next action.

## P06. GitLab OAuth, push и MR через test double

- Size: `L`
- Estimate: `8-12 engineer-days`
- Dependencies: `P00S, P05`
- Accountable: `BE`
- Responsible: `BE, SEC, QA`
- Acceptance: `SEC, QA`
- Milestone: `alpha`

### Objective

Реализовать OAuth 2.0 login, role refresh, push и MR contract без webhook и live test project.

### Entry criteria

- Stages P00S, P05 имеют status `done`, accepted_by и evidence.
- Нет unresolved blocker, запрещающего работу этапа.

### Work packages

- OAuth 2.0 Authorization Code with PKCE against test double.
- In-memory token sessions and exact role mapping.
- Role refresh before mutation, commit, push and MR.
- Controlled GIT_ASKPASS credential transport.
- Push to local bare remote and MR API client.
- Protocol-level GitLab test double capturing requests.
- Polling endpoint for MR status.

### Artifacts

- auth module
- GitLab client
- test double
- credential helper

### Automated verification

- OAuth, role, push and MR contract tests
- filesystem, process and log token leak scan

### Manual acceptance

1. Просмотреть captured OAuth/API requests и Git child process environment policy.
2. Подтвердить отсутствие token в URL, argv, files and logs.
3. Сохранить sanitized capture and security sign-off.

### Owned verification checks

- `VFY-015`
- `VFY-016`
- `VFY-017`

### Exit gate

- Все artifacts присутствуют и reviewed.
- Automated verification и owned checks successful.
- Acceptance roles записаны в execution status.
- Evidence paths/URLs существуют и доступны reviewer.
- `PROGRESS.md` содержит outcome, limitations and next action.

## P07. Frontend shell и управление draft

- Size: `M`
- Estimate: `4-7 engineer-days`
- Dependencies: `P04, P06`
- Accountable: `FE`
- Responsible: `FE, BE, QA`
- Acceptance: `FE, QA`
- Milestone: `alpha`

### Objective

Создать frontend shell для одного repository и нескольких draft.

### Entry criteria

- Stages P04, P06 имеют status `done`, accepted_by и evidence.
- Нет unresolved blocker, запрещающего работу этапа.

### Work packages

- Login/session screens.
- Application navigation.
- Draft create, open, close, reopen and explicit cleanup.
- Polling every 3 seconds for draft and MR status.
- Writer mode indicator and local-only warning.
- Locale registry, message provider and locale selector.
- Browser preference persistence and `lang`/`dir` root attributes.

### Artifacts

- React shell
- draft context
- shared components
- i18n runtime and `en`/`ru` locale packs

### Automated verification

- component tests and Playwright draft lifecycle

### Manual acceptance

1. Войти, создать draft и увидеть branch, dirty, validation and writer mode.
2. Переключить `ru`/`en`, reload browser и подтвердить сохранение locale без изменения worktree.
3. Закрыть и reopen clean draft.
4. Сохранить screenshots and Playwright trace.

### Owned verification checks

- `VFY-018`

### Exit gate

- Все artifacts присутствуют и reviewed.
- Automated verification и owned checks successful.
- Acceptance roles записаны в execution status.
- Evidence paths/URLs существуют и доступны reviewer.
- `PROGRESS.md` содержит outcome, limitations and next action.

## P08A. Core UI: Project, Task и Milestone

- Size: `L`
- Estimate: `8-12 engineer-days`
- Dependencies: `P07`
- Accountable: `FE`
- Responsible: `FE, BE, QA`
- Acceptance: `PO, QA`
- Milestone: `alpha`

### Objective

Реализовать основной UI Project, Task и Milestone.

### Entry criteria

- Stages P07 имеют status `done`, accepted_by и evidence.
- Нет unresolved blocker, запрещающего работу этапа.

### Work packages

- Portfolio and Project views.
- Task list with filters and inline edit.
- Task side panel.
- Project, Task and Milestone create, edit, archive and delete.
- Markdown fields through safe renderer.

### Artifacts

- core domain UI
- task editor
- portfolio views

### Automated verification

- component tests and browser CRUD scenarios

### Manual acceptance

1. Создать Project, Milestone и несколько связанных Tasks.
2. Проверить, что UI изменил только ожидаемые files.
3. Сохранить screenshots and resulting Git diff.

### Owned verification checks

- `VFY-019`

### Exit gate

- Все artifacts присутствуют и reviewed.
- Automated verification и owned checks successful.
- Acceptance roles записаны в execution status.
- Evidence paths/URLs существуют и доступны reviewer.
- `PROGRESS.md` содержит outcome, limitations and next action.

## P08B. Administration UI: Person, Team, Calendar и repository settings

- Size: `L`
- Estimate: `8-12 engineer-days`
- Dependencies: `P07, P02`
- Accountable: `FE`
- Responsible: `FE, BE, QA`
- Acceptance: `PO, QA`
- Milestone: `alpha`

### Objective

Реализовать административный UI без server configuration.

### Entry criteria

- Stages P07, P02 имеют status `done`, accepted_by и evidence.
- Нет unresolved blocker, запрещающего работу этапа.

### Work packages

- Person CRUD and weekly capacity.
- Team CRUD and membership.
- Calendar weekday and holiday editor.
- Maintainer-only statuses and issue-types editor.
- Role-aware controls and read-only behavior.

### Artifacts

- administration UI
- repository settings UI

### Automated verification

- browser administration and role tests

### Manual acceptance

1. Maintainer изменяет Person, Team, Calendar, status and issue type.
2. Developer получает deny на administrative mutation.
3. Сохранить role matrix screenshots and Git diff.

### Owned verification checks

- `VFY-020`

### Exit gate

- Все artifacts присутствуют и reviewed.
- Automated verification и owned checks successful.
- Acceptance roles записаны в execution status.
- Evidence paths/URLs существуют и доступны reviewer.
- `PROGRESS.md` содержит outcome, limitations and next action.

## P09. Changes UI, semantic diff, commit и Alpha/MVP

- Size: `L`
- Estimate: `8-12 engineer-days`
- Dependencies: `P05, P06, P08A, P08B`
- Accountable: `ARCH`
- Responsible: `FE, BE, QA`
- Acceptance: `PO, QA, SEC`
- Milestone: `alpha`

### Objective

Замкнуть основной пользовательский workflow до Alpha/MVP.

### Entry criteria

- Stages P05, P06, P08A, P08B имеют status `done`, accepted_by и evidence.
- Нет unresolved blocker, запрещающего работу этапа.

### Work packages

- Changes file list and diff viewer.
- Simplified semantic diff.
- Restore file, deleted file and hunk UI.
- Commit dialog that always includes all draft changes.
- Push and create MR UI.
- Alpha acceptance and limitations record.
- All Alpha UI strings routed through localization keys; Russian Alpha screens reviewed.

### Artifacts

- Changes UI
- semantic diff UI
- commit/push/MR workflow
- Alpha evidence

### Automated verification

- browser and integration Alpha verification suite

### Manual acceptance

1. Создать, изменить и удалить Task.
2. Восстановить deleted file, затем повторить delete and commit all.
3. Push branch and create MR through test double.
4. Переключить UI на русский и подтвердить отсутствие hard-coded English на Alpha workflow.
5. Сохранить Playwright trace, final diff and accepted limitations.

### Owned verification checks

- `VFY-021`
- `VFY-022`
- `VFY-023`
- `VFY-024`

### Exit gate

- Все artifacts присутствуют и reviewed.
- Automated verification и owned checks successful.
- Acceptance roles записаны в execution status.
- Evidence paths/URLs существуют и доступны reviewer.
- `PROGRESS.md` содержит outcome, limitations and next action.

## P10. История и revert workflow без rebase

- Size: `M`
- Estimate: `4-7 engineer-days`
- Dependencies: `P09`
- Accountable: `BE`
- Responsible: `BE, FE, QA`
- Acceptance: `QA`
- Milestone: `beta`

### Objective

Предоставить History и создание revert draft без rebase.

### Entry criteria

- Stages P09 имеют status `done`, accepted_by и evidence.
- Нет unresolved blocker, запрещающего работу этапа.

### Work packages

- Commit graph and commit detail.
- File history and semantic summary.
- Create new draft and run git revert.
- Display external conflict status without resolution UI.

### Artifacts

- History UI
- revert service

### Automated verification

- history and revert integration/browser tests

### Manual acceptance

1. Выбрать merged commit fixture и создать revert draft.
2. Проверить inverse diff and new branch.
3. Сохранить commit graph screenshot and diff.

### Owned verification checks

- `VFY-025`

### Exit gate

- Все artifacts присутствуют и reviewed.
- Automated verification и owned checks successful.
- Acceptance roles записаны в execution status.
- Evidence paths/URLs существуют и доступны reviewer.
- `PROGRESS.md` содержит outcome, limitations and next action.

## P11A. Board и сохраненные представления

- Size: `M`
- Estimate: `4-7 engineer-days`
- Dependencies: `P09`
- Accountable: `FE`
- Responsible: `FE, BE, QA`
- Acceptance: `PO, QA`
- Milestone: `beta`

### Objective

Добавить Kanban Board без swimlanes.

### Entry criteria

- Stages P09 имеют status `done`, accepted_by и evidence.
- Нет unresolved blocker, запрещающего работу этапа.

### Work packages

- Columns by status.
- Drag Task between status columns.
- Filters and Saved View persistence.
- No virtualization requirement unless performance smoke fails.

### Artifacts

- Board UI
- Saved View support

### Automated verification

- browser Board and Saved View tests

### Manual acceptance

1. Перетащить Task между status columns.
2. Сохранить и повторно открыть View.
3. Сохранить screenshot and exact YAML changes.

### Owned verification checks

- `VFY-026`

### Exit gate

- Все artifacts присутствуют и reviewed.
- Automated verification и owned checks successful.
- Acceptance roles записаны в execution status.
- Evidence paths/URLs существуют и доступны reviewer.
- `PROGRESS.md` содержит outcome, limitations and next action.

## P11C. Read-only Gantt

- Size: `M`
- Estimate: `4-7 engineer-days`
- Dependencies: `P09, P08B`
- Accountable: `FE`
- Responsible: `FE, BE, QA`
- Acceptance: `PO, QA`
- Milestone: `beta`

### Objective

Добавить read-only Gantt по уже утвержденной calendar model.

### Entry criteria

- Stages P09, P08B имеют status `done`, accepted_by и evidence.
- Нет unresolved blocker, запрещающего работу этапа.

### Work packages

- Render Task dates, hierarchy, Milestone and dependencies.
- Hide undated and archived Tasks by documented rules.
- No drag, resize or inline editing.

### Artifacts

- read-only Gantt

### Automated verification

- browser rendering tests on deterministic fixture

### Manual acceptance

1. Открыть fixture с hierarchy, milestone and dependencies.
2. Сверить пять заранее заданных bars/dates с YAML.
3. Сохранить screenshot with fixture commit SHA.

### Owned verification checks

- `VFY-027`

### Exit gate

- Все artifacts присутствуют и reviewed.
- Automated verification и owned checks successful.
- Acceptance roles записаны в execution status.
- Evidence paths/URLs существуют и доступны reviewer.
- `PROGRESS.md` содержит outcome, limitations and next action.

## P11D. Упрощенный Workload

- Size: `M`
- Estimate: `4-7 engineer-days`
- Dependencies: `P09, P08B`
- Accountable: `BE`
- Responsible: `BE, FE, QA`
- Acceptance: `PO, QA`
- Milestone: `beta`

### Objective

Добавить объяснимый приблизительный Workload.

### Entry criteria

- Stages P09, P08B имеют status `done`, accepted_by и evidence.
- Нет unresolved blocker, запрещающего работу этапа.

### Work packages

- Weekly allocation from estimate_hours and date range.
- Calendar weekday and holiday exclusion.
- Equal split across multiple assignees.
- Capacity comparison and formula explanation.

### Artifacts

- workload calculator
- Workload UI

### Automated verification

- deterministic allocation unit tests and browser scenario

### Manual acceptance

1. Сверить три заранее рассчитанных Person-week values fixture.
2. Проверить archived and undated exclusion.
3. Сохранить calculation report and screenshot.

### Owned verification checks

- `VFY-028`

### Exit gate

- Все artifacts присутствуют и reviewed.
- Automated verification и owned checks successful.
- Acceptance roles записаны в execution status.
- Evidence paths/URLs существуют и доступны reviewer.
- `PROGRESS.md` содержит outcome, limitations and next action.

## P12. Работа агента через files и CLI

- Size: `M`
- Estimate: `4-7 engineer-days`
- Dependencies: `P02, P03, P05, P06`
- Accountable: `BE`
- Responsible: `BE, QA`
- Acceptance: `ARCH, QA`
- Milestone: `beta`

### Objective

Поддержать агента без MCP и отдельного API.

### Entry criteria

- Stages P02, P03, P05, P06 имеют status `done`, accepted_by и evidence.
- Нет unresolved blocker, запрещающего работу этапа.

### Work packages

- Create/open draft in external writer mode.
- Direct YAML editing workflow.
- CLI scope and explicit delete flag.
- Format, validate, semantic diff, commit all, push and MR commands.
- UI read-only enforcement during external mode.

### Artifacts

- agent CLI workflow
- agent usage guide

### Automated verification

- agent-local verification with scope violation and valid MR flow

### Manual acceptance

1. Запустить scripted agent fixture в external mode.
2. Подтвердить deny для изменения другого Project.
3. Сохранить CLI transcript and final diff.

### Owned verification checks

- `VFY-029`

### Exit gate

- Все artifacts присутствуют и reviewed.
- Automated verification и owned checks successful.
- Acceptance roles записаны в execution status.
- Evidence paths/URLs существуют и доступны reviewer.
- `PROGRESS.md` содержит outcome, limitations and next action.

## P13A. Security hardening

- Size: `L`
- Estimate: `8-12 engineer-days`
- Dependencies: `P09, P10, P11A, P11C, P11D, P12`
- Accountable: `SEC`
- Responsible: `SEC, BE, FE, QA`
- Acceptance: `SEC, ARCH`
- Milestone: `release_candidate`

### Objective

Подтвердить security baseline на feature-complete build.

### Entry criteria

- Stages P09, P10, P11A, P11C, P11D, P12 имеют status `done`, accepted_by и evidence.
- Нет unresolved blocker, запрещающего работу этапа.

### Work packages

- Hostile browser content suite.
- Malicious repository and Git config suite.
- OAuth token leakage and role revocation tests.
- Dependency and container scans.
- Residual risk review.

### Artifacts

- security report
- scan reports
- residual risk record

### Automated verification

- hostile-content and malicious-repository verification

### Manual acceptance

1. SEC reviews all high/critical findings.
2. Каждое принятое исключение содержит owner and rationale.
3. Сохранить signed security report.

### Owned verification checks

- `VFY-030`

### Exit gate

- Все artifacts присутствуют и reviewed.
- Automated verification и owned checks successful.
- Acceptance roles записаны в execution status.
- Evidence paths/URLs существуют и доступны reviewer.
- `PROGRESS.md` содержит outcome, limitations and next action.

## P13B. Эксплуатационная проверка и performance smoke

- Size: `M`
- Estimate: `4-7 engineer-days`
- Dependencies: `P09, P10, P11A, P11C, P11D, P12`
- Accountable: `OPS`
- Responsible: `BE, QA, OPS`
- Acceptance: `OPS, QA`
- Milestone: `release_candidate`

### Objective

Проверить install, restart, cleanup, troubleshooting и reproducible performance smoke.

### Entry criteria

- Stages P09, P10, P11A, P11C, P11D, P12 имеют status `done`, accepted_by и evidence.
- Нет unresolved blocker, запрещающего работу этапа.

### Work packages

- Pin CI runner profile, Node.js and Git versions.
- Generate deterministic 3000-Task fixture.
- Run exact performance commands in three fresh processes.
- Test install, restart and explicit draft cleanup.
- Write troubleshooting and limitations runbooks.

### Artifacts

- performance report
- install/restart/troubleshooting runbooks
- operational evidence

### Automated verification

- performance smoke and restart verification

### Manual acceptance

1. Выполнить runbook на чистом environment.
2. Сверить measured values с budgets.
3. Сохранить runner metadata, commands and report.

### Owned verification checks

- `VFY-031`

### Exit gate

- Все artifacts присутствуют и reviewed.
- Automated verification и owned checks successful.
- Acceptance roles записаны в execution status.
- Evidence paths/URLs существуют и доступны reviewer.
- `PROGRESS.md` содержит outcome, limitations and next action.

## P14. Release acceptance v0.1

- Size: `S`
- Estimate: `2-4 engineer-days`
- Dependencies: `P13A, P13B`
- Accountable: `PO`
- Responsible: `ARCH, QA, OPS`
- Acceptance: `PO, ARCH, QA`
- Milestone: `release`

### Objective

Проверить фактический release gate и выпустить tag v0.1.

### Entry criteria

- Stages P13A, P13B имеют status `done`, accepted_by и evidence.
- Нет unresolved blocker, запрещающего работу этапа.

### Work packages

- Run localization completeness and Russian acceptance check.
- Run machine-readable release-candidate gate check after owned checks pass.
- Review changelog, limitations and evidence links.
- Prepare the final release command; the release gate is executed only after P14 is marked done.
- Confirm clean working tree before tagging.

### Artifacts

- release checklist
- changelog
- localization completeness report
- Russian UI/CLI acceptance evidence
- release-candidate evidence package

### Automated verification

- localization key, placeholder and hard-coded-string checks
- scripts/check_release_gate.py --gate release_candidate

### Manual acceptance

1. Выполнить `VFY-032`: пройти обязательные UI surfaces на русском и проверить human-readable CLI.
2. Получить successful release-candidate gate report.
3. PO, ARCH and QA фиксируют acceptance и переводят P14 в `done`.
4. Запустить `scripts/check_release_gate.py --gate release`, затем создать tag v0.1.
5. Сохранить localization report, final gate report, tag SHA and release notes.

### Owned verification checks

- `VFY-032`

### Exit gate

- Все artifacts присутствуют и reviewed.
- Automated verification и owned checks successful.
- Acceptance roles записаны в execution status.
- Evidence paths/URLs существуют и доступны reviewer.
- `PROGRESS.md` содержит outcome, limitations and next action.
