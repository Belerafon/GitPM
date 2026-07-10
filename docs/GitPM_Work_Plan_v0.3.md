# GitPM: исполнимый план работ, верификации и поставки

Версия документа: 0.3  
Статус: обязательный исполнимый план v0.1

## 1. Источники истины

- Формальный DAG, E2E specifications и release gates: `GitPM_Requirements_Traceability_v0.2.yaml`.
- Архитектура: `GitPM_Implementation_Plan_v0.4.md`.
- Политики: `GitPM_Delivery_Policies_v0.2.md`.
- Security baseline: `GitPM_Security_Baseline_v0.2.md`.
- Фактический прогресс и evidence: `PROGRESS.md`.

Этот документ не содержит ручного поля "Параллельность". Возможная параллельная работа вычисляется только из DAG. Если этап зависит от части другого этапа, зависимый этап разделяется, как сделано с P06A и P06B.

## 2. Milestones

- Alpha = MVP. Это первый поддерживаемый полезный продукт с полным human workflow через реальный GitLab MR.
- Beta. Feature-complete v0.1: история, конфликты, Board, Calendar, Gantt, Workload и agents.
- Release Candidate. Итоговые security, fault, performance и operations gates.
- v0.1. Точная приемка по registry, tag и release evidence.

## 3. Размеры и ответственность

- S: 1-3 инженерных дня.
- M: 4-7 инженерных дней.
- L: 8-12 инженерных дней.
- XL запрещен; работа свыше 12 дней должна быть разделена до старта.

Для каждого этапа:

- Accountable: один владелец, принимающий решение о закрытии.
- Responsible: исполнители.
- Acceptance: роли, подтверждающие результат.

## 4. Общий Definition of Done

- Код и документы находятся в отдельном commit/MR.
- Автоматические проверки этапа зеленые.
- Обязательные E2E имеют воспроизводимые evidence artifacts.
- Security и performance исключения записаны явно.
- `PROGRESS.md` содержит commit SHA, pipeline, результаты и следующий шаг.
- Stage закрывается только после exit gate.

## 5. Тестовая стратегия

- Unit: domain logic, parser, graph, policies.
- Integration: real Git repositories and filesystem.
- Contract: HTTP, GitLab, webhook and MCP schemas.
- E2E: browser/agent -> GitPM -> Git -> GitLab.
- Security: browser, filesystem, Git runner, OAuth, authz and agents.
- Fault: process kill, disk full, network failure and corrupt local state.
- Performance: stable runner, fixed fixtures and raw samples.
- Migration: previous-version fixture, dry-run, apply and Git revert.

## 6. DAG

Dependency list is authoritative and machine-checked:
- `P00` depends on: none.
- `P00S` depends on: P00.
- `P01` depends on: P00.
- `P02` depends on: P01.
- `P03` depends on: P00S, P02.
- `P04` depends on: P03.
- `P05` depends on: P04.
- `P06A` depends on: P00S, P04.
- `P06B` depends on: P05, P06A.
- `P07` depends on: P04, P06A.
- `P08A` depends on: P07.
- `P08B` depends on: P07, P02.
- `P09` depends on: P05, P06B, P08A, P08B.
- `P10A` depends on: P09.
- `P10B` depends on: P10A.
- `P11A` depends on: P09.
- `P11B` depends on: P08B, P09.
- `P11C` depends on: P11B.
- `P11D` depends on: P11B.
- `P12` depends on: P10B, P11A.
- `P13A` depends on: P10B, P11C, P11D, P12.
- `P13B` depends on: P13A.
- `P14` depends on: P13B.

The validator checks unknown dependencies, duplicate IDs and cycles, and calculates topological order. There is no separately maintained critical-path sentence that can diverge from the graph.

## 7. Этапы

## P00. Bootstrap, CI и базовая наблюдаемость

- Accountable: `ARCH`
- Responsible: `BE`, `FE`, `QA`
- Acceptance: `ARCH`, `QA`
- Size: `M`
- Estimate: `4-7` engineering days
- Dependencies: none
- Milestone: `foundation`

### Objective

Получить воспроизводимый monorepo и минимальную эксплуатационную видимость до появления Git-операций.

### Entry criteria

- Планы и registry находятся в Git.
- Выбраны версии Node.js, pnpm, Git и reference Linux image.

### Work packages

- Создать pnpm monorepo и package boundaries.
- Добавить lint, typecheck, unit test и build.
- Добавить deterministic lockfile и clean-install job.
- Добавить /health/live и /health/ready.
- Ввести structured logs, correlation ID и запрет логирования секретов.
- Подключить planning validator к CI.

### Artifacts

- Monorepo skeleton.
- Baseline CI pipeline.
- Health endpoints.
- Logging convention и error envelope.

### Automated verification

- Чистая установка в контейнере.
- lint, typecheck, tests и build.
- planning validator.
- planning validator mutation self-test.
- Проверка отсутствия секретов в тестовых logs.

### Manual acceptance

- Развернуть чистый checkout на Linux и получить зеленый pipeline.
- Проверить liveness/readiness при штатном и ошибочном startup.

### Owned E2E

- `E2E-030`

### Exit gate

- Pipeline воспроизводим.
- Наблюдаемость достаточна для диагностики следующих этапов.

## P00S. Модель угроз и риск-ориентированные spikes

- Accountable: `SEC`
- Responsible: `ARCH`, `BE`, `QA`
- Acceptance: `SEC`, `ARCH`
- Size: `M`
- Estimate: `4-7` engineering days
- Dependencies: `P00`
- Milestone: `foundation`

### Objective

Закрыть неизвестности, которые могут сделать Git, filesystem, OAuth и browser surface небезопасными.

### Entry criteria

- P00 done.
- Доступен disposable GitLab test project той же major/minor версии, что production.

### Work packages

- Провести threat modeling по trust boundaries.
- Spike: command injection через ref и commit metadata.
- Spike: path traversal, symlink swap и atomic write.
- Spike: hard kill во время worktree add и file rename.
- Spike: push с пользовательским credential без утечки token.
- Spike: malicious repository content, hooks, filters, textconv и submodules.
- Spike: XSS через YAML, Markdown, commit и GitLab metadata.
- Spike: webhook replay.
- Spike: локальный safety ref и восстановление worktree при сохранном bare repository.

### Artifacts

- Threat model v1.
- ADR по безопасному Git runner.
- ADR по browser sanitization.
- Воспроизводимые security/fault tests.

### Automated verification

- Негативные tests каждого spike.
- Process-list и log scan на token.
- Filesystem race test.
- CSP/XSS component tests.

### Manual acceptance

- SEC review ADR и residual risks.
- Подтвердить, что нет зависимости от резервного копирования.

### Owned E2E

- No primary E2E; this stage is verified by component/integration gates and downstream E2E.

### Exit gate

- Подходы P03, P04 и P06 признаны реализуемыми.
- Критичные residual risks имеют owner и срок.

## P01. Идентичность сущностей и формат репозитория

- Accountable: `ARCH`
- Responsible: `BE`, `QA`
- Acceptance: `ARCH`, `QA`
- Size: `L`
- Estimate: `8-12` engineering days
- Dependencies: `P00`
- Milestone: `foundation`

### Objective

Зафиксировать единую модель идентичности и канонический формат файлов без двусмысленности между ID, key и path.

### Entry criteria

- P00 done.
- Принято решение ULID as canonical identity.

### Work packages

- Технический id: immutable ULID для всех сущностей.
- Display key: отдельный уникальный отображаемый атрибут, допускающий изменение.
- Имена файлов и каталоги используют ULID, а не display key.
- Все внутренние ссылки используют *_id с ULID.
- Mutation API принимает ULID; lookup API может разрешать display key в ULID.
- Определить JSON Schema и canonical field order.
- Зафиксировать политику YAML comments и manual editing.

### Artifacts

- Repository format specification.
- JSON Schemas.
- Fixture portfolio v1.
- ADR identity model.

### Automated verification

- Schema fixtures valid/invalid.
- Проверка переименования display key без переписывания ссылок и путей.
- Проверка глобальной уникальности ULID и scope uniqueness display key.

### Manual acceptance

- Изменить display key проекта и задачи; Git diff не должен затронуть связанные файлы.
- Проследить ссылку task -> project -> person только по ULID.

### Owned E2E

- No primary E2E; this stage is verified by component/integration gates and downstream E2E.

### Exit gate

- В документах, API и fixtures нет ссылок на display key как identity.
- Формат утвержден ARCH.

## P02. Parser, formatter, validation и миграции

- Accountable: `BE`
- Responsible: `BE`, `QA`
- Acceptance: `ARCH`, `QA`
- Size: `L`
- Estimate: `8-12` engineering days
- Dependencies: `P01`
- Milestone: `foundation`

### Objective

Реализовать строгую загрузку, форматирование, проверку связей и явные Git-visible migrations.

### Entry criteria

- P01 done.

### Work packages

- Strict YAML parser без aliases, anchors, custom tags и duplicate keys.
- Canonical serializer.
- Schema validation и cross-reference validation.
- Cycle detection.
- gitpm validate, lint, format.
- gitpm migrate --check, --dry-run и apply.
- Запрет неявной миграции при чтении.
- Fixture предыдущей версии.

### Artifacts

- repository-format package.
- validation package.
- CLI commands.
- Migration fixture и report format.

### Automated verification

- Parser fuzz/property tests.
- format idempotence.
- migration dry-run produces diff only.
- migration apply + validate + Git revert.

### Manual acceptance

- Открыть unsupported schema version и получить явную ошибку.
- Выполнить миграцию в draft и просмотреть diff.

### Owned E2E

- `E2E-031`
- `E2E-032`

### Exit gate

- Validation детерминирована.
- Migration mechanism готов до Alpha.

## P03. Git core, worktree и локальная сохранность draft

- Accountable: `BE`
- Responsible: `BE`, `SEC`, `QA`
- Acceptance: `SEC`, `QA`
- Size: `L`
- Estimate: `8-12` engineering days
- Dependencies: `P00S`, `P02`
- Milestone: `foundation`

### Objective

Реализовать безопасный Git core, отдельный worktree на draft и локальную сохранность без резервных копий.

### Entry criteria

- P00S и P02 done.

### Work packages

- Bare clone и worktree manager.
- Allowlisted Git runner с изолированной config environment.
- File locks и crash recovery.
- Atomic writes.
- Локальные safety refs refs/gitpm/safety/<draft-id>.
- Состояния local-dirty, local-safety-ref, committed-local, pushed.
- Восстановление worktree из safety ref при сохранном bare repository.
- Git duration, lock contention и safety freshness metrics.
- Явное предупреждение: потеря persistent volume невосстановима для unpushed data.

### Artifacts

- git-client package.
- worktree registry.
- local durability policy implementation.
- Recovery CLI/runbook.

### Automated verification

- Integration tests с временным bare remote.
- Hard-kill tests.
- Symlink/path tests.
- Safety ref recovery test.
- No shell/process token leak tests.

### Manual acceptance

- Убить процесс во время записи и worktree add.
- Удалить worktree directory, сохранить bare repo и восстановить draft.
- Подтвердить предупреждение о риске потери volume.

### Owned E2E

- `E2E-020`
- `E2E-028`
- `E2E-033`
- `E2E-034`

### Exit gate

- Restart процесса/контейнера не теряет данные при сохранном volume.
- No-backup boundary документирована и видна пользователю.

## P04. Backend draft API и доменные операции

- Accountable: `BE`
- Responsible: `BE`, `QA`
- Acceptance: `ARCH`, `QA`
- Size: `L`
- Estimate: `8-12` engineering days
- Dependencies: `P03`
- Milestone: `alpha`

### Objective

Предоставить domain API для draft и сущностей с optimistic concurrency, quotas и authorization hooks.

### Entry criteria

- P03 done.

### Work packages

- Draft lifecycle API.
- CRUD Project/Task/Milestone/Person/Team по ULID.
- Archive и physical delete.
- Restrict delete при ссылках.
- Blob SHA precondition.
- Atomic bulk semantics.
- Request limits, rate limits и quotas.
- Diff-based policy check hooks.
- HTTP metrics и safe error mapping.

### Artifacts

- Fastify API.
- API contract package.
- Domain service layer.
- Quota and policy engine interfaces.

### Automated verification

- API integration tests.
- Stale blob conflict.
- Quota atomicity.
- Delete restrict.
- Unknown display key lookup and ULID mutation tests.

### Manual acceptance

- Создать и изменить сущности через API test client.
- Удалить задачу и восстановить ее через Git CLI/API, без Changes UI.

### Owned E2E

- `E2E-016`
- `E2E-029`

### Exit gate

- Domain API не позволяет писать произвольные paths.
- Все mutations проверяют ULID, permissions и expected version.

## P05. Git changes API и restore file/hunk

- Accountable: `BE`
- Responsible: `BE`, `QA`
- Acceptance: `QA`
- Size: `M`
- Estimate: `4-7` engineering days
- Dependencies: `P04`
- Milestone: `alpha`

### Objective

Реализовать Git status/diff и безопасный restore целого файла или hunk.

### Entry criteria

- P04 done.

### Work packages

- Status parser.
- Unified and side-by-side diff model.
- Semantic diff base.
- Restore file.
- Restore deleted file.
- Restore hunk через checked reverse patch.
- Stale diff detection.
- Запрет arbitrary selected-lines restore в v0.1.

### Artifacts

- Git changes API.
- Patch engine.
- Diff fixtures.

### Automated verification

- Cross-platform LF/CRLF fixtures.
- Unicode paths/content.
- Stale hunk rejection.
- YAML validation after restore.

### Manual acceptance

- Изменить несколько hunks и восстановить один.
- Удалить файл и восстановить его.

### Owned E2E

- No primary E2E; this stage is verified by component/integration gates and downstream E2E.

### Exit gate

- Restore file/hunk надежен.
- restore/lines отсутствует в API и плане v0.1.

## P06A. OIDC contract, keyring и authorization engine

- Accountable: `SEC`
- Responsible: `BE`, `SEC`, `QA`
- Acceptance: `SEC`, `ARCH`
- Size: `M`
- Estimate: `4-7` engineering days
- Dependencies: `P00S`, `P04`
- Milestone: `alpha`

### Objective

Стабилизировать auth contract, keyring lifecycle и единый authorization decision engine.

### Entry criteria

- P00S и P04 done.
- Master key policy утверждена.

### Work packages

- OIDC Authorization Code + PKCE contract.
- Mounted secret file для production master key.
- Encrypted token records и rotation.
- GitLab role -> GitPM role mapping.
- Role x operation x entity x draft-state matrix.
- Deny precedence.
- Re-check rights before commit, push and MR.
- Diff-based protection permissions/config files.
- Auth/webhook metrics contract.

### Artifacts

- Auth API contract.
- Keyring implementation.
- Authorization matrix.
- Decision log format без sensitive data.

### Automated verification

- Token encrypt/decrypt/rotate.
- Lost key -> re-authentication.
- Role matrix parameterized tests.
- Revoked role blocks commit/push within cache TTL.

### Manual acceptance

- Изменить GitLab membership и проверить обновление effective permissions.
- Попытаться изменить permissions config обычным Contributor.

### Owned E2E

- `E2E-035`
- `E2E-036`

### Exit gate

- P07 может опираться на стабильный API contract.
- Security acceptance подписана SEC.

## P06B. Реальная интеграция GitLab: push, MR и webhooks

- Accountable: `BE`
- Responsible: `BE`, `SEC`, `QA`
- Acceptance: `SEC`, `QA`
- Size: `L`
- Estimate: `8-12` engineering days
- Dependencies: `P05`, `P06A`
- Milestone: `alpha`

### Objective

Подтвердить на реальном self-hosted GitLab полный путь push -> MR -> webhook.

### Entry criteria

- P05 и P06A done.
- Обязательный GitLab test project и OAuth application доступны.

### Work packages

- Login и token refresh на real GitLab.
- Push от имени пользователя.
- Create/update draft MR.
- Protected main policy.
- Webhook signature/replay protection и routing по одному project ID.
- Pipeline and MR status sync.
- GitLab API retries without duplicate effects.
- Metrics for OAuth, push, MR, webhook lag/failures.

### Artifacts

- GitLab client.
- Real integration test suite.
- Webhook handler.
- Test project setup script.

### Automated verification

- Real GitLab tests для scopes, authorship, protected branch, MR and webhook.
- Replay/foreign project rejection.
- Token absence scan.

### Manual acceptance

- Через browser login создать branch и MR; проверить автора и approval flow.
- Отозвать token и убедиться в корректной re-authentication.

### Owned E2E

- `E2E-021`
- `E2E-025`
- `E2E-026`
- `E2E-027`
- `E2E-043`

### Exit gate

- Test double не используется как доказательство stage done.
- Real GitLab evidence сохранено.

## P07. Frontend shell и управление draft

- Accountable: `FE`
- Responsible: `FE`, `BE`, `QA`
- Acceptance: `FE`, `QA`
- Size: `M`
- Estimate: `4-7` engineering days
- Dependencies: `P04`, `P06A`
- Milestone: `alpha`

### Objective

Создать frontend shell, single-repository experience и draft selector.

### Entry criteria

- P04 и P06A done.

### Work packages

- App shell и routing.
- Один configured repository без repository picker.
- Draft create/open/close.
- Top bar: branch, dirty, safety, validation, MR.
- SSE/WebSocket updates.
- CSP, safe Markdown и URL sanitizer.
- Error and loading states.

### Artifacts

- Web application shell.
- Shared UI components.
- Browser security configuration.

### Automated verification

- Component tests.
- Accessibility smoke.
- CSP/XSS tests.
- No repository selector test.

### Manual acceptance

- Войти, создать draft и увидеть изменения статусов после server events.

### Owned E2E

- No primary E2E; this stage is verified by component/integration gates and downstream E2E.

### Exit gate

- UI работает с contract P06A независимо от завершения P06B.
- Single repository boundary очевидна.

## P08A. Core UI: Project, Task и Milestone

- Accountable: `FE`
- Responsible: `FE`, `BE`, `QA`
- Acceptance: `PO`, `QA`
- Size: `L`
- Estimate: `8-12` engineering days
- Dependencies: `P07`
- Milestone: `alpha`

### Objective

Дать полноценный UI для Project, Task и Milestone.

### Entry criteria

- P07 done.

### Work packages

- Portfolio page.
- Project page.
- Task list and panel.
- Milestone CRUD.
- Archive/delete confirmations.
- Dependencies and parent selectors resolving key -> ULID.
- Virtualization для 3 000 tasks.

### Artifacts

- Core domain UI.
- Fixtures and component tests.

### Automated verification

- CRUD E2E without GitLab merge.
- Delete restrict.
- Stale edit conflict.
- XSS payload rendering.

### Manual acceptance

- Создать проект, milestone и задачи; изменить display key без каскадного diff.

### Owned E2E

- `E2E-002`
- `E2E-003`
- `E2E-004`
- `E2E-005`
- `E2E-006`

### Exit gate

- Core UI ready for Changes workflow.

## P08B. Administration UI: Person, Team и базовые настройки

- Accountable: `FE`
- Responsible: `FE`, `BE`, `QA`
- Acceptance: `PO`, `QA`
- Size: `M`
- Estimate: `4-7` engineering days
- Dependencies: `P07`, `P02`
- Milestone: `alpha`

### Objective

Реализовать административный UI v0.1 для Person, Team и базовых repository settings.

### Entry criteria

- P07 и P02 done.

### Work packages

- Person CRUD.
- Team CRUD and membership.
- Capacity base fields.
- Read-only status/issue type screens.
- Role-aware controls.
- Block edits forbidden by policy.

### Artifacts

- Administration UI.
- Role-specific UI tests.

### Automated verification

- CRUD and authorization tests.
- Hidden button is not sole authorization control.

### Manual acceptance

- Contributor and Maintainer проходят разные flows.

### Owned E2E

- `E2E-041`

### Exit gate

- Editable and read-only entity matrix соответствует Delivery Policies.

## P09. Changes UI, semantic diff, commit и Alpha/MVP gate

- Accountable: `ARCH`
- Responsible: `FE`, `BE`, `QA`
- Acceptance: `PO`, `QA`, `SEC`
- Size: `L`
- Estimate: `8-12` engineering days
- Dependencies: `P05`, `P06B`, `P08A`, `P08B`
- Milestone: `alpha`

### Objective

Закрыть Alpha, которая одновременно является MVP: UI -> YAML -> diff -> validate -> commit -> push -> MR.

### Entry criteria

- P05, P06B, P08A и P08B done.

### Work packages

- Changes file tree.
- File and semantic diff.
- Restore file/deleted/hunk UI.
- Validation report.
- Commit dialog.
- Push and create MR.
- Exact Alpha E2E suite.
- 3 000-task benchmark protocol.

### Artifacts

- Changes UI.
- Semantic diff report.
- Alpha evidence bundle.

### Automated verification

- Все E2E mandatory_from alpha.
- Performance budgets на stable runner.
- Permission re-check before commit/push.

### Manual acceptance

- Пользователь выполняет полный workflow без terminal.
- Удаленная задача восстанавливается через Changes.

### Owned E2E

- `E2E-001`
- `E2E-007`
- `E2E-008`
- `E2E-009`
- `E2E-010`
- `E2E-011`
- `E2E-012`
- `E2E-013`
- `E2E-014`
- `E2E-044`

### Exit gate

- Alpha = MVP gate passed.
- Нет selected-lines restore, repository selector или backup claims.

## P10A. История и revert workflow

- Accountable: `BE`
- Responsible: `BE`, `FE`, `QA`
- Acceptance: `QA`
- Size: `M`
- Estimate: `4-7` engineering days
- Dependencies: `P09`
- Milestone: `beta`

### Objective

Добавить историю commit и безопасный revert workflow.

### Entry criteria

- P09 done.

### Work packages

- Commit graph/list.
- File history.
- Compare revisions.
- Create revert draft.
- Revert merged commit через новый MR.

### Artifacts

- History UI.
- Revert service.

### Automated verification

- Commit history tests.
- Revert with subsequent changes.
- Authz checks.

### Manual acceptance

- Найти ошибочный merge и создать revert MR.

### Owned E2E

- `E2E-015`

### Exit gate

- Revert не меняет main напрямую.

## P10B. Rebase и conflict resolution

- Accountable: `BE`
- Responsible: `BE`, `FE`, `QA`
- Acceptance: `ARCH`, `QA`
- Size: `L`
- Estimate: `8-12` engineering days
- Dependencies: `P10A`
- Milestone: `beta`

### Objective

Реализовать rebase и воспроизводимый conflict resolution для YAML.

### Entry criteria

- P10A done.

### Work packages

- Update from main.
- Rebase start/continue/abort.
- Three-way conflict model.
- Conflict UI по файлам и сущностям.
- Validation before continue.
- Crash recovery during rebase.

### Artifacts

- Rebase service.
- Conflict UI.
- Conflict fixtures.

### Automated verification

- No-conflict and conflict tests.
- Abort restores prior state.
- Hard kill recovery.

### Manual acceptance

- Разрешить реальный YAML conflict без terminal.

### Owned E2E

- `E2E-017`
- `E2E-018`
- `E2E-019`

### Exit gate

- Конфликты не приводят к скрытой потере данных.

## P11A. Board и сохраненные views

- Accountable: `FE`
- Responsible: `FE`, `BE`, `QA`
- Acceptance: `PO`, `QA`
- Size: `M`
- Estimate: `4-7` engineering days
- Dependencies: `P09`
- Milestone: `beta`

### Objective

Добавить Board и сохраненные ViewConfiguration.

### Entry criteria

- P09 done.

### Work packages

- Kanban columns.
- Drag and drop.
- Filters, swimlanes and saved views.
- ViewConfiguration persisted by ULID references.
- Large-board virtualization.

### Artifacts

- Board UI.
- Saved views format.

### Automated verification

- Board drag -> YAML/diff.
- Saved view round-trip.
- Permission tests.

### Manual acceptance

- Настроить board и открыть его повторно.

### Owned E2E

- `E2E-037`
- `E2E-042`

### Exit gate

- Board не вводит скрытое состояние вне Git.

## P11B. Calendar administration и scheduling model

- Accountable: `BE`
- Responsible: `BE`, `FE`, `QA`
- Acceptance: `PO`, `QA`
- Size: `M`
- Estimate: `4-7` engineering days
- Dependencies: `P08B`, `P09`
- Milestone: `beta`

### Objective

Реализовать Calendar administration и тестируемую scheduling model.

### Entry criteria

- P08B и P09 done.

### Work packages

- Calendar CRUD.
- Working days, holidays and timezone.
- DST rules.
- Task duration/allocation primitives.
- Scheduling unit/property tests.

### Artifacts

- Calendar UI.
- Scheduling engine v1.

### Automated verification

- Timezone/DST fixtures.
- Holiday and capacity calculations.

### Manual acceptance

- Изменить календарь и увидеть пересчет дат.

### Owned E2E

- `E2E-039`

### Exit gate

- Scheduling model стабилен для Gantt и Workload.

## P11C. Gantt

- Accountable: `FE`
- Responsible: `FE`, `BE`, `QA`
- Acceptance: `PO`, `QA`
- Size: `L`
- Estimate: `8-12` engineering days
- Dependencies: `P11B`
- Milestone: `beta`

### Objective

Реализовать Gantt поверх scheduling model.

### Entry criteria

- P11B done.

### Work packages

- Hierarchy and milestones.
- Dependencies.
- Drag dates and duration.
- Viewport virtualization.
- Semantic schedule diff.

### Artifacts

- Gantt UI.
- Visual regression suite.

### Automated verification

- Date drag -> YAML/diff.
- Dependency rendering.
- Visual regression.

### Manual acceptance

- Перепланировать проект через Gantt.

### Owned E2E

- `E2E-038`

### Exit gate

- Gantt не обходит validation и permissions.

## P11D. Workload, capacity и overload

- Accountable: `BE`
- Responsible: `BE`, `FE`, `QA`
- Acceptance: `PO`, `QA`
- Size: `L`
- Estimate: `8-12` engineering days
- Dependencies: `P11B`
- Milestone: `beta`

### Objective

Реализовать Workload, capacity и overload warnings.

### Entry criteria

- P11B done.

### Work packages

- Weekly allocation.
- Person/team capacity.
- Overload detection.
- Filters and drill-down.
- 10 000-task computation benchmark.

### Artifacts

- Workload UI.
- Capacity engine.

### Automated verification

- Known allocation fixtures.
- Overload E2E.
- Performance tests.

### Manual acceptance

- Изменить capacity и проверить предупреждения.

### Owned E2E

- `E2E-040`

### Exit gate

- Расчеты воспроизводимы и объяснимы.

## P12. MCP и безопасная работа агентов

- Accountable: `BE`
- Responsible: `BE`, `SEC`, `QA`
- Acceptance: `SEC`, `PO`, `QA`
- Size: `L`
- Estimate: `8-12` engineering days
- Dependencies: `P10B`, `P11A`
- Milestone: `beta`

### Objective

Дать агентам scoped domain tools с теми же validation, authorization и Git gates.

### Entry criteria

- P10B и P11A done.

### Work packages

- MCP transport and authentication.
- Draft-scoped tools.
- Bulk preview.
- Agent policy and delete limits.
- Structured validation errors.
- Server-side commit/push gates.
- Agent-specific threat model update.

### Artifacts

- MCP server.
- Agent policy schema.
- Agent E2E suite.

### Automated verification

- Cross-project denial.
- Delete within/over limit.
- No raw filesystem/Git access.
- Rate and quota tests.

### Manual acceptance

- Агент получает ТЗ, создает scoped MR, человек проверяет diff.

### Owned E2E

- `E2E-022`
- `E2E-023`
- `E2E-024`

### Exit gate

- Agent cannot expand scope or bypass MR.

## P13A. Security и fault hardening

- Accountable: `SEC`
- Responsible: `SEC`, `BE`, `FE`, `QA`
- Acceptance: `SEC`, `ARCH`, `QA`
- Size: `L`
- Estimate: `8-12` engineering days
- Dependencies: `P10B`, `P11C`, `P11D`, `P12`
- Milestone: `release_candidate`

### Objective

Провести итоговое security и fault подтверждение без добавления новой фундаментальной модели.

### Entry criteria

- P10B, P11C, P11D и P12 done.

### Work packages

- Threat model final review.
- Browser security penetration tests.
- Malicious Git repository tests.
- Fault injection: disk full, network loss, process kill.
- Dependency/container scans.
- Quota abuse tests.
- Incident scenarios for lost key and lost persistent volume.
- Проверить честное сообщение: unpushed data after volume loss unrecoverable.

### Artifacts

- Security report.
- Fault report.
- Residual risk register.

### Automated verification

- Security suite.
- Fault suite.
- Scan reports.

### Manual acceptance

- SEC и ARCH принимают residual risks.

### Owned E2E

- No primary E2E; this stage is verified by component/integration gates and downstream E2E.

### Exit gate

- Критичные findings закрыты.
- Нет скрытого требования backup.

## P13B. Operations, performance и observability completion

- Accountable: `SRE`
- Responsible: `SRE`, `BE`, `QA`
- Acceptance: `SRE`, `ARCH`, `QA`
- Size: `L`
- Estimate: `8-12` engineering days
- Dependencies: `P13A`
- Milestone: `release_candidate`

### Objective

Завершить эксплуатационную готовность, benchmark protocol и наблюдаемость.

### Entry criteria

- P13A done.

### Work packages

- Metrics dashboards.
- Alerts for Git failures, lock contention, webhook lag, token errors, disk quota and safety freshness.
- Stable benchmark runner.
- 30-user/10-draft concurrency tests.
- Runbooks for restart, worktree recovery, key loss and volume loss.
- Cleanup and retention tests.

### Artifacts

- Operations handbook.
- Dashboards/alerts.
- Benchmark report.

### Automated verification

- 20 measured runs after warmup.
- Concurrency/load suite.
- Health/readiness failure modes.

### Manual acceptance

- Оператор восстанавливает worktree from local safety ref.
- Оператор объясняет последствия потери volume без обещания восстановления.

### Owned E2E

- `E2E-045`

### Exit gate

- Release Candidate operational gate passed.

## P14. Release acceptance v0.1

- Accountable: `PO`
- Responsible: `PO`, `QA`, `ARCH`
- Acceptance: `PO`, `QA`, `ARCH`
- Size: `M`
- Estimate: `4-7` engineering days
- Dependencies: `P13B`
- Milestone: `release`

### Objective

Провести точную приемку v0.1 по registry и зафиксировать release evidence.

### Entry criteria

- P13B done.

### Work packages

- Запустить exact release gate list.
- Проверить requirement coverage.
- Закрыть release blockers.
- Сформировать changelog and deployment guide.
- Зафиксировать known limitations.

### Artifacts

- Release evidence bundle.
- v0.1 tag.
- Known limitations.

### Automated verification

- Planning validator.
- Exact release E2E list.
- Clean install and upgrade smoke.

### Manual acceptance

- PO принимает пользовательский workflow.
- ARCH/SEC/QA подписывают свои gates.

### Owned E2E

- No primary E2E; this stage is verified by component/integration gates and downstream E2E.

### Exit gate

- v0.1 tagged and reproducible.

## 8. Release gates

### alpha

Alpha is the MVP. It proves the complete human workflow through a real GitLab MR.

Required stages and exact E2E IDs are read from the registry. Gate wording must not contain unspecified subsets.

### beta

Beta adds history/conflicts, board, calendars, Gantt, workload and agents.

Required stages and exact E2E IDs are read from the registry. Gate wording must not contain unspecified subsets.

### release_candidate

Release Candidate adds final security, fault, performance and operations evidence.

Required stages and exact E2E IDs are read from the registry. Gate wording must not contain unspecified subsets.

### release

v0.1 release requires every stage and every mandatory E2E.

Required stages and exact E2E IDs are read from the registry. Gate wording must not contain unspecified subsets.

## 9. Progress reporting

For each completed or blocked stage, `PROGRESS.md` records:

- status;
- accountable owner;
- commit SHA and MR;
- commands and pipeline links;
- exact E2E IDs and evidence paths;
- manual acceptance;
- exceptions and residual risks;
- next action.

Static work-package checklists remain only in this Work Plan and are not copied into PROGRESS.
