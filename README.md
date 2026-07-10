# GitPM

Git-first система управления проектами и задачами с веб-интерфейсом, GitLab Merge Request workflow и поддержкой агентов.

## Текущий статус

Репозиторий находится на стадии `planning_ready`. Программная реализация еще не начата. План переработан после инженерного review: ранняя безопасность, миграции, сохранность dirty draft, real GitLab gate, измеримые performance budgets и трассировка требований теперь являются обязательными до соответствующих этапов.

## Актуальные документы

- `docs/GitPM_Implementation_Plan_v0.3.md` - архитектура, формат данных, API и продуктовые решения;
- `docs/GitPM_Work_Plan_v0.2.md` - единственный исполнимый план этапов, владельцев, размеров и проверок;
- `docs/GitPM_Delivery_Policies_v0.1.md` - scope v0.1, права, квоты, RPO/RTO и performance budgets;
- `docs/GitPM_Security_Baseline_v0.1.md` - ранняя модель угроз, key lifecycle и обязательные контрмеры;
- `docs/GitPM_Requirements_Traceability_v0.1.yaml` - связь требований, этапов и E2E;
- `docs/PROGRESS.md` - живой журнал evidence, блокировок, решений и следующего действия.

Старые версии планов доступны в Git history, но не остаются активными файлами в рабочем дереве.

## Проверка планирования

```bash
python3 scripts/validate_planning.py
```

Проверка подтверждает:

- наличие актуальных документов;
- отсутствие одновременно активных устаревших планов;
- уникальность 18 stage IDs;
- наличие 45 E2E scenarios;
- корректность ссылок traceability registry;
- покрытие каждого E2E хотя бы одним requirement.

## Как вести работу

1. Открыть текущий stage в `docs/PROGRESS.md`.
2. Выполнять entry criteria, work packages и проверки соответствующего раздела Work Plan.
3. Записать commit SHA, pipeline/report, E2E IDs и manual acceptance в PROGRESS.
4. Переводить stage в `done` только после exit gate.
5. Изменения sequence/scope оформлять новой версией Work Plan; архитектурные решения - новой версией Implementation Plan или ADR.

## Основные принципы

- Git является источником истины.
- Каждая сущность хранится в отдельном YAML-файле.
- Пользователи и агенты работают в отдельных ветках и Git worktree.
- Изменения проходят через commit, push и GitLab Merge Request.
- Архивирование и физическое удаление являются отдельными операциями.
- Восстановление и откат выполняются штатными средствами Git.
- Собственная база данных и отдельный механизм Undo в первой версии не используются.
- v0.1 обслуживает один configured portfolio repository.
- Security controls реализуются на ранних этапах, а не откладываются в hardening.
- Прогресс подтверждается тестами и evidence, а не процентом готовности.
