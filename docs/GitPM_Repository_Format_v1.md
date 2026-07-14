# GitPM repository format v1

Статус: approved P01 baseline.

## Источники контракта

Нормативные поля и поведение определены в `GitPM_Implementation_Plan_v0.7.md`.
Машинно-читаемые структуры находятся в `schemas/v1/*.schema.json` и используют
JSON Schema 2020-12. Этот документ фиксирует правила layout и ссылок, которые не
выражаются одной JSON Schema.

## Layout

Обязательные каталоги верхнего уровня: `.gitpm`, `people`, `teams`, `calendars`
и `projects`. Дополнительные файлы верхнего уровня разрешены только если их
имена перечислены в `.gitpm/repository.yaml` в `allowed_top_level_files`.
Неизвестные каталоги верхнего уровня запрещены.

Конфигурационные пути фиксированы:

- `.gitpm/repository.yaml` — `gitpm/repository@1`;
- `.gitpm/statuses.yaml` — `gitpm/statuses@1`;
- `.gitpm/issue-types.yaml` — `gitpm/issue-types@1`.

Person, Team и Calendar хранятся соответственно в `people`, `teams` и
`calendars`; имя файла равно ID плюс `.yaml`. Project является единственным
исключением: его ID равен имени каталога `projects/<project-id>`, а сущность
всегда находится в `project.yaml`. Внутри Project имена файлов Milestone, Task
и Saved View равны ID плюс `.yaml` в каталогах `milestones`, `tasks` и `views`.

## Identity and references

ID имеет форму `<type>-<YY>-<random>`, где type — один из `P`, `T`, `M`, `U`,
`G`, `C`, `V`, `YY` — две последние цифры UTC-года создания, а random — шесть
символов Crockford Base32. Примеры: `P-26-7K4M9Q`, `T-26-X8D2FW`,
`M-26-3RC7NA`. Все ID уникальны в текущем состоянии repository. Ссылки
используют только ID.

Шесть случайных символов дают 32^6 = 1 073 741 824 вариантов для каждого типа
и года. Генерация использует cryptographically secure randomness. Совпадение с
существующим путём отклоняется как `ENTITY_EXISTS`, duplicate ID отклоняется как
`IDENTITY_DUPLICATE`. Межветочная offline-коллизия остаётся теоретически
возможной и обнаруживается при validation/merge.

- Project owner, Task assignees, Team members и Saved View assignees ссылаются на Person.
- Person и repository default calendar ссылаются на Calendar.
- Task `project`, `parent`, `milestone`, `depends_on` и Saved View/Milestone
  `project` не могут пересекать границу Project.
- Project/Task status и Task type ссылаются на существующие конфигурационные
  slugs; для новых значений требуется `active: true`.
- Существующая ссылка на archived entity допустима; новая создающая операция не
  должна её предлагать. Delete использует restrict.

## Scalar rules

Date-only имеет форму `YYYY-MM-DD`; календарная корректность и `start <= due`
проверяются domain validator. `estimate_hours` неотрицателен и кратен 0.25.
Списки ссылок и labels не содержат повторов. Markdown разрешён только в полях с
суффиксом `_markdown`; renderer не интерпретирует raw HTML.

## Saved View filters

`filters` допускает только `statuses`, `types`, `assignees`, `milestones` и
`labels`. `group_by`, если задан, равен `status`. Поддерживаемые `kind`: `list`
и `board`; swimlanes в v1 отсутствуют.

## YAML profile

Domain YAML использует UTF-8, LF и отступ в два пробела. Duplicate keys,
anchors, aliases и custom tags запрещены. Комментарии не являются частью
контракта и могут удаляться formatter. Неизвестная schema version отклоняется;
migration engine отсутствует.
