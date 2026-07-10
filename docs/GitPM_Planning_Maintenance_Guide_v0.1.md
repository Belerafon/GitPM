# GitPM: инструкция по поддержке планов и прогресса

Версия документа: 0.1  
Статус: обязательная рабочая инструкция

## 1. Назначение файлов

- `GitPM_Implementation_Plan_v*.md`: что строится и какие архитектурные решения действуют.
- `GitPM_Work_Plan_v*.md`: в каком порядке выполняются stages и как принимается каждый stage.
- `GitPM_Requirements_Traceability_v*.yaml`: машинный DAG, требования, E2E и release gates.
- `GitPM_Delivery_Policies_v*.md`: короткие продуктовые и эксплуатационные границы.
- `GitPM_Security_Baseline_v*.md`: обязательные security controls.
- `PROGRESS.md`: только фактическое состояние, evidence, blockers и следующий проверяемый шаг.

## 1.1. Текущий активный набор

- `GitPM_Implementation_Plan_v0.5.md`;
- `GitPM_Work_Plan_v0.4.md`;
- `GitPM_Requirements_Traceability_v0.3.yaml`;
- `GitPM_Delivery_Policies_v0.3.md`;
- `GitPM_Security_Baseline_v0.3.md`;
- `PROGRESS.md`.

Этот список обновляется при каждой planning revision вместе с README, registry и validator.

## 2. Единственный активный набор

В рабочем дереве хранится ровно одна активная версия каждого versioned planning document. Предыдущая версия удаляется из working tree и остается в Git history.

При изменении versioned файла его имя обязательно получает следующую версию. Нельзя изменять содержимое `v0.5` и оставлять прежнее имя.

## 3. Когда требуется planning revision

Новая revision обязательна, если меняются:

- scope v0.1;
- архитектурное решение;
- stage или dependency;
- milestone;
- requirement acceptance criteria;
- E2E scenario;
- release gate;
- security или delivery policy.

Исправление орфографии без изменения смысла может быть отдельным docs commit без полной revision, если validator references не меняются.

## 4. Порядок изменения

1. Сформулировать решение и product boundary.
2. Обновить Implementation Plan с увеличением версии.
3. Обновить Delivery Policies или Security Baseline с увеличением версии, если они затронуты.
4. Обновить Work Plan с увеличением версии.
5. Обновить Traceability YAML с увеличением версии:
   - document pointers;
   - stages;
   - requirements;
   - E2E;
   - exact release gates.
6. Обновить `README.md` и references.
7. Обновить `PROGRESS.md`:
   - новая planning decision;
   - фактические validation results;
   - commit SHA после первого planning commit;
   - next verifiable action.
8. Обновить `scripts/validate_planning.py` и mutation tests, если структура registry изменилась.
9. Выполнить verification commands.
10. Сделать planning commit.
11. Внести commit SHA и evidence в `PROGRESS.md` отдельным evidence commit.

## 5. Verification commands

```bash
python3 scripts/validate_planning.py
python3 scripts/test_planning_validator.py
python3 -m py_compile scripts/validate_planning.py scripts/test_planning_validator.py
git diff --check
git status --short
```

Все команды, кроме последней до commit, должны завершиться успешно. После evidence commit working tree должен быть clean.

## 6. Как добавлять stage

- Stage получает уникальный ID, одного Accountable, Responsible, Acceptance, size, estimate и formal dependencies.
- Dependency существует в registry и не создает cycle.
- Work Plan содержит ровно один heading `## <ID>. <title>`.
- Stage имеет objective, work packages, artifacts, automated verification, manual acceptance, owned E2E и exit gate.
- Release gate получает stage автоматически по milestone; exact list хранится явно и проверяется validator.

## 7. Как менять requirement

Requirement содержит:

- уникальный ID;
- описание;
- source document и section;
- owner;
- owning stage;
- release gate;
- непустые acceptance criteria;
- прямые links на E2E.

Каждый linked E2E обязан ссылаться обратно. Нельзя покрывать все функции одним зонтичным requirement.

## 8. Как менять E2E

E2E содержит:

- stage owner;
- mandatory milestone;
- environment;
- actor;
- preconditions;
- последовательные steps;
- expected result;
- evidence artifacts;
- functional requirements.

Название сценария без fixture и expected result не считается спецификацией.

## 9. Как закрывать stage

Accountable обновляет `PROGRESS.md` только после получения evidence:

- commit SHA;
- automated test commands и результаты;
- manual acceptance result;
- ссылки/пути на artifacts;
- unresolved risks;
- exact next action.

Статус `done` запрещен при failed mandatory test или отсутствующем acceptance.

## 10. Еженедельная гигиена

Перед началом нового stage и перед release gate:

- проверить, что active documents совпадают с README и registry;
- проверить, что `PROGRESS.md` не дублирует статические checklist;
- удалить устаревшие blockers;
- убедиться, что next action проверяем и относится к current stage;
- запустить planning validator;
- проверить `git log` и clean working tree.

## 11. Что не надо поддерживать

Не создаются отдельные spreadsheet, issue tracker или второй список stages вне repository. Если для работы используется GitLab Issue, он ссылается на stage/requirement ID, но не заменяет Work Plan и registry.
