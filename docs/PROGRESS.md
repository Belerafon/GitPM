# GitPM progress

Актуально на 2026-07-22.

## Текущее состояние

Release baseline `v0.1_release_accepted` закрыт: P00–P14, Alpha, Beta, Release
Candidate и release gate приняты. Разработка после baseline продолжается; версия
пакетов остаётся `0.1.0` до отдельного решения о следующем release.

Подробный неизменяемый срез приёмки хранится в
`GitPM_Execution_Status_v0.1.yaml`, а связи stages/requirements/checks — в
`GitPM_Requirements_Traceability_v0.5.yaml`. Этот файл не дублирует их checklist.

## Изменения после принятого baseline

- `direct` стал режимом репозитория по умолчанию; `worktree` сохранил draft,
  writer-mode и Merge Request workflow;
- runtime metadata разделено по режимам, direct workspace восстанавливается и
  сверяется с каноническим managed checkout;
- CLI получил `init`, schema discovery, генерацию ID, транзакционные
  `entity create`, `entity update` и атомарный CSV/YAML/JSONL import;
- каждый managed checkout получает актуальные `AGENTS.md` и
  `.agents/skills/gitpm/SKILL.md`; runtime guidance исключено из business diff и commit;
- web UI перешёл на project-centric workspace с адресуемыми Project, Stage, Task,
  Board, Timeline, Person и History routes;
- улучшены иерархия project plan, ручное упорядочивание, optimistic updates,
  task editor, назначения исполнителей и перенос задач между проектами;
- добавлены профили людей и календарь доступности, комментарии к задачам,
  упоминания и уведомления;
- Changes/History показывают больше Git-контекста, включая per-file commit diff;
- добавлен защищённый read-only browser рабочего дерева;
- появились локальный Docker image и отдельный server deployment profile;
- удаление Person умеет после отдельного подтверждения атомарно отвязать
  поддерживаемые ссылки, включая упоминания в комментариях.

## Действующие документы

- `README.md` и `docs/README.md` — обзор и навигация;
- `docs/CLI.md` — публичный CLI/environment contract;
- `docs/Repository_Modes.md` — различия `direct`/`worktree`;
- `docs/GitPM_Agent_Workflow_v1.md` — CLI-only agent workflow;
- `docs/GitPM_Repository_Format_v1.md` и `schemas/v1` — schema/layout contract;
- `docs/GitPM_Implementation_Plan_v0.7.md` — архитектурный baseline с принятыми дополнениями;
- delivery/security документы и ADR — обязательные границы реализации.

`GitPM_Work_Plan_v0.8.md`, release traceability/status и глобальный UX/UI plan
остаются historical evidence принятого этапа. Они не должны трактоваться как
текущий backlog без явной новой planning revision.

## Ограничения

- один configured repository на server runtime;
- нет business database, backup/replication, migration или quota engine;
- нет force push, rebase API, встроенного conflict editor или автоматического merge;
- Gantt остаётся read-only, Workload — объяснимой приблизительной моделью;
- публичное размещение требует reverse proxy/TLS и отдельного deployment review;
- CLI агента пока не предоставляет отдельные archive/delete commands: такой gap
  нужно сообщать, а не обходить прямым редактированием YAML.

## Blockers и следующий шаг

Активных release blockers нет. Следующая продуктовая цель в репозитории пока не
зафиксирована отдельным актуальным work plan; новые крупные изменения должны
сначала получить scope, acceptance criteria и синхронизированные contracts.
