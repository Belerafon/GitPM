# GitPM repository format v1

Статус: действующий schema-v1 contract (approved P01 baseline с принятыми дополнениями).

## Источники контракта

Нормативные поля и поведение определены в `GitPM_Implementation_Plan_v0.7.md`.
Машинно-читаемые структуры находятся в `schemas/v1/*.schema.json` и используют
JSON Schema 2020-12. Этот документ фиксирует правила layout и ссылок, которые не
выражаются одной JSON Schema.

## Layout

Обязательные каталоги верхнего уровня: `.gitpm`, `people`, `teams`, `calendars`
и `projects`. Пути `AGENTS.md` и `.agents/skills/gitpm/SKILL.md` зарезервированы
для инструкций, которые GitPM создаёт в рабочем дереве каждого черновика независимо от writer mode.
Это локальные runtime-файлы: GitPM не включает их в semantic diff, commit и MR.
Дополнительные файлы верхнего уровня разрешены только если их
имена перечислены в `.gitpm/repository.yaml` в `allowed_top_level_files`.
Дополнительные каталоги верхнего уровня разрешены, если они перечислены в
`allowed_top_level_directories`. Неизвестные файлы и каталоги верхнего уровня
запрещены. Зарезервированные имена `.git`, `.gitpm`, `.agents`, `AGENTS.md`
и `.gitignore` всегда разрешены и не требуют явного listing.

Каталоги из `allowed_top_level_directories` не являются domain-сущностями: они
не валидируются и не попадают в GitPM semantic snapshots. Стандартный `uploads/`
предназначен для пользовательских исходных документов, которые агент может
прочитать и преобразовать в CLI input, но не должен коммитить. Корневой
`.gitignore` игнорирует содержимое `uploads/`, оставляя только `.gitkeep`.

Конфигурационные пути фиксированы:

- `.gitpm/repository.yaml` — `gitpm/repository@1`;
- `.gitpm/statuses.yaml` — `gitpm/statuses@1`;
- `.gitpm/issue-types.yaml` — `gitpm/issue-types@1`.

Validation возвращает `REPOSITORY_DIRECTORY_REQUIRED`, если обязательный каталог
отсутствует или не является каталогом, `REPOSITORY_DOCUMENT_REQUIRED`, если отсутствует
фиксированный конфигурационный документ, и `FS_SYMLINK` для symlink в repository/domain path.

Person, Team и Calendar хранятся соответственно в `people`, `teams` и
`calendars`; имя файла равно ID плюс `.yaml`. Project является единственным
исключением: его ID равен имени каталога `projects/<project-id>`, а сущность
всегда находится в `project.yaml`. Внутри Project имена файлов Milestone, Task
и Saved View равны ID плюс `.yaml` в каталогах `milestones`, `tasks` и `views`.
Comment хранится в `projects/<project-id>/comments/<task-id>/<comment-id>.yaml`;
path фиксирует и owning Project, и Task.

## Identity and references

ID имеет форму `<type>-<YY>-<random>`, где type — один из `P`, `T`, `M`, `U`,
`G`, `C`, `V`, `N`; `YY` — две последние цифры UTC-года создания, а random — шесть
символов Crockford Base32. Примеры: `P-26-7K4M9Q`, `T-26-X8D2FW`,
`M-26-3RC7NA`, `N-26-ABC123`. Все ID уникальны в текущем состоянии repository. Ссылки
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
- Comment `project` и `task` должны совпадать с owning path; mentions ссылаются
  на существующих Person.
- Project/Task status и Task type ссылаются на существующие конфигурационные
  slugs; для новых значений требуется `active: true`.
- Существующая ссылка на archived entity допустима; новая создающая операция не
  должна её предлагать. Delete использует restrict.

Email Person, если задан, синтаксически валиден и уникален в repository без учёта регистра.
Во входе CLI create/import Person может не содержать Calendar: mutation boundary подставляет
активный repository `default_calendar`. Это только input default; в сохранённом каноническом
Person поле `calendar` остаётся обязательным и явным.

## Scalar rules

Date-only имеет форму `YYYY-MM-DD`; календарная корректность и `start <= due`
проверяются domain validator. `estimate_hours` неотрицателен и кратен 0.25.
Project может содержать необязательную строку `group` длиной до 100 символов.
Группа хранится непосредственно в `project.yaml`, не является ссылкой или
отдельной сущностью; пробелы по краям удаляются на границе UI-мутации.
Списки ссылок и labels не содержат повторов. Project `milestone_order` задаёт
ручной порядок этапов, а Milestone `task_order` — ручной порядок его задач.
Отсутствующие в этих списках активные сущности показываются после перечисленных.
Markdown разрешён только в полях с суффиксом `_markdown`; renderer не
интерпретирует raw HTML.

Comment имеет `state: active|deleted`. Active comment хранит `body_markdown`, а
deleted comment сохраняет tombstone metadata `deleted_at`/`deleted_by`, но не
исходный текст и не mentions. Author — стабильная provider identity, а не ссылка
на изменяемый display name.

## Saved View filters

`filters` допускает только `statuses`, `types`, `assignees`, `milestones` и
`labels`. `group_by`, если задан, равен `status`. Поддерживаемые `kind`: `list`
и `board`; swimlanes в v1 отсутствуют.

## YAML profile

Domain YAML использует UTF-8, LF и отступ в два пробела. Duplicate keys,
anchors, aliases и custom tags запрещены. Formatter добавляет к каждому ID
известной сущности канонический комментарий `# <kind>: <name/title>`, вычисленный
из всего репозитория. Эти подсказки делают YAML и Git diff читаемыми, не меняя
семантику документа; при переименовании они регенерируются. Произвольные ручные
комментарии не являются частью контракта и могут удаляться formatter. Неизвестная
schema version отклоняется; migration engine отсутствует.
