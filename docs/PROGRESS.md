# GitPM: прогресс реализации

Версия документа: 0.1
Связанный план работ: `GitPM_Work_Plan_v0.1.md`
Связанная архитектура: `GitPM_Implementation_Plan_v0.2.md`
Последнее обновление: 2026-07-10

## 1. Текущее состояние

Общий статус: `planning`
Текущий этап: `P00 - Bootstrap и воспроизводимое окружение`
Статус текущего этапа: `not_started`
Последний завершенный этап: отсутствует
Текущий release gate: до Alpha

Готовность по фактическим критериям:

- Архитектурная спецификация: готова.
- Исполнимый план работ: готов.
- Репозиторий разработки: инициализирован.
- Программная реализация: не начата.
- Автоматические тесты: не созданы.
- E2E-тесты: не созданы.
- Production readiness: не начата.

## 2. Следующий конкретный шаг

Начать P00:

- создать pnpm monorepo;
- зафиксировать версии Node.js, pnpm и Git;
- настроить lint, typecheck, test и build;
- создать минимальный GitLab CI pipeline;
- подтвердить clean installation.

## 3. Блокировки

Активных блокировок нет.

## 4. Решения, которые нужно принять до соответствующего этапа

- До P01: окончательно утвердить формат ULID и display key.
- До P06: создать GitLab OAuth application и test project.
- До P11: выбрать Gantt-библиотеку после отдельного технического прототипа.
- До P13: определить production reverse proxy и способ хранения encryption key.

## 5. Состояние этапов

### P00. Bootstrap и воспроизводимое окружение

Статус: `not_started`

- [ ] Monorepo создан.
- [ ] Локальная сборка воспроизводима.
- [ ] CI pipeline зеленый.
- [ ] Smoke tests проходят.
- [ ] Доказательства записаны.

### P01. Формат репозитория и доменная модель

Статус: `not_started`

- [ ] Схемы зафиксированы.
- [ ] Parser и formatter реализованы.
- [ ] Demo portfolio создан.
- [ ] Round-trip и idempotence tests проходят.
- [ ] Доказательства записаны.

### P02. Валидатор, линтер и семантическая целостность

Статус: `not_started`

- [ ] Validation engine реализован.
- [ ] CLI реализован.
- [ ] Policy validation реализован.
- [ ] Regression tests критичных ошибок проходят.
- [ ] Доказательства записаны.

### P03. Git core и управление worktree

Статус: `not_started`

- [ ] Worktree lifecycle реализован.
- [ ] Commit, push, rebase и revert реализованы.
- [ ] Recovery после restart проверен.
- [ ] Integration suite проходит.
- [ ] Доказательства записаны.

### P04. Backend draft API и файловые операции

Статус: `not_started`

- [ ] Draft API реализован.
- [ ] CRUD и delete/archive реализованы.
- [ ] Atomic write и optimistic concurrency реализованы.
- [ ] API E2E проходит.
- [ ] Доказательства записаны.

### P05. Git changes API и восстановление средствами Git

Статус: `not_started`

- [ ] Diff API реализован.
- [ ] Restore file, hunk и lines реализованы.
- [ ] History API реализован.
- [ ] Patch tests проходят.
- [ ] Доказательства записаны.

### P06. GitLab OIDC, push и Merge Request

Статус: `not_started`

- [ ] GitLab login реализован.
- [ ] Push от имени пользователя реализован.
- [ ] MR и webhook реализованы.
- [ ] Token secrecy проверена.
- [ ] Доказательства записаны.

### P07. Frontend shell и управление draft

Статус: `not_started`

- [ ] App shell реализован.
- [ ] Draft selector реализован.
- [ ] Git status bar реализован.
- [ ] Frontend smoke E2E проходит.
- [ ] Доказательства записаны.

### P08. Projects, Tasks, People и базовое редактирование

Статус: `not_started`

- [ ] Portfolio и Project screens реализованы.
- [ ] Task CRUD реализован.
- [ ] Archive и Delete различаются.
- [ ] Stale edit защищен.
- [ ] Доказательства записаны.

### P09. Changes UI, semantic diff, commit и push

Статус: `not_started`

- [ ] Changes screen реализован.
- [ ] Semantic diff реализован.
- [ ] Restore UI реализован.
- [ ] UI -> MR E2E проходит.
- [ ] Alpha gate подтвержден.

### P10. История, revert и разрешение конфликтов

Статус: `not_started`

- [ ] History реализована.
- [ ] Revert draft реализован.
- [ ] Conflict UI реализован.
- [ ] Rebase recovery E2E проходит.
- [ ] Доказательства записаны.

### P11. Board, Gantt и Workload

Статус: `not_started`

- [ ] Board реализован.
- [ ] Gantt реализован.
- [ ] Workload реализован.
- [ ] Представления подтверждены как проекции YAML.
- [ ] Доказательства записаны.

### P12. MCP и безопасная работа агентов

Статус: `not_started`

- [ ] MCP server реализован.
- [ ] Scoped policies реализованы.
- [ ] Agent MR workflow проходит.
- [ ] Cross-project deletion блокируется.
- [ ] Beta gate подтвержден.

### P13. Надежность, безопасность и эксплуатация

Статус: `not_started`

- [ ] Threat model завершен.
- [ ] Fault tests проходят.
- [ ] Security tests проходят.
- [ ] Recovery runbook проверен.
- [ ] Release candidate gate подтвержден.

### P14. Release candidate и приемка v0.1

Статус: `not_started`

- [ ] Full regression suite проходит.
- [ ] Full mandatory E2E suite проходит.
- [ ] Acceptance report подписан.
- [ ] Release tag и image опубликованы.
- [ ] Release v0.1 подтвержден.

## 6. Состояние обязательных E2E-сценариев

Все сценарии E2E-001 - E2E-030 имеют статус `not_implemented`.

После появления теста для каждого сценария здесь должна быть запись вида:

```text
E2E-005: passed
Run: <pipeline/job URL or local report path>
Commit: <sha>
Environment: <description>
```

## 7. Последние результаты проверок

Автоматические проверки программного кода еще не запускались, поскольку программная реализация не начата.

Проверки документации:

- структура Git-репозитория существует;
- архитектурный план находится под Git;
- план работ и файл прогресса подготовлены;
- новый commit должен содержать только документальные изменения.

## 8. Журнал прогресса

## 2026-07-10 - Инициализация проекта

Статус этапа: planning

Выполнено:

- создан Git-репозиторий;
- добавлена архитектурная спецификация;
- зафиксированы Git-first, worktree и GitLab MR принципы.

Commit:

- `c1cc756` `docs: initialize GitPM project and add implementation plan`

Проверки:

- `git status --short --branch` - passed, рабочее дерево было чистым после commit;
- ZIP с `.git` был создан и проверен распаковкой.

E2E:

- не запускались, программной реализации еще нет.

Известные проблемы:

- исходный план не содержал достаточно строгой этапности и quality gates.

Следующий шаг:

- добавить исполнимый план работ и этот журнал прогресса отдельным commit.

## 9. Шаблон следующего обновления

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
