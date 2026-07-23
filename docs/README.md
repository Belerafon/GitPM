# Документация GitPM

Этот каталог содержит одновременно текущие руководства, нормативный baseline
формата v1 и завершённые planning/evidence документы релиза v0.1. Версия в имени
файла обозначает версию контракта или исторического плана, а не версию npm-пакета.

## С чего начать

- [`../README.md`](../README.md) — возможности, быстрый запуск и карта исходников;
- [`CLI.md`](CLI.md) — команды, флаги, environment и deployment-сценарии;
- [`Deployment.md`](Deployment.md) — сборка образов, профили деплоя и механизм версии сборки;
- [`Repository_Modes.md`](Repository_Modes.md) — `direct` и `worktree`;
- [`GitPM_Agent_Workflow_v1.md`](GitPM_Agent_Workflow_v1.md) — CLI-only работа агента;
- [`runbooks/GitPM_Local_Operations_v0.1.md`](runbooks/GitPM_Local_Operations_v0.1.md) — эксплуатация и диагностика.

## Действующие контракты

- [`GitPM_Repository_Format_v1.md`](GitPM_Repository_Format_v1.md) и `../schemas/v1` — layout, identity, ссылки и YAML profile;
- [`GitPM_Implementation_Plan_v0.7.md`](GitPM_Implementation_Plan_v0.7.md) — архитектурный baseline v0.1 с принятыми post-release дополнениями;
- [`GitPM_Delivery_Policies_v0.5.md`](GitPM_Delivery_Policies_v0.5.md) — границы поставки и эксплуатации;
- [`GitPM_Security_Baseline_v0.5.md`](GitPM_Security_Baseline_v0.5.md), [`GitPM_Threat_Model_v1.md`](GitPM_Threat_Model_v1.md) и [`adr/0001-safe-git-filesystem-credential-boundaries.md`](adr/0001-safe-git-filesystem-credential-boundaries.md) — security invariants;
- [`adr/0002-project-centric-workspace-and-stage-navigation.md`](adr/0002-project-centric-workspace-and-stage-navigation.md) — project-centric UX/navigation decision.

При расхождении prose со schema или кодом нельзя молча выбирать удобный вариант:
публичный контракт нужно синхронизировать явно. Для структуры данных JSON Schema
и repository validator являются машинно-проверяемой частью контракта.

## Release evidence и исторические планы

Эти файлы нужны для воспроизводимости принятого v0.1, но не являются текущим backlog:

- [`GitPM_Work_Plan_v0.8.md`](GitPM_Work_Plan_v0.8.md);
- [`GitPM_Requirements_Traceability_v0.5.yaml`](GitPM_Requirements_Traceability_v0.5.yaml);
- [`GitPM_Execution_Status_v0.1.yaml`](GitPM_Execution_Status_v0.1.yaml);
- [`GitPM_Planning_Maintenance_Guide_v0.3.md`](GitPM_Planning_Maintenance_Guide_v0.3.md);
- [`GitPM_UX_UI_Global_Refactoring_Plan_v0.1.md`](GitPM_UX_UI_Global_Refactoring_Plan_v0.1.md).

[`PROGRESS.md`](PROGRESS.md) содержит только актуальную человеческую сводку и
ссылки на подробное evidence. Старые версии документов сохраняются в Git history,
а не копируются рядом под новыми именами.
