# GitPM: инструкция по поддержке планов и evidence

Версия документа: 0.3  
Статус: обязательная рабочая инструкция

## 1. Назначение файлов

- `GitPM_Implementation_Plan_v0.7.md`: что строится и какие решения нормативны.
- `GitPM_Work_Plan_v0.8.md`: в каком порядке выполняется работа, как поддерживается ритм коммитов и как принимается stage.
- `GitPM_Requirements_Traceability_v0.5.yaml`: machine-readable DAG, requirements, verification checks and gates.
- `GitPM_Execution_Status_v0.1.yaml`: единственный machine-readable источник фактического выполнения.
- `GitPM_Repository_Format_v1.md` и `schemas/v1/`: утвержденный repository/schema contract.
- `PROGRESS.md`: краткий человеческий журнал решений, blockers and next action.
- Delivery Policies and Security Baseline: cross-cutting constraints.

## 2. Что обновлять при изменении архитектуры

1. Создать новую версию Implementation Plan.
2. Исправить Work Plan stages and acceptance.
3. Исправить registry requirements, checks and gates.
4. Обновить Delivery Policies or Security Baseline, если затронута их область.
5. Обновить `documents` references в registry и validator.
6. Синхронизировать Execution Status: добавить новые IDs со status `not_started`/`pending`, удалить IDs только после reviewed migration status file.
7. Обновить README and PROGRESS.
8. Запустить validators and mutation self-tests.
9. Сделать один architecture commit и отдельный evidence commit.

## 3. Что обновлять при реализации stage

Перед началом:

```bash
python3 scripts/update_execution_status.py stage P03 in_progress
```

Во время реализации делать независимо проверяемые commits не реже чем после каждого завершенного work package и перед плановой паузой или передачей работы. Stage evidence хранит только артефакты acceptance; Git history отдельно показывает историю изменений.

Во время работы evidence хранится в стабильном URL или repository path, например:

```text
evidence/P03/2026-07-10/ci.txt
evidence/P03/2026-07-10/restart-report.md
```

После выполнения checks:

- установить check status `passed`;
- добавить хотя бы один evidence reference;
- установить stage status `done`;
- заполнить stage evidence и, если stage объявляет acceptance roles, `accepted_by`;
- обновить `PROGRESS.md` одним кратким блоком.

## 4. Gate commands

```bash
python3 scripts/validate_planning.py
python3 scripts/test_planning_validator.py
python3 scripts/test_release_gate.py
python3 scripts/check_release_gate.py --gate alpha
python3 scripts/check_release_gate.py --gate beta
python3 scripts/check_release_gate.py --gate release_candidate
python3 scripts/check_release_gate.py --gate release
```

Planning validator подтверждает согласованность плана. Gate checker подтверждает фактическое выполнение. Зеленый planning validator не означает completed milestone.

## 5. Добавление requirement

Requirement обязан иметь:

- unique ID;
- exact existing Implementation Plan heading in `source.section`;
- one owner and one stage;
- observable acceptance criteria;
- direct verification checks.

Umbrella requirement не должен использоваться как формальное покрытие всех checks.

## 6. Добавление verification check

Check обязан иметь:

- contiguous `VFY-NNN` ID;
- stage;
- mandatory milestone;
- test_type;
- environment;
- actor;
- concrete preconditions, steps, expected result and evidence;
- direct requirement links.

Check должен быть указан в Owned verification checks своего stage.

## 7. Изменение DAG

- менять dependencies только в registry;
- Work Plan metadata должен совпасть с registry;
- не добавлять ручное поле parallelism;
- после изменения просмотреть computed critical path validator output;
- не создавать stage, который нужен для прохождения gate, самого предшествующего этому stage.

## 8. Версионирование

Версия повышается у каждого измененного нормативного документа. `PROGRESS.md` и Execution Status сохраняют стабильное имя, поскольку это live state.

Старые активные версии удаляются из рабочего дерева и остаются в Git history.

## 9. PROGRESS.md

PROGRESS хранит только:

- current planning/implementation phase;
- last accepted revision and commit;
- decisions and rejected alternatives;
- current blockers;
- next action.

Он не дублирует все stage/check statuses.

## 10. Review checklist

- Project path and identity rules consistent?
- Schema baseline complete before parser stage?
- Git sync and draft lifecycle unambiguous?
- One writer rule preserved?
- OAuth terminology and credential path exact?
- No webhook, rebase, quota, backup or MCP reintroduced?
- Source sections exist exactly?
- Stage metadata matches registry?
- Execution status contains exact IDs?
- Gate checker fails on pending evidence?
- Russian locale complete and `VFY-032` synchronized with mandatory UI surfaces?


## 11. Поддержка локализации

При добавлении или изменении user-facing сообщения:

1. Добавить или изменить key в source locale `en`.
2. В том же commit обновить обязательный `ru` locale.
3. Не добавлять raw HTML; dynamic values передавать placeholders.
4. Для чисел, дат и plural forms использовать locale-aware formatter, а не собирать строку вручную.
5. Запустить key/placeholder parity check и browser smoke для `ru`.
6. При добавлении locale зарегистрировать language tag, display name и direction.
7. Не переводить API codes, JSON field names и repository content.

Release не допускается, если `ru` использует fallback, содержит missing key или не прошел `VFY-032`. При изменении состава обязательных экранов обновляются шаги и evidence `VFY-032`, а не создается параллельный неучтенный checklist.
