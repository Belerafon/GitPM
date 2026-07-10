# GitPM: план работ, верификации и поставки

Версия документа: 0.1
Статус: активный исполнимый план
Связанная архитектура: `GitPM_Implementation_Plan_v0.2.md`
Текущий прогресс: `docs/PROGRESS.md`

## 1. Назначение

Этот документ превращает архитектурную спецификацию в последовательность проверяемых этапов. Он отвечает на вопросы:

- что именно реализуется на каждом этапе;
- какие зависимости должны быть завершены;
- какие артефакты должны появиться;
- какими автоматическими и ручными проверками подтверждается результат;
- какие E2E-сценарии обязательны;
- когда этап действительно можно считать завершенным;
- какие доказательства необходимо записать в файл прогресса.

Этап нельзя закрыть формулировкой "вроде работает". Для закрытия нужны воспроизводимые команды, результаты CI и зафиксированные ограничения.

## 2. Статусы

Допустимые статусы этапа:

- `not_started` - работа не начиналась;
- `in_progress` - этап является текущим активным этапом;
- `blocked` - продолжение невозможно без решения внешней или архитектурной проблемы;
- `verification` - реализация завершена, выполняются проверки;
- `done` - все критерии выхода выполнены и доказательства записаны;
- `deferred` - этап осознанно перенесен отдельным решением;
- `failed` - результат не принят, требуется переработка.

Для обычной последовательной разработки одновременно должен существовать только один этап `in_progress`. Параллельная работа допустима только для независимых задач и должна быть явно отмечена.

## 3. Definition of Done для любой задачи

Задача считается завершенной, когда выполнены все применимые условия:

- код находится в целевой ветке разработки;
- добавлены или обновлены автоматические тесты;
- lint, typecheck и релевантные тесты проходят локально;
- публичный контракт документирован;
- ошибки возвращают стабильный код и полезное сообщение;
- нет скрытого бизнес-состояния вне Git;
- destructive operation имеет понятное preview;
- security implications рассмотрены;
- в файле прогресса указаны commit SHA и результаты проверки;
- известные ограничения записаны, а не оставлены в памяти разработчика.

## 4. Общие quality gates

Каждый этап проходит четыре ворот качества.

### Gate A. Реализация

- все запланированные deliverables существуют;
- нет заглушек, выдаваемых за завершенную функцию;
- незавершенные части явно помечены и не включены в критерии этапа.

### Gate B. Автоматическая проверка

- lint;
- typecheck;
- unit tests;
- integration tests, если этап затрагивает Git, файловую систему, API или GitLab;
- contract tests для публичного API;
- E2E tests для пользовательского workflow;
- security/fault tests для опасных операций.

### Gate C. Ручная приемка

- результат проверен через реальный пользовательский сценарий;
- diff и Git history просмотрены стандартным Git-клиентом;
- ошибки и отказные сценарии понятны без чтения исходного кода.

### Gate D. Фиксация доказательств

В `docs/PROGRESS.md` записываются:

- статус этапа;
- commit SHA;
- команды проверки;
- ссылка или ID pipeline;
- число прошедших и упавших тестов;
- результаты ручной проверки;
- известные ограничения;
- следующий этап.

## 5. Тестовая пирамида

### Unit tests

Покрывают чистую бизнес-логику, parser, formatter, validation rules, graph algorithms, semantic diff и workload calculations.

### Component tests

Покрывают React-компоненты, формы, selectors, diff controls и state transitions без полного backend.

### Integration tests

Используют временные каталоги и реальные Git-репозитории. Для Git нельзя заменять все вызовы mock-объектами: критичные сценарии выполняются системным `git`.

### Contract tests

Проверяют OpenAPI, MCP tool schemas, GitLab API adapter и стабильность error format.

### E2E tests

Запускаются через браузер и реальный server. Критичные GitLab-сценарии выполняются либо на отдельном test project, либо на максимально близком test double с отдельной периодической проверкой против настоящего GitLab.

### Security tests

Проверяют OAuth, token leakage, path traversal, symlink attacks, command injection, CSRF и webhook verification.

### Fault tests

Проверяют process kill, disk full, permission error, GitLab timeout, push rejection, corrupted YAML и незавершенный rebase.

### Performance tests

Проверяют загрузку 1 000, 10 000 и 100 000 сущностей, а также одновременную работу нескольких draft. Порог 100 000 является исследовательским, а не обязательным для v0.1.

## 6. Обязательные E2E-сценарии

Сценарии имеют стабильные ID и не удаляются после обнаружения регрессии. Неактуальный сценарий можно только пометить deprecated с объяснением.

### E2E-001. Первый вход и создание draft

Пользователь входит через GitLab, выбирает repository, создает draft от `main` и видит отдельную ветку и clean worktree.

### E2E-002. Создание задачи через UI

Пользователь создает задачу, видит новый YAML-файл, semantic diff и корректный Git status.

### E2E-003. Изменение одной задачи

Изменение одного поля приводит к локальному diff одного файла без переформатирования соседних сущностей.

### E2E-004. Архивирование задачи

Archive меняет lifecycle, но не удаляет файл.

### E2E-005. Физическое удаление задачи

Delete удаляет файл, Changes показывает deleted entity и позволяет восстановление.

### E2E-006. Блокировка удаления связанной задачи

Удаление задачи с child или incoming dependency блокируется и показывает список ссылок.

### E2E-007. Restore deleted file

Удаленная задача полностью восстанавливается из HEAD без собственного Undo.

### E2E-008. Restore hunk

Пользователь отменяет только одно изменение из нескольких в одном файле.

### E2E-009. Validation blocks commit

Невалидная ссылка или цикл блокируют commit и указывают конкретный файл и поле.

### E2E-010. Commit draft

После успешной validation пользователь создает commit, worktree становится clean, author и trailers корректны.

### E2E-011. Push branch

Ветка появляется в GitLab от имени пользователя, локальный commit SHA совпадает с remote.

### E2E-012. Create Merge Request

MR создается из UI, содержит semantic summary, validation status и ссылку на GitPM draft.

### E2E-013. Webhook update

Изменение статуса MR или pipeline в GitLab появляется в UI без ручной перезагрузки.

### E2E-014. Merge and refresh main

После merge пользователь видит обновленный `main`, а draft получает состояние merged.

### E2E-015. Revert merged commit

Из History создается новый revert draft, затем отдельный MR без переписывания истории.

### E2E-016. Stale edit conflict

Две вкладки редактируют один файл. Вторая запись получает version conflict, а не перезаписывает данные.

### E2E-017. Rebase without conflicts

Draft обновляется от `main`, commit сохраняется и diff остается семантически тем же.

### E2E-018. Rebase with YAML conflict

UI показывает three-way conflict, пользователь разрешает его, validation проходит, rebase продолжается.

### E2E-019. Abort rebase

Abort полностью возвращает состояние draft до начала rebase.

### E2E-020. Server restart recovery

После restart сервер обнаруживает существующий dirty worktree и продолжает работу без потери изменений.

### E2E-021. GitLab unavailable

Commit остается локально, push возвращает понятную ошибку, повторная попытка успешна после восстановления GitLab.

### E2E-022. Agent scoped creation

Агент создает набор задач только в разрешенном проекте, запускает validation и создает draft MR.

### E2E-023. Agent cross-project deletion attack

Агент пытается удалить одноименные сущности из других проектов. Policy отклоняет операцию до commit/push.

### E2E-024. Trusted agent deletion

Агент с явным delete permission удаляет разрешенную сущность, а MR показывает deleted file и semantic summary.

### E2E-025. Protected main

Ни пользователь, ни агент не могут напрямую push в `main` через GitPM.

### E2E-026. Board drag

Перемещение карточки меняет только status соответствующей задачи.

### E2E-027. Gantt date change

Перемещение задачи меняет start/due, а semantic diff показывает изменение сроков и загрузки.

### E2E-028. Workload overload

Изменение назначения создает перегрузку, отображаемую в Workload и semantic diff.

### E2E-029. Token secrecy

OAuth token отсутствует в browser storage, logs, Git remote URL и process arguments.

### E2E-030. Clean installation

Release разворачивается по документации в чистом окружении и проходит smoke tests.

## 7. Правила регрессии

- Любой production defect сначала воспроизводится новым или существующим автоматическим тестом.
- Исправление не принимается без теста, который падал до исправления.
- Критичная ошибка удаления, scope или Git history получает E2E regression test.
- Flaky test не отключается молча. Он получает issue, владельца и срок устранения.
- Удаление теста требует отдельного объяснения в commit.

## 8. Этапы реализации

## P00. Bootstrap и воспроизводимое окружение

Статус при создании плана: `not_started`
Зависимости: Нет.

### Цель

Создать воспроизводимый monorepo, единые команды разработки и минимальный CI, на котором можно безопасно строить остальные этапы.

### Работы

- [ ] Создать pnpm workspace с приложениями `web`, `server`, `cli`, `mcp` и общими пакетами.
- [ ] Зафиксировать поддерживаемые версии Node.js, pnpm и Git.
- [ ] Настроить TypeScript strict mode, ESLint, formatter и единый tsconfig.
- [ ] Добавить команды `build`, `lint`, `typecheck`, `test`, `test:integration`, `test:e2e`.
- [ ] Добавить Dockerfile для development и production build.
- [ ] Создать GitLab CI pipeline с install, lint, typecheck, unit test и build.
- [ ] Создать каталог временных тестовых репозиториев вне исходного дерева.
- [ ] Добавить документированную процедуру запуска проекта с нуля.

### Результаты этапа

- [ ] Собираемый monorepo без бизнес-логики.
- [ ] CI pipeline, запускающийся на каждом commit и Merge Request.
- [ ] README с командами локального запуска.
- [ ] ADR о структуре monorepo и выборе инструментов.

### Автоматическая верификация

- [ ] `pnpm install --frozen-lockfile` завершается успешно в чистом окружении.
- [ ] `pnpm lint` завершается без ошибок.
- [ ] `pnpm typecheck` завершается без ошибок.
- [ ] `pnpm test` завершается успешно.
- [ ] `pnpm build` создает production artifacts.
- [ ] Docker image собирается без root-процесса приложения.

### Тесты этапа

- [ ] Smoke test запуска server и получает `200` от `/health/live`.
- [ ] Smoke test открывает frontend shell.
- [ ] CI test проверяет отсутствие незакоммиченных сгенерированных файлов после build.

### Ручная приемка

- [ ] Развернуть проект на чистой машине или в чистом контейнере только по README.
- [ ] Убедиться, что ошибка несовместимой версии Node.js объясняется явно.

### Критерии выхода

- [ ] Все обязательные CI jobs зеленые.
- [ ] Локальная и CI-сборка используют одинаковые команды.
- [ ] В файле прогресса записаны версии инструментов и ссылка на pipeline.

### Доказательства для файла прогресса

- Commit SHA реализации этапа.
- Точные команды автоматической проверки.
- Ссылка или ID успешного pipeline.
- Перечень выполненных E2E-сценариев.
- Результат ручной приемки.
- Известные ограничения и открытые дефекты.

## P01. Формат репозитория и доменная модель

Статус при создании плана: `not_started`
Зависимости: P00.

### Цель

Зафиксировать устойчивый текстовый формат всех сущностей и загрузить демонстрационный портфель без Git-операций и UI.

### Работы

- [ ] Определить версии схем Project, Task, Person, Team, Milestone, Calendar и RepositoryConfig.
- [ ] Зафиксировать ULID как технический ID и человекочитаемый key как отображаемый номер.
- [ ] Описать расположение файлов и правила соответствия пути типу сущности.
- [ ] Реализовать строгий YAML parser без aliases, anchors и custom tags.
- [ ] Реализовать канонический serializer с фиксированным порядком полей.
- [ ] Реализовать загрузчик полного portfolio tree.
- [ ] Создать демонстрационный портфель минимум из 3 проектов, 8 людей и 40 задач.
- [ ] Добавить версионирование схем и ошибку для неподдерживаемой версии.

### Результаты этапа

- [ ] TypeScript domain types.
- [ ] JSON Schema для всех сущностей.
- [ ] Parser, serializer и repository loader.
- [ ] Demo portfolio и набор невалидных fixtures.
- [ ] Документация формата с корректными и ошибочными примерами.

### Автоматическая верификация

- [ ] Каждый demo YAML проходит schema validation.
- [ ] Parse -> serialize -> parse сохраняет семантически эквивалентный объект.
- [ ] Повторный formatter не меняет файл.
- [ ] Repository loader выдает детерминированный порядок и одинаковый результат на разных ОС.

### Тесты этапа

- [ ] Unit tests для каждого типа сущности.
- [ ] Property-based test идемпотентности formatter.
- [ ] Tests для duplicate keys, aliases, anchors, BOM, неизвестных полей и неверной версии схемы.
- [ ] Snapshot tests канонического YAML.

### Ручная приемка

- [ ] Открыть demo portfolio обычным текстовым редактором и проверить читаемость.
- [ ] Сделать ручной Git diff после изменения одной задачи и проверить локальность изменений.

### Критерии выхода

- [ ] Формат не требует UI или базы данных для чтения.
- [ ] Все fixtures имеют ожидаемые коды ошибок.
- [ ] Изменение одного поля не переформатирует несвязанные файлы.

### Доказательства для файла прогресса

- Commit SHA реализации этапа.
- Точные команды автоматической проверки.
- Ссылка или ID успешного pipeline.
- Перечень выполненных E2E-сценариев.
- Результат ручной приемки.
- Известные ограничения и открытые дефекты.

## P02. Валидатор, линтер и семантическая целостность

Статус при создании плана: `not_started`
Зависимости: P01.

### Цель

Сделать единый механизм проверки, используемый CLI, сервером, CI и агентами.

### Работы

- [ ] Реализовать schema validation через Ajv.
- [ ] Реализовать уникальность ID и key.
- [ ] Проверять ссылки project, person, milestone, parent и depends_on.
- [ ] Реализовать обнаружение parent cycles и dependency cycles.
- [ ] Проверять даты, оценки, lifecycle и ограничения удаления.
- [ ] Реализовать warning-level правила линтера отдельно от ошибок.
- [ ] Определить стабильные error codes и JSON output.
- [ ] Реализовать `gitpm validate`, `gitpm lint`, `gitpm format`, `gitpm doctor` и `gitpm explain`.
- [ ] Добавить policy validation для project scope, allowed operations и limits.

### Результаты этапа

- [ ] Пакет validation.
- [ ] CLI с human-readable и JSON output.
- [ ] Каталог документации кодов ошибок.
- [ ] GitLab CI job проверки portfolio repository.

### Автоматическая верификация

- [ ] `gitpm validate examples/demo-portfolio` возвращает exit code 0.
- [ ] Каждый invalid fixture возвращает ожидаемый error code и путь.
- [ ] Warning не меняет exit code без режима strict.
- [ ] Policy запрещает агенту менять посторонний проект или превышать лимит удаления.

### Тесты этапа

- [ ] Unit tests всех правил.
- [ ] Property-based tests случайных графов для cycle detection.
- [ ] Integration test CLI exit codes и JSON schema ответа.
- [ ] Regression test на ошибку удаления одноименных этапов из разных проектов.

### Ручная приемка

- [ ] Исправить невалидный fixture только по сообщению CLI без чтения исходного кода.
- [ ] Проверить, что ошибка агента содержит достаточно данных для повторного вызова.

### Критерии выхода

- [ ] Нет известных способов записать невалидное состояние через публичный domain API.
- [ ] CLI и library возвращают одинаковые ошибки.
- [ ] Политики покрывают create, update, archive и delete.

### Доказательства для файла прогресса

- Commit SHA реализации этапа.
- Точные команды автоматической проверки.
- Ссылка или ID успешного pipeline.
- Перечень выполненных E2E-сценариев.
- Результат ручной приемки.
- Известные ограничения и открытые дефекты.

## P03. Git core и управление worktree

Статус при создании плана: `not_started`
Зависимости: P00-P02.

### Цель

Реализовать надежный слой реального Git без имитации истории в приложении.

### Работы

- [ ] Реализовать безопасный process runner без shell interpolation.
- [ ] Реализовать bare clone и fetch.
- [ ] Реализовать создание, список, восстановление и удаление worktree.
- [ ] Реализовать naming и validation веток draft.
- [ ] Реализовать файловые locks для mutating operations.
- [ ] Реализовать status, diff, log, show, merge-base и branch state.
- [ ] Реализовать commit с author и trailers.
- [ ] Реализовать push через credential helper.
- [ ] Реализовать rebase, abort, continue и conflict detection.
- [ ] Реализовать revert commit в новой ветке.

### Результаты этапа

- [ ] Пакет git-client.
- [ ] Worktree registry с восстановлением после restart.
- [ ] Integration test harness с локальным bare remote.
- [ ] Документированный state machine draft.

### Автоматическая верификация

- [ ] После restart список worktree восстанавливается из Git и metadata.
- [ ] Параллельные операции над одним worktree сериализуются.
- [ ] Операции разных worktree не блокируют друг друга.
- [ ] Невалидное имя ветки или путь не попадает в команду Git.
- [ ] Push rejection возвращает структурированную ошибку без потери локального commit.

### Тесты этапа

- [ ] Integration tests clone, fetch, worktree add/remove, commit, push, rebase, conflict, abort и revert.
- [ ] Fault test убийства процесса между записью metadata и созданием worktree.
- [ ] Security tests command injection и path traversal.
- [ ] Concurrency test двух draft от одной base branch.

### Ручная приемка

- [ ] Распаковать test repository и проверить его стандартным Git-клиентом.
- [ ] Создать конфликт двух веток и убедиться, что исходные commit не потеряны.

### Критерии выхода

- [ ] Все Git workflows выполняются без UI через integration tests.
- [ ] Нет собственного хранения commit history.
- [ ] Recovery procedure документирована и проверена.

### Доказательства для файла прогресса

- Commit SHA реализации этапа.
- Точные команды автоматической проверки.
- Ссылка или ID успешного pipeline.
- Перечень выполненных E2E-сценариев.
- Результат ручной приемки.
- Известные ограничения и открытые дефекты.

## P04. Backend draft API и файловые операции

Статус при создании плана: `not_started`
Зависимости: P01-P03.

### Цель

Предоставить серверный API, через который можно выполнить полный локальный workflow до push.

### Работы

- [ ] Создать Fastify server и общий API contract.
- [ ] Реализовать repository и draft endpoints.
- [ ] Реализовать CRUD для Project, Task, Person и Milestone.
- [ ] Реализовать archive, unarchive и physical delete.
- [ ] Реализовать optimistic concurrency через blob SHA.
- [ ] Реализовать атомарную запись файлов.
- [ ] Реализовать model cache in memory и полную перезагрузку при ошибке.
- [ ] Реализовать format, validate, status и semantic diff endpoints.
- [ ] Добавить Server-Sent Events для draft state changes.

### Результаты этапа

- [ ] HTTP API без frontend.
- [ ] OpenAPI specification.
- [ ] CLI-клиент или test client полного workflow.
- [ ] Структурированные error responses.

### Автоматическая верификация

- [ ] Каждый write endpoint требует draft и expected revision.
- [ ] Ошибка validation не оставляет частично записанный файл.
- [ ] Delete блокируется при активных ссылках в режиме restrict.
- [ ] После внешнего изменения YAML сервер обнаруживает новую blob SHA.
- [ ] После restart draft остается доступен.

### Тесты этапа

- [ ] API contract tests.
- [ ] Integration tests create/update/archive/delete/restore через API и Git.
- [ ] Concurrency test двух PATCH с одинаковой blob SHA.
- [ ] Fault test write failure и disk permission error.
- [ ] E2E-API test от create draft до local commit.

### Ручная приемка

- [ ] Выполнить полный сценарий curl-командами.
- [ ] Открыть измененные YAML обычным Git-клиентом и проверить diff.

### Критерии выхода

- [ ] Workflow draft -> edit -> validate -> commit работает без frontend.
- [ ] OpenAPI соответствует фактическим ответам.
- [ ] Все destructive operations имеют preview или dependency report.

### Доказательства для файла прогресса

- Commit SHA реализации этапа.
- Точные команды автоматической проверки.
- Ссылка или ID успешного pipeline.
- Перечень выполненных E2E-сценариев.
- Результат ручной приемки.
- Известные ограничения и открытые дефекты.

## P05. Git changes API и восстановление средствами Git

Статус при создании плана: `not_started`
Зависимости: P03-P04.

### Цель

Сделать серверные операции просмотра и выборочного отката Git diff без отдельного Undo.

### Работы

- [ ] Реализовать парсер unified diff и hunk model.
- [ ] Реализовать restore whole file.
- [ ] Реализовать restore deleted file.
- [ ] Реализовать restore hunk reverse patch.
- [ ] Реализовать restore selected lines с предварительным patch check.
- [ ] Реализовать просмотр файла из commit.
- [ ] Реализовать commit history и file history endpoints.
- [ ] После каждого partial restore запускать parse и validation затронутой сущности.

### Результаты этапа

- [ ] Git diff API.
- [ ] Restore API.
- [ ] History API.
- [ ] Набор fixtures сложных diff.

### Автоматическая верификация

- [ ] Restore file приводит файл к состоянию HEAD.
- [ ] Restore deleted file возвращает точное содержимое HEAD.
- [ ] Restore hunk не затрагивает соседний hunk.
- [ ] Stale diff отклоняется по blob SHA.
- [ ] Невалидный после line restore YAML не записывается или явно блокирует commit.

### Тесты этапа

- [ ] Integration tests added, modified, deleted, renamed и binary statuses.
- [ ] Tests CRLF/LF и Unicode текста.
- [ ] Property tests apply patch + reverse patch.
- [ ] Regression tests overlapping hunks.

### Ручная приемка

- [ ] Сравнить результат restore с GitExtensions или `git diff`.
- [ ] Удалить задачу и восстановить ее только через API.

### Критерии выхода

- [ ] Пользователь может исправить ошибочные незакоммиченные изменения без терминала.
- [ ] Ни одна restore-операция не использует внутренний журнал приложения.

### Доказательства для файла прогресса

- Commit SHA реализации этапа.
- Точные команды автоматической проверки.
- Ссылка или ID успешного pipeline.
- Перечень выполненных E2E-сценариев.
- Результат ручной приемки.
- Известные ограничения и открытые дефекты.

## P06. GitLab OIDC, push и Merge Request

Статус при создании плана: `not_started`
Зависимости: P03-P05.

### Цель

Связать локальный draft workflow с существующим self-hosted GitLab и сохранить авторство пользователя.

### Работы

- [ ] Реализовать OIDC login с PKCE, state и nonce.
- [ ] Реализовать encrypted token storage.
- [ ] Проверять GitLab project membership и permissions.
- [ ] Настроить push от имени пользователя без token в process args и logs.
- [ ] Реализовать создание и чтение Merge Request.
- [ ] Генерировать MR description из semantic diff и validation report.
- [ ] Реализовать webhook verification и обработку MR, push и pipeline events.
- [ ] Синхронизировать draft state с GitLab.
- [ ] Документировать protected branch settings.

### Результаты этапа

- [ ] GitLab auth module.
- [ ] GitLab API client.
- [ ] Webhook endpoint.
- [ ] Административная инструкция настройки OAuth app и protected main.

### Автоматическая верификация

- [ ] Commit author и MR author соответствуют вошедшему пользователю.
- [ ] Token отсутствует в logs, remote URL и process list.
- [ ] Недоступность GitLab не уничтожает локальный draft.
- [ ] Повтор webhook idempotent.
- [ ] Push в protected main невозможен через приложение.

### Тесты этапа

- [ ] Contract tests GitLab API mock.
- [ ] Integration test с отдельным GitLab test project, если доступен.
- [ ] Security tests OAuth state, CSRF, token redaction и webhook secret.
- [ ] E2E scenario commit -> push -> draft MR -> pipeline status.

### Ручная приемка

- [ ] Войти двумя GitLab пользователями с разными правами.
- [ ] Проверить, что readonly пользователь не может push или create MR.
- [ ] Проверить MR и diff непосредственно в GitLab.

### Критерии выхода

- [ ] Полный server-side workflow до MR работает без frontend.
- [ ] Права не дублируются небезопасно поверх GitLab.
- [ ] Webhook корректно обновляет локальное состояние.

### Доказательства для файла прогресса

- Commit SHA реализации этапа.
- Точные команды автоматической проверки.
- Ссылка или ID успешного pipeline.
- Перечень выполненных E2E-сценариев.
- Результат ручной приемки.
- Известные ограничения и открытые дефекты.

## P07. Frontend shell и управление draft

Статус при создании плана: `not_started`
Зависимости: P04-P06.

### Цель

Создать пригодный к ежедневному использованию каркас интерфейса с постоянной видимостью Git-состояния.

### Работы

- [ ] Реализовать login, logout и session restore.
- [ ] Реализовать выбор repository и draft.
- [ ] Реализовать создание, переключение и удаление draft.
- [ ] Добавить верхнюю Git status bar.
- [ ] Показывать base branch, ahead/behind, dirty, validation, push и MR status.
- [ ] Реализовать routing и базовый responsive layout.
- [ ] Реализовать единый error boundary и notifications.
- [ ] Подключить SSE updates.

### Результаты этапа

- [ ] React application shell.
- [ ] Draft selector.
- [ ] Git status bar.
- [ ] Основная навигация.

### Автоматическая верификация

- [ ] Нельзя редактировать данные без выбранного draft.
- [ ] После refresh сохраняется текущий draft.
- [ ] Статус меняется после внешнего commit или webhook.
- [ ] Все ошибки имеют correlation ID и понятный текст.

### Тесты этапа

- [ ] Component tests shell и state transitions.
- [ ] Playwright login mock, create draft, switch draft, delete clean draft.
- [ ] Accessibility smoke checks keyboard navigation и landmarks.

### Ручная приемка

- [ ] Открыть два draft в двух вкладках и проверить отсутствие смешивания состояния.
- [ ] Проверить интерфейс при временном отключении server.

### Критерии выхода

- [ ] Пользователь всегда понимает, где и в какой ветке он работает.
- [ ] Нет скрытого редактирования main.

### Доказательства для файла прогресса

- Commit SHA реализации этапа.
- Точные команды автоматической проверки.
- Ссылка или ID успешного pipeline.
- Перечень выполненных E2E-сценариев.
- Результат ручной приемки.
- Известные ограничения и открытые дефекты.

## P08. Projects, Tasks, People и базовое редактирование

Статус при создании плана: `not_started`
Зависимости: P07.

### Цель

Реализовать основную предметную работу без прямого редактирования YAML.

### Работы

- [ ] Реализовать Portfolio и Project screens.
- [ ] Реализовать виртуализированный Task list.
- [ ] Реализовать Task details panel.
- [ ] Реализовать create, update, archive, unarchive и delete.
- [ ] Реализовать people и milestone selectors.
- [ ] Реализовать parent и dependency selection.
- [ ] Реализовать bulk update ограниченного набора полей.
- [ ] Показывать validation issues рядом с полями.
- [ ] Добавить raw YAML view только для просмотра и экспертного режима.

### Результаты этапа

- [ ] Полный CRUD UI основных сущностей.
- [ ] Фильтры, сортировка и группировка задач.
- [ ] Delete dependency dialog.
- [ ] Archive views.

### Автоматическая верификация

- [ ] Каждое UI-изменение локализовано в ожидаемом YAML-файле.
- [ ] Delete и Archive визуально и семантически различаются.
- [ ] Нельзя выбрать несуществующую ссылку.
- [ ] Stale edit приводит к conflict dialog, а не silent overwrite.

### Тесты этапа

- [ ] Component tests форм и selectors.
- [ ] Playwright create/update/archive/delete task.
- [ ] Playwright stale edit в двух вкладках.
- [ ] Playwright blocked delete при child/dependency.

### Ручная приемка

- [ ] Создать 20 задач через UI и проверить читаемость Git diff.
- [ ] Удалить задачу, открыть Changes и восстановить файл.

### Критерии выхода

- [ ] Основная работа с задачами не требует терминала.
- [ ] Все изменения доступны стандартному Git сразу после сохранения.

### Доказательства для файла прогресса

- Commit SHA реализации этапа.
- Точные команды автоматической проверки.
- Ссылка или ID успешного pipeline.
- Перечень выполненных E2E-сценариев.
- Результат ручной приемки.
- Известные ограничения и открытые дефекты.

## P09. Changes UI, semantic diff, commit и push

Статус при создании плана: `not_started`
Зависимости: P05, P07-P08.

### Цель

Сделать Git центральной видимой частью продукта, а не скрытой технической деталью.

### Работы

- [ ] Реализовать дерево Added, Modified, Deleted, Renamed и Conflicted.
- [ ] Реализовать unified и side-by-side diff через Monaco.
- [ ] Реализовать semantic diff по сущностям и агрегатам.
- [ ] Реализовать restore file, deleted file, hunk и lines.
- [ ] Реализовать format и validate actions.
- [ ] Реализовать commit dialog с preview.
- [ ] Реализовать push и create MR actions.
- [ ] Показывать pipeline и MR status.
- [ ] Добавить destructive summary перед commit, если есть delete.

### Результаты этапа

- [ ] Changes screen.
- [ ] Semantic diff screen.
- [ ] Commit, push и MR UI.
- [ ] Restore UI уровня GitExtensions.

### Автоматическая верификация

- [ ] UI diff соответствует `git diff --no-ext-diff`.
- [ ] Semantic counts соответствуют реальным файлам.
- [ ] Commit запрещен при validation errors.
- [ ] После commit рабочее дерево clean.
- [ ] После push MR содержит тот же commit SHA.

### Тесты этапа

- [ ] Playwright полный happy path от edit до MR.
- [ ] Playwright restore file, hunk и deleted file.
- [ ] Visual regression tests diff UI.
- [ ] E2E массовое удаление с явным summary.
- [ ] E2E validation failure блокирует commit.

### Ручная приемка

- [ ] Сравнить файл и semantic diff с GitLab MR.
- [ ] Исправить специально внесенную ошибку только через Changes UI.

### Критерии выхода

- [ ] Первый полезный vertical slice завершен.
- [ ] Пользователь может пройти UI -> YAML -> diff -> commit -> push -> MR без терминала.

### Доказательства для файла прогресса

- Commit SHA реализации этапа.
- Точные команды автоматической проверки.
- Ссылка или ID успешного pipeline.
- Перечень выполненных E2E-сценариев.
- Результат ручной приемки.
- Известные ограничения и открытые дефекты.

## P10. История, revert и разрешение конфликтов

Статус при создании плана: `not_started`
Зависимости: P03, P09.

### Цель

Дать пользователю безопасный интерфейс для истории Git и конфликтов без собственного механизма Undo.

### Работы

- [ ] Реализовать commit graph и commit details.
- [ ] Реализовать compare commits и file history.
- [ ] Реализовать restore file from commit.
- [ ] Реализовать create revert draft.
- [ ] Реализовать rebase from main.
- [ ] Реализовать three-way conflict UI для YAML.
- [ ] Реализовать choose ours/theirs и ручное разрешение.
- [ ] Реализовать continue и abort rebase.

### Результаты этапа

- [ ] History screen.
- [ ] Revert workflow.
- [ ] Conflict resolution screen.
- [ ] Документация восстановления после ошибочного merge.

### Автоматическая верификация

- [ ] Revert создает новый commit, не переписывая историю main.
- [ ] Abort rebase полностью возвращает исходное состояние ветки.
- [ ] Conflict resolution требует успешной validation до continue.
- [ ] Commit graph отображает реальную topology Git.

### Тесты этапа

- [ ] E2E ошибочный commit -> merge -> revert draft -> revert MR.
- [ ] E2E конфликт одного YAML-файла.
- [ ] E2E конфликт delete/modify.
- [ ] Integration test abort/continue после restart server.

### Ручная приемка

- [ ] Сверить граф с `git log --graph --all`.
- [ ] Разрешить конфликт пользователем, не знающим Git-команд.

### Критерии выхода

- [ ] Все обязательные сценарии восстановления доступны из UI.
- [ ] Нет force push или переписывания shared history по умолчанию.

### Доказательства для файла прогресса

- Commit SHA реализации этапа.
- Точные команды автоматической проверки.
- Ссылка или ID успешного pipeline.
- Перечень выполненных E2E-сценариев.
- Результат ручной приемки.
- Известные ограничения и открытые дефекты.

## P11. Board, Gantt и Workload

Статус при создании плана: `not_started`
Зависимости: P08-P09.

### Цель

Добавить современные рабочие представления поверх тех же файлов без создания второго источника истины.

### Работы

- [ ] Реализовать Kanban board с drag-and-drop статусов.
- [ ] Реализовать swimlanes и сохраненные filters.
- [ ] Реализовать Gantt с задачами, milestones и dependencies.
- [ ] Реализовать изменение start/due через drag.
- [ ] Реализовать weekly workload по estimate_hours и capacity.
- [ ] Учесть рабочие календари и исключения.
- [ ] Добавить overload warnings в semantic diff.
- [ ] Определить поведение задач без start/due.

### Результаты этапа

- [ ] Board.
- [ ] Gantt.
- [ ] Workload.
- [ ] Общие сохраненные views из YAML-конфигурации.

### Автоматическая верификация

- [ ] Drag на Board меняет только status.
- [ ] Drag на Gantt меняет ожидаемые даты.
- [ ] Workload детерминированно пересчитывается из файлов.
- [ ] Ни одно представление не хранит бизнес-состояние в браузере как единственную копию.

### Тесты этапа

- [ ] Playwright board drag.
- [ ] Playwright gantt date change.
- [ ] Unit tests распределения загрузки и календарей.
- [ ] Visual regression основных представлений.
- [ ] Performance test 10 000 задач.

### Ручная приемка

- [ ] Сверить workload нескольких людей ручным расчетом.
- [ ] Сделать изменение в Gantt и проверить Git diff.

### Критерии выхода

- [ ] Все представления являются чистыми проекциями YAML-модели.
- [ ] Производительность соответствует целевому масштабу.

### Доказательства для файла прогресса

- Commit SHA реализации этапа.
- Точные команды автоматической проверки.
- Ссылка или ID успешного pipeline.
- Перечень выполненных E2E-сценариев.
- Результат ручной приемки.
- Известные ограничения и открытые дефекты.

## P12. MCP и безопасная работа агентов

Статус при создании плана: `not_started`
Зависимости: P02, P04, P06, P09.

### Цель

Подключить агентов к тому же draft workflow с ограничениями области и операций.

### Работы

- [ ] Реализовать MCP server и authentication.
- [ ] Реализовать tools чтения portfolio, project, task и person.
- [ ] Реализовать draft_create, validate, diff, commit, push и create MR.
- [ ] Реализовать task bulk create/update/delete.
- [ ] Привязать policy к agent identity и draft.
- [ ] Возвращать структурированные validation errors.
- [ ] Добавить команду получения semantic diff перед commit.
- [ ] Создать reference prompt и примеры agent workflow.
- [ ] Добавить direct file mode как отдельный явно включаемый режим.

### Результаты этапа

- [ ] MCP server.
- [ ] Agent policy configuration.
- [ ] Набор безопасных domain tools.
- [ ] Примеры интеграции с агентами.

### Автоматическая верификация

- [ ] Агент не может изменить проект вне scope.
- [ ] Delete доступен только при явном разрешении.
- [ ] Агент не может push при validation errors.
- [ ] Каждый agent commit имеет actor trailer.
- [ ] Агент может прочитать собственный diff и MR URL.

### Тесты этапа

- [ ] E2E агент создает задачи только в одном проекте.
- [ ] E2E агент пытается удалить одноименные этапы разных проектов и получает отказ scope.
- [ ] E2E trusted agent удаляет разрешенную задачу и создает MR.
- [ ] Contract tests MCP tool schemas.
- [ ] Prompt regression scenarios на неправильные ID.

### Ручная приемка

- [ ] Передать агенту реальное ТЗ и проверить качество декомпозиции отдельно от безопасности.
- [ ] Проверить MR агента человеком в GitLab.

### Критерии выхода

- [ ] Агент не имеет пути записи в main в обход MR.
- [ ] Повтор исходной аварии OpenProject блокируется технически, а не инструкцией в prompt.

### Доказательства для файла прогресса

- Commit SHA реализации этапа.
- Точные команды автоматической проверки.
- Ссылка или ID успешного pipeline.
- Перечень выполненных E2E-сценариев.
- Результат ручной приемки.
- Известные ограничения и открытые дефекты.

## P13. Надежность, безопасность и эксплуатация

Статус при создании плана: `not_started`
Зависимости: P00-P12.

### Цель

Подготовить систему к постоянной эксплуатации на общем сервере.

### Работы

- [ ] Провести threat modeling.
- [ ] Закрыть path traversal, symlink и command injection.
- [ ] Добавить limits размера YAML, глубины и числа сущностей.
- [ ] Добавить structured logs, metrics и health checks.
- [ ] Реализовать cleanup завершенных worktree.
- [ ] Проверить restart recovery и corrupted metadata recovery.
- [ ] Добавить backup procedure для незапушенных worktree.
- [ ] Добавить upgrade и schema migration procedure.
- [ ] Провести dependency vulnerability scan.
- [ ] Добавить rate limits для дорогих Git-операций.

### Результаты этапа

- [ ] Threat model.
- [ ] Production Docker image.
- [ ] Runbook эксплуатации и аварийного восстановления.
- [ ] Metrics dashboard specification.
- [ ] Security test suite.

### Автоматическая верификация

- [ ] Server запускается непривилегированным пользователем.
- [ ] Secrets не выводятся в logs.
- [ ] После hard kill незапушенный worktree остается восстанавливаемым.
- [ ] Cleanup не удаляет active или unmerged draft.
- [ ] Миграция формата имеет dry-run.

### Тесты этапа

- [ ] Fault injection disk full, permission denied, GitLab timeout и process kill.
- [ ] Security tests OWASP baseline.
- [ ] Load test целевого числа пользователей и draft.
- [ ] Soak test продолжительностью не менее 8 часов.
- [ ] Backup and restore rehearsal.

### Ручная приемка

- [ ] Развернуть staging с конфигурацией, близкой к production.
- [ ] Провести восстановление сервера по runbook человеком, не писавшим код.

### Критерии выхода

- [ ] Нет открытых critical/high security findings.
- [ ] Runbook проверен на staging.
- [ ] Целевые SLO и ограничения задокументированы.

### Доказательства для файла прогресса

- Commit SHA реализации этапа.
- Точные команды автоматической проверки.
- Ссылка или ID успешного pipeline.
- Перечень выполненных E2E-сценариев.
- Результат ручной приемки.
- Известные ограничения и открытые дефекты.

## P14. Release candidate и приемка v0.1

Статус при создании плана: `not_started`
Зависимости: P00-P13.

### Цель

Подтвердить сквозную готовность продукта на реальном портфеле и выпустить воспроизводимый release.

### Работы

- [ ] Заморозить feature scope.
- [ ] Выполнить миграцию копии реального портфеля.
- [ ] Запустить полный regression suite.
- [ ] Запустить полный E2E suite в GitLab staging.
- [ ] Провести пользовательскую приемку минимум двумя ролями.
- [ ] Провести agent acceptance scenario.
- [ ] Исправить release blockers.
- [ ] Создать signed tag и release notes.
- [ ] Собрать Docker image по tag.
- [ ] Обновить документацию установки, обновления и отката.

### Результаты этапа

- [ ] Release candidate.
- [ ] Acceptance report.
- [ ] Полный E2E report.
- [ ] Signed Git tag.
- [ ] Production image и checksum.

### Автоматическая верификация

- [ ] Все mandatory E2E scenarios зеленые.
- [ ] Нет blocker/critical defects.
- [ ] Все schema migrations имеют backup и rollback plan.
- [ ] Release собирается из clean clone.
- [ ] Документация соответствует фактическому UI и API.

### Тесты этапа

- [ ] Полный unit, integration, contract, E2E, security и performance suite.
- [ ] Upgrade test с предыдущего допустимого формата.
- [ ] Rollback test release deployment.
- [ ] User acceptance tests.

### Ручная приемка

- [ ] Провести рабочий день на staging с реальными пользователями.
- [ ] Создать, удалить, восстановить и merge задачи реального проекта.
- [ ] Проверить MR агента и выполнить revert после merge.

### Критерии выхода

- [ ] Владелец продукта подписал acceptance report.
- [ ] Release tag опубликован.
- [ ] Файл прогресса переведен в состояние released.

### Доказательства для файла прогресса

- Commit SHA реализации этапа.
- Точные команды автоматической проверки.
- Ссылка или ID успешного pipeline.
- Перечень выполненных E2E-сценариев.
- Результат ручной приемки.
- Известные ограничения и открытые дефекты.

## 9. Release gates

### Alpha gate

Достигается после P09.

Обязательные свойства:

- пользовательский vertical slice работает от UI до GitLab MR;
- доступны create, update, archive, delete и restore;
- validation блокирует некорректный commit;
- интерфейс Changes пригоден для проверки действий агента;
- E2E-001 - E2E-013 и E2E-016 проходят.

### Beta gate

Достигается после P12.

Обязательные свойства:

- History, revert и conflict resolution работают;
- Board, Gantt и Workload доступны;
- агент работает через scoped draft;
- E2E-001 - E2E-028 проходят, кроме явно отложенных необязательных performance cases.

### Release candidate gate

Достигается после P13.

Обязательные свойства:

- security и fault suites проходят;
- staging recovery проверен;
- runbook готов;
- нет critical/high findings;
- E2E-029 и E2E-030 проходят.

### Release v0.1 gate

Достигается после P14.

Обязательные свойства:

- полный mandatory suite зеленый;
- release собран из clean clone;
- signed tag и checksum опубликованы;
- acceptance report подписан;
- rollback процедуры проверены.

## 10. Формат отчета о прогрессе

После каждого существенного рабочего захода в `docs/PROGRESS.md` добавляется запись:

```markdown
## YYYY-MM-DD HH:MM - <краткое название>

Статус этапа: Pxx / in_progress|verification|done|blocked

Выполнено:

- ...

Измененные файлы:

- ...

Commit:

- `<sha>` `<message>`

Проверки:

- `command` - passed/failed, краткий результат

E2E:

- E2E-xxx - passed/failed/not_run

Известные проблемы:

- ...

Следующий шаг:

- ...
```

Нельзя писать только процент. Процент без перечисления завершенных критериев не является доказательством прогресса.

## 11. Правило изменения плана

Если в ходе реализации меняется этап, критерий или архитектура:

1. изменить версионируемый документ;
2. объяснить причину в commit message или ADR;
3. обновить зависимости последующих этапов;
4. не отмечать старый критерий выполненным задним числом;
5. при обновлении файла с версией увеличить версию имени файла.
