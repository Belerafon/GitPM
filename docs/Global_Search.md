# Глобальный поиск

Глобальный поиск работает только в текущей рабочей копии (`draft` в worktree mode или
`DRF-LOCAL` в direct mode). Источником служит тот же fingerprint-кэшированный индекс Git/YAML,
который используют остальные domain read-модели; отдельный поисковый индекс или business
database не создаётся.

Поиск охватывает Project, Task, Milestone, Person, Team и Calendar, включая архивные сущности.
Сопоставляются неизменяемый ID, имя или заголовок, а также короткий контекст: группа проекта,
родительский проект, email человека и участники команды. Результаты ранжируются по точному
совпадению, префиксу и вхождению; при одинаковом ранге порядок детерминирован типом, названием
и ID. Нормализация запроса locale-neutral (`NFKC`, trim, lowercase).

В web UI поле доступно в верхней панели и получает фокус по `Ctrl+K`/`Cmd+K`. Стрелки выбирают
результат, `Enter` открывает сущность, `Escape` закрывает список. Archived Project, Task и
Milestone открываются с включённым archive view.

## HTTP

```http
GET /api/drafts/:draftId/search?q=<query>&limit=<1..50>
```

`q` обязателен, имеет длину от 1 до 200 символов. `limit` по умолчанию равен `20`. Ответ не
содержит полных документов:

```json
{
  "query": "approve",
  "items": [
    {
      "entity_type": "task",
      "id": "T-26-P9G3P8",
      "title": "Approve schema v1",
      "context": "GitPM alpha",
      "project_id": "P-26-MGP84K",
      "lifecycle": "active"
    }
  ],
  "total": 1
}
```

`entity_type` принимает `project`, `task`, `milestone`, `person`, `team` или `calendar`.
`context` и `project_id` присутствуют только когда применимы. `total` — число всех совпадений
до ограничения `limit`. Endpoint требует те же session и право чтения draft, что и остальные
domain read routes.
