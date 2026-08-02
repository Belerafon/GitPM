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
Параллельно `gitpm init` создаёт корневой `.ignore` (и прописывает его в
`allowed_top_level_files`), который отменяет игнор `uploads/` только для
инструментов поиска на базе `ripgrep` (включая OpenCode) — агент находит файлы
в `uploads/`, хотя Git их не отслеживает. Ни `.gitignore`, ни `.ignore` не
являются механизмом контроля доступа.

## Файловый менеджер и доменный слой

Файловый менеджер является низкоуровневым интерфейсом к рабочему дереву, а не
редактором GitPM-сущностей. Он может изменять любые разрешённые пути рабочего
дерева, кроме Git metadata, включая файлы в `.gitpm/`, `projects/`, `people/`,
`teams/` и `calendars/`.

Обычные файлы можно скачивать без ограничений текстового предпросмотра; Git metadata,
symbolic links и пути за пределами рабочего дерева остаются недоступными.

Такие операции проверяют границы пути, symlink и конкурентный fingerprint, но
не обязаны выполнять JSON Schema и полную repository validation после каждого
изменения. Поэтому файловый менеджер может временно оставить repository в
невалидном состоянии.

Редактирование Project, Task, Milestone, Person, Team, Calendar и repository
configuration через формы GitPM или CLI использует доменный mutation pipeline:
канонизацию YAML, проверку ссылок, полную validation и rollback при ошибке.
Пользователь отвечает за корректность низкоуровневых файловых изменений.
Перед commit и push repository должен пройти полную validation.

Конфигурационные пути фиксированы:

- `.gitpm/repository.yaml` — `gitpm/repository@1`;
- `.gitpm/statuses.yaml` — `gitpm/statuses@2`;
- `.gitpm/issue-types.yaml` — `gitpm/issue-types@1`;
- `.gitpm/schedule-tracks.yaml` — `gitpm/schedule-tracks@1`;
- `.gitpm/work-categories.yaml` — `gitpm/work-categories@1`.

Сущности используют схему v2: `gitpm/project@2`, `gitpm/task@2`, `gitpm/milestone@2`.
Сроки и оценки больше не хранятся в корне документа — они вынесены в
`schedules.<track>` (см. ниже); `gitpm/time-entry@1` хранит фактические
трудозатраты в `projects/<project>/time-entries/<task>/<entry>.yaml`.

Validation возвращает `REPOSITORY_DIRECTORY_REQUIRED`, если обязательный каталог
отсутствует или не является каталогом, `REPOSITORY_DOCUMENT_REQUIRED`, если отсутствует
фиксированный конфигурационный документ, `FS_SYMLINK` для symlink в repository/domain path
и `REPOSITORY_UNKNOWN_PATH` для неизвестного файла, пустого каталога или другого элемента
внутри domain layout. Пустые корневые collection-каталоги `people/`, `teams/` и `projects/`
могут содержать созданный `gitpm init` файл `.gitkeep`; другие non-YAML файлы внутри domain
layout запрещены.

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
- Task `project`, `parent`, `milestone`, `schedules.<track>.depends_on` и Saved View/Milestone
  `project` не могут пересекать границу Project.
- Task `parent` образует ациклическое дерево произвольной глубины. Родитель и все потомки
  имеют одинаковый `milestone`; отсутствие `milestone` также считается значением.
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
`default_calendar` должен ссылаться на active Calendar. Текущий default Calendar нельзя
архивировать, пока `.gitpm/repository.yaml` не переключён на другой active Calendar.

## Calendars and built-in presets

Calendar задаёт повторяющиеся рабочие дни недели в `working_weekdays` и
дополнительные нерабочие даты в `holidays`. Еженедельные выходные не нужно
дублировать в `holidays`: расчёты Gantt и Workload исключают их по
`working_weekdays`. Schema v1 не поддерживает обратные исключения — отдельную
субботу нельзя объявить рабочей поверх пятидневной недели.

Web UI предлагает редактируемые предустановки:

- стандартная пятидневка без государственных праздников;
- официальная пятидневка России на 2026 год;
- рабочие все семь дней недели.

Предустановка материализуется как обычный `gitpm/calendar@1`: её идентификатор,
источник и связь с каталогом предустановок в YAML не сохраняются. Поэтому
годовая предустановка явно содержит год в пользовательском названии и не
обновляется автоматически. Российская предустановка 2026 содержит 14
дополнительных нерабочих будней и даёт 247 рабочих дней; периоды отдыха и
переносы сверены с
[сообщением Правительства РФ о постановлении № 1466](https://government.ru/news/56309/).

## Scalar rules

Date-only имеет форму `YYYY-MM-DD`; календарная корректность и
`schedules.<track>.start <= schedules.<track>.finish` проверяются domain
validator. `schedules.<track>.effort_hours` неотрицателен и кратен 0.25.
Project может содержать необязательную строку `group` длиной до 100 символов.

## Schedule tracks и фактические трудозатраты

`.gitpm/schedule-tracks.yaml` описывает именованные контуры (`manual` с
`capabilities`: `dates`, `effort`, `dependencies`; либо `actual` с
`source: time_entries`) и репозиторные defaults (`primary_track`,
`workload_track`, `comparison_track`, `enabled_tracks`, `dashboard_tracks`).
Project переопределяет их полем `planning` и хранит окна в `schedules` —
отображение `track -> { start, finish, effort_hours, depends_on }`.
Отсутствующее поле `planning` наследует соответствующий repository default, а явно заданные
`enabled_tracks: []` и `dashboard_tracks: []` остаются пустыми списками. После разрешения defaults
`primary_track` обязан быть включённым manual-контуром с capability `dates`, `workload_track` —
включённым manual-контуром с capabilities `dates` и `effort`, а `comparison_track`, если задан, —
включённым manual-контуром с capability `dates`. Actual- и dependency-only-контуры не могут быть
primary, workload или comparison, если не удовлетворяют этим требованиям.
`.gitpm/work-categories.yaml` задаёт категории фактической работы.
`gitpm/time-entry@1` (`projects/<project>/time-entries/<task>/<entry>.yaml`)
фиксирует: `person`, `performed_on`, `hours` (положителен, кратен 0.25),
`category`, `state` (`active`/`voided`); actual-контур вычисляется по
активным записям, а не хранится явно. Циклы зависимостей проверяются
отдельно по каждому контуру.
Voided entry обязательно хранит `voided_at` и `voided_by`; active entry не
содержит voiding-полей. Если указан `replacement`, это существующая другая
TimeEntry той же Task. Неактивная work category остаётся валидной для
исторической записи, но не может использоваться при создании новой. При
межпроектном перемещении Task все TimeEntry её поддерева атомарно переходят в
канонические каталоги целевого Project.
Группа хранится непосредственно в `project.yaml`, не является ссылкой или
отдельной сущностью; пробелы по краям удаляются на границе UI-мутации.
Списки ссылок и labels не содержат повторов. Project `milestone_order` задаёт
ручной порядок этапов, а Milestone `task_order` — ручной приоритет задач внутри sibling-групп.
Канонические операции перемещения и переупорядочивания записывают полный depth-first
pre-order дерева: родитель расположен перед всеми потомками, соседние поддеревья не
перемешиваются.
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
