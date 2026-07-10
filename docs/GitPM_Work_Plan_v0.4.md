# GitPM: исполнимый план работ, верификации и поставки

Версия документа: 0.4  
Статус: активный план v0.1

## 1. Источники истины

- Архитектура: `GitPM_Implementation_Plan_v0.5.md`.
- Формальный DAG и exact gates: `GitPM_Requirements_Traceability_v0.3.yaml`.
- Правила поддержки: `GitPM_Planning_Maintenance_Guide_v0.1.md`.
- Фактический прогресс: `PROGRESS.md`.

## 2. Milestones

- Alpha = MVP.
- Beta = feature-complete v0.1.
- Release Candidate = hardening and operations evidence.
- Release = exact gate and tag.

## 3. Общий Definition of Done

- Код, docs и tests находятся в одном commit series.
- Mandatory automated verification проходит.
- Manual acceptance выполнена Acceptance roles.
- Evidence записано в `PROGRESS.md`.
- Planning documents обновлены по Maintenance Guide, если изменился scope или architecture.
- Working tree clean.

## 4. Тестовая стратегия

- Unit tests для pure logic.
- Integration tests на временных Git repositories и локальном GitLab test double.
- Browser E2E через Playwright.
- Security fixtures для hostile input.
- Live GitLab test project не является обязательным или автоматическим gate.
- Smoke performance использует median трех запусков.

## 5. DAG

Формальный DAG хранится только в traceability YAML. Поле ручной параллельности отсутствует. Независимые stages могут идти параллельно только если их formal dependencies закрыты.

## 6. Этапы

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

- Repository initialized and planning validator passes.
- Нет unresolved blocker, запрещающего работу этапа.

### Work packages

- Инициализировать pnpm workspace для web, server, cli и shared packages.
- Настроить lint, typecheck, unit test и clean build.
- Добавить `/health/live`, `/health/ready`, structured logs и correlation ID.
- Подключить planning validator к CI.

### Artifacts

- monorepo skeleton
- CI pipeline
- health endpoints
- logging package

### Automated verification

- clean install, build, lint, typecheck and unit smoke
- planning validator and mutation self-tests

### Manual acceptance

- Запустить server в чистом checkout и проверить health/log correlation.

### Owned E2E

- `E2E-001`
- `E2E-002`

### Exit gate

- Все artifacts присутствуют и review завершен.
- Automated verification и owned E2E успешны.
- Acceptance roles (ARCH, QA) зафиксировали результат.
- `PROGRESS.md` содержит evidence и следующий action.

## P00S. Модель угроз и технические spikes

- Size: `M`
- Estimate: `4-7 engineer-days`
- Dependencies: `P00`
- Accountable: `SEC`
- Responsible: `ARCH, BE, QA`
- Acceptance: `SEC, ARCH`
- Milestone: `foundation`

### Objective

Проверить самые рискованные security assumptions до реализации Git core.

### Entry criteria

- Stages P00 имеют status `done` и evidence.
- Нет unresolved blocker, запрещающего работу этапа.

### Work packages

- Threat model browser, filesystem, Git process, OAuth and webhook boundaries.
- Spike command/ref injection and malicious Git configuration.
- Spike symlink swap and interrupted atomic rename.
- Spike OAuth credential leakage and webhook replay.

### Artifacts

- threat model
- ADRs or rejected approaches
- security fixtures

### Automated verification

- regression tests for accepted spike solutions

### Manual acceptance

- SEC и ARCH подтверждают, что P03 может начинаться без неизвестных critical risks.

### Owned E2E

- `E2E-003`

### Exit gate

- Все artifacts присутствуют и review завершен.
- Automated verification и owned E2E успешны.
- Acceptance roles (SEC, ARCH) зафиксировали результат.
- `PROGRESS.md` содержит evidence и следующий action.

## P01. Единая идентичность и формат репозитория

- Size: `M`
- Estimate: `4-7 engineer-days`
- Dependencies: `P00`
- Accountable: `ARCH`
- Responsible: `BE, QA`
- Acceptance: `ARCH, QA`
- Milestone: `foundation`

### Objective

Зафиксировать единственный immutable ID и layout domain files.

### Entry criteria

- Stages P00 имеют status `done` и evidence.
- Нет unresolved blocker, запрещающего работу этапа.

### Work packages

- Определить prefixed ULID grammar для всех entity types.
- Определить directories and filename rules.
- Определить schemas v1 and examples.
- Зафиксировать отсутствие display key и migration engine.

### Artifacts

- repository format spec
- schema drafts
- demo portfolio

### Automated verification

- fixtures validate filename/id/reference consistency

### Manual acceptance

- Создать связанные Project/Task/Person files и проверить читаемость diff.

### Owned E2E


### Exit gate

- Все artifacts присутствуют и review завершен.
- Automated verification и owned E2E успешны.
- Acceptance roles (ARCH, QA) зафиксировали результат.
- `PROGRESS.md` содержит evidence и следующий action.

## P02. Parser, formatter, validation и CLI

- Size: `L`
- Estimate: `8-12 engineer-days`
- Dependencies: `P01`
- Accountable: `BE`
- Responsible: `BE, QA`
- Acceptance: `ARCH, QA`
- Milestone: `foundation`

### Objective

Реализовать общий parser, formatter, validation и CLI без migration subsystem.

### Entry criteria

- Stages P01 имеют status `done` и evidence.
- Нет unresolved blocker, запрещающего работу этапа.

### Work packages

- Safe YAML parser and canonical serializer.
- JSON Schema validation.
- Cross-reference, cycles, dates and delete-restrict validation.
- CLI format, validate, semantic diff skeleton and doctor.
- Stable error codes and JSON output.

### Artifacts

- repository-format package
- validation package
- gitpm CLI
- fixtures

### Automated verification

- round-trip/idempotence/property tests
- invalid schema/reference/cycle fixtures

### Manual acceptance

- Агентоподобным редактированием сломать несколько файлов и исправить только по CLI errors.

### Owned E2E

- `E2E-004`
- `E2E-005`

### Exit gate

- Все artifacts присутствуют и review завершен.
- Automated verification и owned E2E успешны.
- Acceptance roles (ARCH, QA) зафиксировали результат.
- `PROGRESS.md` содержит evidence и следующий action.

## P03. Git core, worktree и draft lifecycle

- Size: `L`
- Estimate: `8-12 engineer-days`
- Dependencies: `P00S, P02`
- Accountable: `BE`
- Responsible: `BE, SEC, QA`
- Acceptance: `SEC, QA`
- Milestone: `foundation`

### Objective

Создать надежный branch/worktree lifecycle без safety refs и rebase.

### Entry criteria

- Stages P00S, P02 имеют status `done` и evidence.
- Нет unresolved blocker, запрещающего работу этапа.

### Work packages

- Bare clone and worktree manager.
- Draft metadata and filesystem locks.
- Atomic writes and optimistic blob SHA.
- Git status, add, commit and local branch operations.
- Restart recovery by scanning existing worktrees.

### Artifacts

- git-client package
- draft manager
- restart recovery procedure

### Automated verification

- temporary repository integration tests
- hard-kill tests for worktree add and file rename

### Manual acceptance

- Создать два draft, перезапустить server с тем же volume и проверить dirty files.

### Owned E2E

- `E2E-006`
- `E2E-007`

### Exit gate

- Все artifacts присутствуют и review завершен.
- Automated verification и owned E2E успешны.
- Acceptance roles (SEC, QA) зафиксировали результат.
- `PROGRESS.md` содержит evidence и следующий action.

## P04. Backend draft API и доменные операции

- Size: `L`
- Estimate: `8-12 engineer-days`
- Dependencies: `P03`
- Accountable: `BE`
- Responsible: `BE, QA`
- Acceptance: `ARCH, QA`
- Milestone: `alpha`

### Objective

Предоставить domain CRUD API поверх draft worktree.

### Entry criteria

- Stages P03 имеют status `done` и evidence.
- Нет unresolved blocker, запрещающего работу этапа.

### Work packages

- Draft and entity REST contracts.
- Project, Task, Milestone, Person, Team and Calendar operations.
- Archive and physical delete with restrict references.
- Atomic API writes and optimistic concurrency.
- Static technical request/file limits without quota state.

### Artifacts

- Fastify API
- API contract
- error mapping

### Automated verification

- API integration tests for CRUD, stale blob and delete restrictions

### Manual acceptance

- Выполнить полный CRUD через HTTP client и проверить YAML diff.

### Owned E2E

- `E2E-008`
- `E2E-009`
- `E2E-010`

### Exit gate

- Все artifacts присутствуют и review завершен.
- Automated verification и owned E2E успешны.
- Acceptance roles (ARCH, QA) зафиксировали результат.
- `PROGRESS.md` содержит evidence и следующий action.

## P05. Git changes API и restore file/hunk

- Size: `M`
- Estimate: `4-7 engineer-days`
- Dependencies: `P04`
- Accountable: `BE`
- Responsible: `BE, QA`
- Acceptance: `QA`
- Milestone: `alpha`

### Objective

Сделать Git status/diff и штатное восстановление file/hunk.

### Entry criteria

- Stages P04 имеют status `done` и evidence.
- Нет unresolved blocker, запрещающего работу этапа.

### Work packages

- Parse Git status and unified diff.
- Restore modified and deleted file.
- Build and apply reverse hunk patch with stale-diff protection.
- Expose semantic diff base model.

### Artifacts

- changes API
- diff parser
- restore service

### Automated verification

- file/delete/hunk restore integration tests
- CRLF/Unicode and stale diff tests

### Manual acceptance

- Изменить один YAML двумя hunks и восстановить только один.

### Owned E2E

- `E2E-011`
- `E2E-012`
- `E2E-013`

### Exit gate

- Все artifacts присутствуют и review завершен.
- Automated verification и owned E2E успешны.
- Acceptance roles (QA) зафиксировали результат.
- `PROGRESS.md` содержит evidence и следующий action.

## P06. GitLab login, push, MR и webhooks через test double

- Size: `L`
- Estimate: `8-12 engineer-days`
- Dependencies: `P00S, P05`
- Accountable: `BE`
- Responsible: `BE, SEC, QA`
- Acceptance: `SEC, QA`
- Milestone: `alpha`

### Objective

Реализовать GitLab login, push, MR и webhook contract без обязательного live test project.

### Entry criteria

- Stages P00S, P05 имеют status `done` и evidence.
- Нет unresolved blocker, запрещающего работу этапа.

### Work packages

- OIDC Authorization Code with PKCE against test double.
- In-memory token sessions and role mapping.
- Controlled Git credentials for push.
- MR create/read API client.
- Webhook secret, project ID and idempotency.
- Protocol-level GitLab test double capturing requests.

### Artifacts

- auth module
- GitLab client
- test double
- webhook handler

### Automated verification

- OAuth, push orchestration, MR payload and webhook contract tests against test double
- filesystem/process/log token leak scan

### Manual acceptance

- Просмотреть captured requests и убедиться, что token не записан на диск; live GitLab test не является gate.

### Owned E2E

- `E2E-014`
- `E2E-015`
- `E2E-016`
- `E2E-017`

### Exit gate

- Все artifacts присутствуют и review завершен.
- Automated verification и owned E2E успешны.
- Acceptance roles (SEC, QA) зафиксировали результат.
- `PROGRESS.md` содержит evidence и следующий action.

## P07. Frontend shell и управление draft

- Size: `M`
- Estimate: `4-7 engineer-days`
- Dependencies: `P04, P06`
- Accountable: `FE`
- Responsible: `FE, BE, QA`
- Acceptance: `FE, QA`
- Milestone: `alpha`

### Objective

Создать frontend shell вокруг одного repository и нескольких draft.

### Entry criteria

- Stages P04, P06 имеют status `done` и evidence.
- Нет unresolved blocker, запрещающего работу этапа.

### Work packages

- Login/session screens.
- Application navigation.
- Draft create/open/close and top status bar.
- SSE or polling for status updates.
- Local-only warning.

### Artifacts

- React shell
- draft context
- shared components

### Automated verification

- component tests and Playwright draft lifecycle

### Manual acceptance

- Пользователь входит, создает draft и всегда видит branch/dirty/validation state.

### Owned E2E

- `E2E-018`

### Exit gate

- Все artifacts присутствуют и review завершен.
- Automated verification и owned E2E успешны.
- Acceptance roles (FE, QA) зафиксировали результат.
- `PROGRESS.md` содержит evidence и следующий action.

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

- Stages P07 имеют status `done` и evidence.
- Нет unresolved blocker, запрещающего работу этапа.

### Work packages

- Portfolio and project views.
- Task list with filters and inline edit.
- Task side panel.
- Project/Milestone/Task CRUD and delete/archive confirmation.
- Raw YAML view for diagnostics.

### Artifacts

- core domain pages
- task editor
- selectors

### Automated verification

- component and Playwright CRUD tests

### Manual acceptance

- Создать проект и набор связанных задач без терминала.

### Owned E2E

- `E2E-019`

### Exit gate

- Все artifacts присутствуют и review завершен.
- Automated verification и owned E2E успешны.
- Acceptance roles (PO, QA) зафиксировали результат.
- `PROGRESS.md` содержит evidence и следующий action.

## P08B. Administration UI: Person, Team, Calendar и настройки

- Size: `L`
- Estimate: `8-12 engineer-days`
- Dependencies: `P07, P02`
- Accountable: `FE`
- Responsible: `FE, BE, QA`
- Acceptance: `PO, QA`
- Milestone: `alpha`

### Objective

Реализовать административный UI, который пользователь просил сохранить в v0.1.

### Entry criteria

- Stages P07, P02 имеют status `done` и evidence.
- Нет unresolved blocker, запрещающего работу этапа.

### Work packages

- Person CRUD.
- Team and membership CRUD.
- Calendar weekday/holiday editor.
- weekly_capacity editor.
- Statuses and issue types simple configuration forms.
- Role-aware admin navigation.

### Artifacts

- admin pages
- configuration forms

### Automated verification

- role and CRUD browser tests

### Manual acceptance

- Maintainer меняет team/calendar, Developer не может выполнить admin mutation.

### Owned E2E

- `E2E-020`

### Exit gate

- Все artifacts присутствуют и review завершен.
- Automated verification и owned E2E успешны.
- Acceptance roles (PO, QA) зафиксировали результат.
- `PROGRESS.md` содержит evidence и следующий action.

## P09. Changes UI, semantic diff, commit и Alpha/MVP

- Size: `L`
- Estimate: `8-12 engineer-days`
- Dependencies: `P05, P06, P08A, P08B`
- Accountable: `ARCH`
- Responsible: `FE, BE, QA`
- Acceptance: `PO, QA, SEC`
- Milestone: `alpha`

### Objective

Завершить основной Alpha/MVP workflow.

### Entry criteria

- Stages P05, P06, P08A, P08B имеют status `done` и evidence.
- Нет unresolved blocker, запрещающего работу этапа.

### Work packages

- Changes file tree and Monaco diff.
- Simplified semantic diff.
- Restore file/deleted file/hunk from UI.
- Validation panel.
- Commit dialog, push and create MR UI.
- Exact Alpha evidence collection.

### Artifacts

- Changes UI
- semantic diff view
- commit/push/MR flow
- Alpha report

### Automated verification

- Playwright E2E-021 through E2E-024 with GitLab test double

### Manual acceptance

- Пройти основной workflow от создания задач до MR без терминала.

### Owned E2E

- `E2E-021`
- `E2E-022`
- `E2E-023`
- `E2E-024`

### Exit gate

- Все artifacts присутствуют и review завершен.
- Automated verification и owned E2E успешны.
- Acceptance roles (PO, QA, SEC) зафиксировали результат.
- `PROGRESS.md` содержит evidence и следующий action.

## P10. История и revert workflow без rebase

- Size: `M`
- Estimate: `4-7 engineer-days`
- Dependencies: `P09`
- Accountable: `BE`
- Responsible: `BE, FE, QA`
- Acceptance: `QA`
- Milestone: `beta`

### Objective

Добавить историю и revert, не строя rebase/conflict subsystem.

### Entry criteria

- Stages P09 имеют status `done` и evidence.
- Нет unresolved blocker, запрещающего работу этапа.

### Work packages

- Commit history and file history.
- Commit detail and compare.
- Create revert draft using git revert.
- Show behind/conflict status returned by GitLab.
- Provide external-client/new-draft guidance.

### Artifacts

- History UI
- revert service
- divergence warning

### Automated verification

- history and revert integration/browser tests

### Manual acceptance

- Создать revert draft для merged fixture и проверить отсутствие rebase controls.

### Owned E2E

- `E2E-025`

### Exit gate

- Все artifacts присутствуют и review завершен.
- Automated verification и owned E2E успешны.
- Acceptance roles (QA) зафиксировали результат.
- `PROGRESS.md` содержит evidence и следующий action.

## P11A. Board и сохраненные представления

- Size: `M`
- Estimate: `4-7 engineer-days`
- Dependencies: `P09`
- Accountable: `FE`
- Responsible: `FE, BE, QA`
- Acceptance: `PO, QA`
- Milestone: `beta`

### Objective

Добавить Kanban Board и saved views.

### Entry criteria

- Stages P09 имеют status `done` и evidence.
- Нет unresolved blocker, запрещающего работу этапа.

### Work packages

- Status columns and card rendering.
- Drag-and-drop status update.
- Filters and optional swimlane.
- Saved View YAML.

### Artifacts

- Board UI
- ViewConfiguration files

### Automated verification

- drag, filter and persistence browser tests

### Manual acceptance

- Перетащить task и увидеть ровно одно изменение task YAML.

### Owned E2E

- `E2E-026`

### Exit gate

- Все artifacts присутствуют и review завершен.
- Automated verification и owned E2E успешны.
- Acceptance roles (PO, QA) зафиксировали результат.
- `PROGRESS.md` содержит evidence и следующий action.

## P11B. Упрощенная календарная модель

- Size: `S`
- Estimate: `2-4 engineer-days`
- Dependencies: `P08B`
- Accountable: `BE`
- Responsible: `BE, FE, QA`
- Acceptance: `PO, QA`
- Milestone: `beta`

### Objective

Определить простую date-only календарную основу для отчетов.

### Entry criteria

- Stages P08B имеют status `done` и evidence.
- Нет unresolved blocker, запрещающего работу этапа.

### Work packages

- Working weekdays and holiday dates.
- Date validation helpers.
- No timezone, DST or automatic scheduling.

### Artifacts

- calendar model
- date utilities

### Automated verification

- weekday/holiday calculation tests

### Manual acceptance

- Показать расчет на двух календарях и документировать ограничения.

### Owned E2E

- `E2E-027`

### Exit gate

- Все artifacts присутствуют и review завершен.
- Automated verification и owned E2E успешны.
- Acceptance roles (PO, QA) зафиксировали результат.
- `PROGRESS.md` содержит evidence и следующий action.

## P11C. Read-only Gantt

- Size: `M`
- Estimate: `4-7 engineer-days`
- Dependencies: `P11B, P08A`
- Accountable: `FE`
- Responsible: `FE, BE, QA`
- Acceptance: `PO, QA`
- Milestone: `beta`

### Objective

Показать read-only Gantt без интерактивного планировщика.

### Entry criteria

- Stages P11B, P08A имеют status `done` и evidence.
- Нет unresolved blocker, запрещающего работу этапа.

### Work packages

- Render hierarchy, dates, milestones and dependencies.
- Virtualize large project view where needed.
- Open task details from bar.
- Disable drag/resize/edit.

### Artifacts

- read-only Gantt view

### Automated verification

- render and browser read-only tests

### Manual acceptance

- Проверить, что Gantt полезен для просмотра и не изменяет files.

### Owned E2E

- `E2E-028`

### Exit gate

- Все artifacts присутствуют и review завершен.
- Automated verification и owned E2E успешны.
- Acceptance roles (PO, QA) зафиксировали результат.
- `PROGRESS.md` содержит evidence и следующий action.

## P11D. Упрощенный Workload

- Size: `M`
- Estimate: `4-7 engineer-days`
- Dependencies: `P11B, P08B`
- Accountable: `BE`
- Responsible: `BE, FE, QA`
- Acceptance: `PO, QA`
- Milestone: `beta`

### Objective

Добавить простой объяснимый Workload report.

### Entry criteria

- Stages P11B, P08B имеют status `done` и evidence.
- Нет unresolved blocker, запрещающего работу этапа.

### Work packages

- Spread estimate evenly across ISO weeks between start/due.
- Aggregate by person and weekly_capacity.
- Display approximate overload and drill-down tasks.
- Document formula limitations.

### Artifacts

- workload calculator
- Workload UI

### Automated verification

- deterministic calculation fixtures

### Manual acceptance

- Сверить вручную несколько недель и увидеть explanation в UI.

### Owned E2E

- `E2E-029`

### Exit gate

- Все artifacts присутствуют и review завершен.
- Automated verification и owned E2E успешны.
- Acceptance roles (PO, QA) зафиксировали результат.
- `PROGRESS.md` содержит evidence и следующий action.

## P12. Работа агентов через файлы и CLI

- Size: `M`
- Estimate: `4-7 engineer-days`
- Dependencies: `P02, P03, P05, P06`
- Accountable: `BE`
- Responsible: `BE, QA`
- Acceptance: `ARCH, QA`
- Milestone: `beta`

### Objective

Сделать поддерживаемый agent workflow без MCP.

### Entry criteria

- Stages P02, P03, P05, P06 имеют status `done` и evidence.
- Нет unresolved blocker, запрещающего работу этапа.

### Work packages

- Document dedicated worktree provisioning.
- Complete CLI format/validate/diff/push/mr commands.
- Optional CLI project scope and allow-delete flag.
- Agent prompt/runbook examples.
- Ensure server and CLI share validation code.

### Artifacts

- agent CLI workflow
- agent runbook
- example task decomposition session

### Automated verification

- agent-local end-to-end fixture

### Manual acceptance

- Агент создает задачи путем редактирования files и формирует MR через CLI.

### Owned E2E

- `E2E-030`

### Exit gate

- Все artifacts присутствуют и review завершен.
- Automated verification и owned E2E успешны.
- Acceptance roles (ARCH, QA) зафиксировали результат.
- `PROGRESS.md` содержит evidence и следующий action.

## P13A. Security hardening

- Size: `M`
- Estimate: `4-7 engineer-days`
- Dependencies: `P09, P10, P11A, P11C, P11D, P12`
- Accountable: `SEC`
- Responsible: `SEC, BE, FE, QA`
- Acceptance: `SEC, QA`
- Milestone: `release_candidate`

### Objective

Провести итоговый security hardening без новых архитектурных подсистем.

### Entry criteria

- Stages P09, P10, P11A, P11C, P11D, P12 имеют status `done` и evidence.
- Нет unresolved blocker, запрещающего работу этапа.

### Work packages

- Run hostile repository and browser fixtures.
- Review OAuth token memory-only behavior.
- Fault test interrupted writes and process restart.
- Dependency and container scans.
- Record residual risks.

### Artifacts

- security report
- scan reports
- risk acceptance

### Automated verification

- security regression suite

### Manual acceptance

- SEC принимает residual risks и подтверждает отсутствие secrets in logs/disk.

### Owned E2E

- `E2E-031`

### Exit gate

- Все artifacts присутствуют и review завершен.
- Automated verification и owned E2E успешны.
- Acceptance roles (SEC, QA) зафиксировали результат.
- `PROGRESS.md` содержит evidence и следующий action.

## P13B. Эксплуатационная проверка и smoke performance

- Size: `M`
- Estimate: `4-7 engineer-days`
- Dependencies: `P09, P11A, P11C, P11D`
- Accountable: `QA`
- Responsible: `BE, FE, QA`
- Acceptance: `ARCH, QA`
- Milestone: `release_candidate`

### Objective

Проверить эксплуатационную пригодность и простые performance budgets.

### Entry criteria

- Stages P09, P11A, P11C, P11D имеют status `done` и evidence.
- Нет unresolved blocker, запрещающего работу этапа.

### Work packages

- Run three-iteration median benchmarks.
- Verify health/logging/Git duration and GitLab errors.
- Exercise several parallel draft functionally.
- Write install, upgrade and troubleshooting runbook.

### Artifacts

- benchmark report
- operations runbook
- release diagnostics checklist

### Automated verification

- smoke benchmark and clean deployment test

### Manual acceptance

- Operator выполняет install, restart and diagnostics по runbook.

### Owned E2E


### Exit gate

- Все artifacts присутствуют и review завершен.
- Automated verification и owned E2E успешны.
- Acceptance roles (ARCH, QA) зафиксировали результат.
- `PROGRESS.md` содержит evidence и следующий action.

## P14. Release acceptance v0.1

- Size: `S`
- Estimate: `2-4 engineer-days`
- Dependencies: `P13A, P13B`
- Accountable: `PO`
- Responsible: `ARCH, BE, FE, QA, SEC`
- Acceptance: `PO, QA, SEC`
- Milestone: `release`

### Objective

Собрать exact evidence и выпустить v0.1.

### Entry criteria

- Stages P13A, P13B имеют status `done` и evidence.
- Нет unresolved blocker, запрещающего работу этапа.

### Work packages

- Run exact release gate from registry.
- Verify all stage/e2e evidence.
- Review known limitations.
- Create changelog and tag.

### Artifacts

- release checklist
- changelog
- tag v0.1

### Automated verification

- all mandatory E2E and planning validation

### Manual acceptance

- PO, QA и SEC подписывают release acceptance.

### Owned E2E

- `E2E-032`

### Exit gate

- Все artifacts присутствуют и review завершен.
- Automated verification и owned E2E успешны.
- Acceptance roles (PO, QA, SEC) зафиксировали результат.
- `PROGRESS.md` содержит evidence и следующий action.

## 7. Release gates

### alpha

Required stages: `P00, P00S, P01, P02, P03, P04, P05, P06, P07, P08A, P08B, P09`

Required E2E: `E2E-001, E2E-002, E2E-004, E2E-005, E2E-006, E2E-007, E2E-008, E2E-009, E2E-010, E2E-011, E2E-012, E2E-013, E2E-014, E2E-015, E2E-016, E2E-017, E2E-018, E2E-019, E2E-020, E2E-021, E2E-022, E2E-023, E2E-024`

### beta

Required stages: `P00, P00S, P01, P02, P03, P04, P05, P06, P07, P08A, P08B, P09, P10, P11A, P11B, P11C, P11D, P12`

Required E2E: `E2E-001, E2E-002, E2E-004, E2E-005, E2E-006, E2E-007, E2E-008, E2E-009, E2E-010, E2E-011, E2E-012, E2E-013, E2E-014, E2E-015, E2E-016, E2E-017, E2E-018, E2E-019, E2E-020, E2E-021, E2E-022, E2E-023, E2E-024, E2E-025, E2E-026, E2E-027, E2E-028, E2E-029, E2E-030`

### release_candidate

Required stages: `P00, P00S, P01, P02, P03, P04, P05, P06, P07, P08A, P08B, P09, P10, P11A, P11B, P11C, P11D, P12, P13A, P13B`

Required E2E: `E2E-001, E2E-002, E2E-003, E2E-004, E2E-005, E2E-006, E2E-007, E2E-008, E2E-009, E2E-010, E2E-011, E2E-012, E2E-013, E2E-014, E2E-015, E2E-016, E2E-017, E2E-018, E2E-019, E2E-020, E2E-021, E2E-022, E2E-023, E2E-024, E2E-025, E2E-026, E2E-027, E2E-028, E2E-029, E2E-030, E2E-031, E2E-032`

### release

Required stages: `P00, P00S, P01, P02, P03, P04, P05, P06, P07, P08A, P08B, P09, P10, P11A, P11B, P11C, P11D, P12, P13A, P13B, P14`

Required E2E: `E2E-001, E2E-002, E2E-003, E2E-004, E2E-005, E2E-006, E2E-007, E2E-008, E2E-009, E2E-010, E2E-011, E2E-012, E2E-013, E2E-014, E2E-015, E2E-016, E2E-017, E2E-018, E2E-019, E2E-020, E2E-021, E2E-022, E2E-023, E2E-024, E2E-025, E2E-026, E2E-027, E2E-028, E2E-029, E2E-030, E2E-031, E2E-032`
