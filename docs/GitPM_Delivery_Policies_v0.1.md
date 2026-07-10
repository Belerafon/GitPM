# GitPM: политики поставки и эксплуатации

Версия документа: 0.1  
Статус: обязательный baseline для v0.1

## 1. Назначение

Документ фиксирует продуктовые и эксплуатационные решения, которые нельзя откладывать до конца разработки. Он является обязательным входом для соответствующих этапов `GitPM_Work_Plan_v0.2.md`.

## 2. Граница одного репозитория

GitPM v0.1 поддерживает ровно один заранее настроенный portfolio repository на один экземпляр сервера.

Следствия:

- repository задается конфигурацией администратора;
- пользователь не добавляет и не удаляет repositories через UI;
- маршрут `/api/repositories` в v0.1 возвращает один элемент и сохраняется только как задел для будущей совместимости;
- все draft ID уникальны в пределах экземпляра;
- webhook routing проверяет один GitLab project ID;
- квоты, cleanup и дисковые лимиты применяются к одному repository;
- multi-repository не является скрытой функцией v0.1 и не тестируется как поддерживаемый режим.

## 3. Матрица сущностей v0.1

### Полный CRUD через обычный UI

- Project;
- Task;
- Milestone;
- Person;
- Team.

### Административный UI или CLI

- Calendar;
- person capacity;
- team membership;
- repository-level settings.

### Читаются из конфигурации, но не редактируются обычным пользователем

- statuses;
- issue types;
- permission policies.

### Создаются через пользовательские функции

- ViewConfiguration создается и изменяется через сохраненные filters/views на этапе P11A.

Любая сущность, заявленная как editable, должна иметь create/read/update/delete или документированное ограничение delete mode.

## 4. Политика YAML и ручного редактирования

Канонический formatter является авторитетным.

Правила:

- пользовательские YAML-комментарии в доменных файлах запрещены;
- formatter может удалить комментарии и нормализовать blank lines;
- порядок полей определяется schema-specific formatter;
- стиль multiline strings нормализуется;
- ручное редактирование вне GitPM разрешено, но результат обязан пройти `gitpm format --check` и `gitpm validate`;
- произвольная документация хранится в полях `description`, `acceptance_criteria` или отдельных Markdown-файлах, но не в YAML-комментариях;
- неизвестные файлы не переписываются formatter без явного включения в формат.

Это решение должно быть отражено в README формата и сообщениях CLI до P01 exit gate.

## 5. Миграции схем

Неявная миграция при чтении запрещена.

Обязательные команды до Alpha:

```bash
gitpm migrate --check
gitpm migrate --dry-run
gitpm migrate --from <version> --to <version>
```

Правила:

- loader либо читает поддерживаемую версию, либо возвращает явную ошибку;
- `--dry-run` строит обычный Git diff без записи;
- реальная миграция выполняется только в отдельном draft;
- результат проходит format и full validation;
- миграция оформляется отдельным commit и MR;
- fixture предыдущей версии является обязательным тестовым артефактом;
- downgrade не обещается, но обратимость проверяется через Git revert.

## 6. Сохранность dirty draft

### 6.1. Определения

Dirty draft содержит изменения worktree, еще не включенные в пользовательский commit.

### 6.2. Гарантии Alpha

- restart Node.js процесса: потеря данных не допускается;
- restart контейнера при сохраненном persistent volume: потеря данных не допускается;
- hard kill во время записи: допускается потеря только текущей незавершенной атомарной операции;
- потеря primary volume: восстановление выполняется из отдельной backup copy safety refs;
- UI всегда показывает состояние `local only`, `safety snapshotted` или `pushed`.

### 6.3. Safety snapshots

GitPM создает safety snapshot без изменения пользовательской ветки и без появления WIP commit в MR history.

Предпочтительный механизм:

1. построить tree текущего worktree через временный index;
2. создать commit object через `git commit-tree`;
3. обновить `refs/gitpm/safety/<draft-id>`;
4. не перемещать branch HEAD;
5. включить refs в отдельное резервное копирование.

P00S обязан проверить совместимость этого механизма с выбранной версией Git и восстановление после hard kill. Возможность push custom refs в GitLab проверяется spike-тестом. Если GitLab запрещает custom refs, используется отдельный backup bare remote или служебная safety branch, недоступная для merge.

### 6.4. Целевые RPO и RTO

На reference deployment:

- RPO для dirty draft при потере primary volume: не более 5 минут;
- RTO для восстановления одного draft: не более 30 минут;
- RPO для committed/pushed данных: определяется GitLab и равен нулю со стороны GitPM после подтвержденного push;
- safety snapshot создается не реже одного раза в 5 минут и после 30 секунд idle, если worktree dirty.

### 6.5. Предупреждения

Пользователь получает явное предупреждение:

- при закрытии страницы с local-only изменениями;
- если safety snapshot не создавался более 5 минут;
- если backup remote недоступен;
- перед удалением draft с dirty worktree.

## 7. Модель прав

Роли GitPM:

- Viewer;
- Contributor;
- Maintainer;
- Administrator;
- Agent.

GitLab остается финальным источником прав push, MR и merge.

### Viewer

- читать проекты и историю;
- смотреть diff и MR;
- не создавать draft.

### Contributor

- создавать собственный draft;
- редактировать разрешенные сущности;
- архивировать;
- удалять, если project policy разрешает;
- commit, push и создавать MR от своего имени;
- не очищать чужие draft.

### Maintainer

- все права Contributor;
- восстанавливать и очищать чужие abandoned draft;
- выполнять migration draft;
- изменять Calendar, Team и capacity;
- назначать reviewer.

### Administrator

- настраивать repository;
- управлять OAuth и keyring configuration;
- задавать quotas и retention;
- назначать agent policies;
- выполнять аварийное восстановление.

### Agent

- работать только в выделенном draft;
- выполнять только операции, разрешенные policy;
- не расширять собственный scope;
- не создавать или менять permission policies;
- delete доступен только при явном `allow_delete: true` и лимите.

Передача draft другому пользователю в v0.1 не поддерживается. Maintainer может создать новый draft и перенести commit/cherry-pick.

## 8. Квоты

Значения по умолчанию для одного экземпляра:

- максимум 5 активных draft на Contributor;
- максимум 50 активных worktree на сервер;
- максимум 2 GiB на один worktree;
- максимум 20 GiB на portfolio repository вместе с Git objects;
- максимум 1 MiB на один YAML-файл;
- максимум 10 MiB на один HTTP request;
- максимум 5 MiB rendered diff на один ответ;
- максимум 2 000 файлов в одном commit через UI;
- максимум 500 файлов в одной операции агента;
- максимум 100 удалений в одном draft без Maintainer override;
- закрытые draft хранятся 14 дней;
- merged draft хранятся 7 дней;
- abandoned dirty draft не удаляется автоматически.

Все значения конфигурируются администратором. Превышение квоты должно возвращать отдельный код ошибки и не оставлять частично примененную операцию.

## 9. Бюджеты производительности

Reference hardware:

- 4 vCPU;
- 8 GiB RAM;
- локальный NVMe или эквивалентный SSD;
- GitLab в той же сети с RTT менее 20 ms;
- Node.js LTS;
- Linux x86_64.

Пороговые значения измеряются как p95 после пяти прогревочных запусков.

### Целевой портфель: 3 000 задач

- cold load модели: не более 2 секунд;
- повторное открытие из memory cache: не более 250 ms;
- PATCH одной задачи до атомарной записи: не более 250 ms без full validation;
- full validation: не более 2 секунд;
- semantic diff для 100 измененных файлов: не более 1 секунды;
- создание worktree из локального bare clone: не более 2 секунд;
- task list становится интерактивным: не более 2 секунд;
- открытие task panel: не более 200 ms после загрузки модели;
- базовая память сервера: не более 600 MiB;
- дополнительная память на активную модель worktree: не более 120 MiB.

### Расширенный набор: 10 000 задач

- cold load: не более 5 секунд;
- full validation: не более 8 секунд;
- task list interactive: не более 3 секунд;
- semantic diff для 500 файлов: не более 4 секунд;
- процесс не должен превышать 2 GiB RSS при пяти активных моделях.

100 000 файлов используется только как exploratory benchmark, а не как release gate v0.1.

## 10. GitLab test project

P06 не может получить статус `done` без реального отдельного проекта на той же major/minor версии self-hosted GitLab, которая используется в production.

Обязательные проверки:

- OAuth scopes;
- protected branch behavior;
- push от имени пользователя;
- author и committer metadata;
- MR creation;
- webhook delivery и secret verification;
- pipeline status;
- revoke token;
- недоступность GitLab;
- branch deletion и cleanup.

Test double используется только для unit/contract tests, но не заменяет integration gate.

## 11. Управление трудоемкостью

Размеры этапов:

- S: до 3 инженерных дней;
- M: 4-7 инженерных дней;
- L: 8-15 инженерных дней;
- XL: запрещен, этап должен быть разделен.

Оценка является относительной и уточняется после P00S. Любой этап, который перестал помещаться в L, разбивается до начала активной реализации.
