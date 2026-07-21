# GitPM: архитектура и техническая спецификация

Версия документа: 0.7  
Статус: активная архитектура v0.1

## 1. Цель и источник истины

GitPM является Git-first системой управления проектами и задачами. Пользователь работает через UI, а агент изменяет данные только через CLI в отдельной ветке и `git worktree`; прямое редактирование YAML агентом запрещено. Оба сценария используют file diff и semantic diff, validation, commit, push и GitLab Merge Request.

Git является единственным источником бизнес-данных. Веб-интерфейс редактирует и отображает содержимое worktree, но не хранит отдельную бизнес-модель в базе данных.

## 2. Границы v0.1

В v0.1 входят:

- один заранее настроенный выделенный GitPM repository;
- Project, Task, Milestone, Person, Team, Calendar и Saved View;
- Task list, административный UI, Board и History;
- Changes с Added, Modified и Deleted files;
- упрощенный semantic diff;
- restore целого файла, удаленного файла и hunk;
- commit всех изменений draft, push и GitLab Merge Request;
- read-only Gantt;
- приблизительный Workload;
- работа агента через отдельный worktree и общий CLI;
- расширяемая локализация UI и CLI через locale packs; русский язык обязателен для v0.1.

В v0.1 не входят:

- база данных бизнес-данных;
- backup, replication и safety refs;
- migration engine;
- quota engine;
- собственный permission engine;
- webhook processing;
- rebase API, conflict editor и three-way merge UI;
- интерактивное редактирование Gantt;
- scheduling engine;
- MCP server и отдельный agent API;
- обязательный live integration test с реальным GitLab project.

Alpha и MVP являются одним milestone.

## 3. Выделенный repository

v0.1 требует отдельный repository, предназначенный только для GitPM-данных.

Разрешенное содержимое верхнего уровня:

```text
.gitpm/
people/
teams/
calendars/
projects/
README.md
.gitignore
```

Произвольный исходный код, submodules, Git LFS pointers и неизвестные domain directories не поддерживаются. Неизвестные файлы блокируют validation, кроме явно разрешенных служебных файлов из `.gitpm/repository.yaml`.

## 4. Единая идентичность

У каждой доменной сущности есть один immutable короткий ID вида
`<тип>-<две цифры года>-<6 символов Crockford Base32>`:

```text
P-26-7K4M9Q
T-26-X8D2FW
M-26-3RC7NA
```

Правила:

- отдельного display key нет;
- внутренние ссылки и mutation API используют ID;
- title и name не являются идентичностью;
- `P`, `T`, `M`, `U`, `G`, `C` и `V` обозначают соответственно Project, Task,
  Milestone, Person, Team, Calendar и Saved View;
- случайная часть генерируется криптографическим генератором, а уникальность
  проверяется в текущем repository state;
- при независимом создании одинакового ID в несведённых offline branches
  коллизия обнаруживается validation при merge и должна быть разрешена
  повторной генерацией одного из ID;
- абсолютная историческая гарантия непереиспользования после delete не заявляется.

Правило пути:

- для Task, Milestone, Person, Team, Calendar и Saved View имя YAML-файла равно ID;
- для Project ID равен имени каталога `projects/<project-id>/`, а файл всегда называется `project.yaml`;
- validator проверяет это исключение явно.

## 5. Repository layout

```text
.gitpm/
  repository.yaml
  statuses.yaml
  issue-types.yaml

people/
  U-26-......yaml
teams/
  G-26-......yaml
calendars/
  C-26-......yaml
projects/
  P-26-....../
    project.yaml
    milestones/
      M-26-......yaml
    tasks/
      T-26-......yaml
    views/
      V-26-......yaml
```

Одна сущность хранится в одном YAML-файле.

## 6. Schema v1 baseline

P01 завершается не schema drafts, а утвержденным минимальным schema v1 baseline. P02 не продолжает проектирование модели, а реализует parser и validation по этому baseline.

### 6.1. Общие правила

Все сущности содержат:

- `schema`: строка вида `gitpm/<type>@1`;
- `id`: immutable short ID;
- `lifecycle`: `active` или `archived`.

Необязательные значения представлены отсутствующим полем или `null` только там, где schema это прямо разрешает. Estimate хранится в часах как `estimate_hours`, неотрицательное число с шагом 0.25.

Markdown поддерживается только в полях с суффиксом `_markdown`. Raw HTML запрещен renderer и считается обычным текстом.

### 6.2. Project

Обязательные поля:

- `schema`, `id`, `name`, `status`, `lifecycle`.

Необязательные поля:

- `description_markdown`;
- `owner` -> Person ID;
- `start`, `due`;
- `labels`.

`start` и `due` являются date-only строками. Если заданы оба, `start <= due`.

### 6.3. Task

Обязательные поля:

- `schema`, `id`, `project`, `title`, `type`, `status`, `lifecycle`.

Необязательные поля:

- `description_markdown`;
- `acceptance_criteria_markdown`: список строк Markdown;
- `parent` -> Task ID того же Project;
- `milestone` -> Milestone ID того же Project;
- `assignees`: список Person ID без повторов;
- `estimate_hours`;
- `start`, `due`;
- `depends_on`: список Task ID того же Project;
- `labels`.

В v0.1 допускается несколько assignee. Cross-project parent, milestone и dependencies запрещены. Task без дат не отображается на Gantt. Task без estimate не участвует в Workload.

### 6.4. Milestone

Обязательные поля:

- `schema`, `id`, `project`, `name`, `lifecycle`.

Необязательные поля:

- `description_markdown`;
- `due`.

Milestone находится в том же Project, что и ссылающиеся на него Task.

### 6.5. Person

Обязательные поля:

- `schema`, `id`, `name`, `weekly_capacity_hours`, `calendar`, `lifecycle`.

Необязательные поля:

- `email`.

`weekly_capacity_hours` является неотрицательным числом. Архивный Person остается допустимой старой ссылкой, но UI не предлагает его для новых назначений.

### 6.6. Team

Обязательные поля:

- `schema`, `id`, `name`, `members`, `lifecycle`.

`members` содержит уникальные Person ID. Team является единственным источником membership; Person не содержит обратный список teams.

### 6.7. Calendar

Обязательные поля:

- `schema`, `id`, `name`, `working_weekdays`, `holidays`, `lifecycle`.

`working_weekdays` содержит уникальные ISO weekday numbers 1-7. `holidays` содержит уникальные date-only строки. Timezone, рабочие интервалы внутри дня и DST отсутствуют.

### 6.8. Saved View

Обязательные поля:

- `schema`, `id`, `project`, `name`, `kind`, `filters`, `lifecycle`.

`kind`: `list` или `board`. В v0.1 Saved View хранит только поддерживаемые фильтры и grouping по status. Swimlanes отсутствуют.

`filters` является объектом и допускает только `statuses`, `types`, `assignees`,
`milestones` и `labels`; каждый фильтр хранится списком без повторов. Необязательный
`group_by` поддерживает только значение `status`.

### 6.9. Repository configuration

`.gitpm/repository.yaml` содержит:

- `schema: gitpm/repository@1`;
- `default_branch`;
- `default_calendar` -> Calendar ID;
- `allowed_top_level_files` — имена разрешенных дополнительных файлов без path separators;
- `ui_poll_interval_seconds` — целое число в диапазоне 2-10.

GitLab URL, project ID, repository URL и OAuth secret относятся к server configuration и не редактируются через UI.

`.gitpm/statuses.yaml` содержит `schema: gitpm/statuses@1` и список `statuses`.
`.gitpm/issue-types.yaml` содержит `schema: gitpm/issue-types@1` и список
`issue_types`. Оба файла хранят упорядоченные конфигурационные значения с
immutable `slug`, `title`, `color` token и `active`. Slug уникален внутри файла.
Эти записи не являются ID-сущностями. Maintainer может редактировать их через
repository settings UI.

### 6.10. Archived behavior

- archived entities скрыты из активных списков по умолчанию;
- archived Task не показывается на Board, Gantt и Workload;
- существующие ссылки на archived Person, Milestone и Task разрешены с warning;
- UI не предлагает archived сущности для новых ссылок;
- delete использует `restrict` и блокируется при любой оставшейся прямой ссылке.

## 7. YAML profile

Поддерживается ограниченный YAML 1.2 profile:

- UTF-8 и LF;
- два пробела;
- duplicate keys запрещены;
- anchors, aliases и custom tags запрещены;
- formatter задает порядок полей;
- formatter регенерирует у ID-ссылок канонические комментарии
  `# <kind>: <name/title>` из полного индекса репозитория;
- произвольные ручные комментарии могут быть удалены formatter;
- manual editing разрешено, но commit и push блокируются при failed format или validation.

Schema version присутствует в каждом объекте. Неизвестная версия отклоняется. Migration engine в v0.1 отсутствует.

## 8. Git clone, fetch и main synchronization

Server обслуживает один configured GitLab project и один configured `default_branch`.

### 8.1. Локальный repository

`/data/repository.git` является bare repository. При первом запуске server:

1. создает bare repository, если его нет;
2. добавляет controlled `origin`;
3. fetch выполняется с явным refspec в `refs/remotes/origin/*`;
4. проверяется наличие `origin/<default_branch>`.

Для clone/fetch используется read-only service credential, переданный server через mounted secret file. Пользовательские OAuth tokens для этого не используются.

### 8.2. Создание draft

Перед каждым созданием draft server под repository-wide lock выполняет fetch. Новый draft создается только от точного commit `origin/<default_branch>`, который записывается как `base_commit`.

Если GitLab недоступен или fetch завершился ошибкой, новый draft не создается из устаревшего local main. Offline draft creation отсутствует.

Branch naming:

```text
gitpm/<gitlab-user-id>/<draft-id>
```

### 8.3. Push и divergence

Push публикует только draft branch, без force. Перед push server повторно проверяет права пользователя и наличие remote branch divergence. GitPM не выполняет rebase. Если target branch ушла вперед, MR все равно можно создать; конфликт отображается по ответу GitLab API.

### 8.4. Сериализация Git-операций

Fetch и операции, меняющие общий bare repository, сериализуются repository-wide lock. Операции внутри одного worktree сериализуются draft lock. Разные worktree могут выполнять безопасные read/write операции параллельно, если они не требуют общего lock.

## 9. Draft lifecycle и ownership

Draft metadata содержит:

- `draft_id`;
- `owner_gitlab_user_id`;
- `branch`;
- `base_commit`;
- `worktree_path`;
- `writer_mode`: `ui` или `external`;
- `state`: `open`, `closed`, `published` или `abandoned`;
- optional `merge_request_iid`.

Правила:

- draft принадлежит одному GitLab user или одному agent account;
- несколько readers разрешены;
- одновременно разрешен ровно один writer mode;
- в `ui` mode внешняя запись запрещена организационно, а обнаруженная внешняя запись инвалидирует runtime model и вызывает `409 DRAFT_CHANGED_EXTERNALLY`;
- в `external` mode UI является read-only, пока owner явно не переключит mode;
- переключение mode требует отсутствия выполняющейся mutation;
- `close` переводит draft в read-only, но не удаляет worktree или branch;
- owner может reopen draft;
- `cleanup` является отдельной явной операцией Maintainer;
- dirty или unpushed draft никогда не удаляется автоматически;
- cleanup dirty draft требует явного destructive confirmation с вводом draft ID;
- branch и worktree после merged/closed draft удаляются только explicit cleanup.

## 10. Per-draft runtime model

Каждый открытый draft имеет отдельную in-memory model.

Server не использует filesystem watcher в v0.1. Browser polling выполняется каждые 3 секунды. Перед read, mutation, validation и commit server сравнивает worktree revision fingerprint:

- `git status --porcelain=v2`;
- mtime и size измененных domain files;
- content hash для файлов, участвующих в mutation.

Если fingerprint изменился, model перечитывает затронутые файлы или полностью reload worktree при неясном изменении.

Для draft в `external` writer mode polling response содержит monotonic runtime revision и список затронутых domain paths. Открытый UI при новой revision перечитывает только затронутые read-models, а при неоднозначном наборе изменений выполняет полный reload. Клиент сравнивает предыдущую и новую нормализованные модели по стабильным field paths; это сравнение является presentation metadata и не записывается в repository.

Несколько внешних изменений между двумя poll объединяются в одну revision. Последовательные изменения одного поля во время активной индикации продлевают ее, но не запускают повторное мигание. В `ui` writer mode неожиданное внешнее изменение по-прежнему инвалидирует mutation и возвращает `409 DRAFT_CHANGED_EXTERNALLY`, а не бесшумно сливается с редактируемой формой.

Optimistic revision для файла является Git blob object ID, вычисленным `git hash-object --stdin` по текущим байтам файла. Файл не обязан быть staged или committed. Mutation принимает ожидаемый blob ID и возвращает `409 FILE_VERSION_MISMATCH` при несовпадении.

## 11. Локальная сохранность без backup

Поддерживается:

- завершенная atomic write переживает restart процесса или контейнера при сохранном persistent volume;
- runtime model восстанавливается перечитыванием worktree;
- UI предупреждает о uncommitted и unpushed changes.

Не поддерживается:

- safety refs и safety commits;
- backup worktree;
- восстановление после удаления worktree directory или потери persistent volume.

Потеря volume означает потерю local-only данных. RPO и RTO для этого события не заявляются.

## 12. Delete и archive

Archive меняет `lifecycle: archived` и оставляет файл.

Delete удаляет файл из worktree. Перед delete server проверяет прямые ссылки. В v0.1 используется только `restrict`.

Восстановление удаленного файла выполняется Git restore до commit или revert draft после commit/merge.

## 13. Validation и CLI

Общие команды используются UI, CI и агентом:

```bash
gitpm format
gitpm format --check
gitpm validate
gitpm validate --changed
gitpm diff --semantic
gitpm doctor
gitpm draft status
gitpm draft set-writer external
gitpm commit --all -m "..."
gitpm push
gitpm mr create
```

Проверяются syntax, schema, path/ID rules, уникальность текущего state, references, cycles, dates, archived warnings, delete restrictions и agent scope.

Commit в v0.1 всегда включает все изменения draft. Staging UI и выбор отдельных файлов отсутствуют.

## 14. Changes и restore

Changes показывает только Added, Modified и Deleted files. Renamed не является отдельной доменной операцией и отображается как delete плюс add.

Поддерживаются:

- restore целого modified file;
- restore deleted file;
- restore selected hunk;
- discard all uncommitted changes;
- restore file from commit;
- `git revert` в новом draft.

Restore selected lines отсутствует.

## 15. History без rebase

History показывает commit graph, author, message, files, semantic summary и ссылку на MR.

Поддерживается создание revert draft через `git revert`.

GitPM не выполняет rebase и не разрешает conflicts. При conflict UI показывает статус и предлагает внешний Git client, GitLab UI или новый draft от текущего main.

## 16. OAuth 2.0 и GitLab integration

Используется только OAuth 2.0 Authorization Code Flow with PKCE. Термин OIDC в документах v0.1 не используется.

Обязательные решения:

- OAuth scopes: `api` и `write_repository`;
- `state` обязателен; `nonce` не используется;
- access token хранится только в памяти процесса;
- refresh token не сохраняется;
- session lifetime не превышает lifetime access token и 8 часов;
- restart завершает sessions;
- пользователь без project membership получает deny;
- role cache живет не более 60 секунд;
- роль повторно запрашивается перед commit, push и MR.

Для Git over HTTPS используется статический controlled `GIT_ASKPASS` helper. Token передается дочернему процессу только через environment, отсутствует в remote URL, argv, Git config, temp files и logs. Устанавливаются `GIT_TERMINAL_PROMPT=0`, isolated HOME и controlled Git config.

Автоматические тесты используют:

- OAuth/API protocol-level test double;
- локальный bare remote для Git push;
- credential-capturing helper, проверяющий отсутствие утечки.

Обязательного live GitLab test project нет.

Webhook отсутствует в v0.1. Состояние MR и branch обновляется polling GitLab API при открытом UI и по явному refresh.

## 17. Простая модель прав

GitLab project access level отображается напрямую:

- Guest или отсутствие membership: deny;
- Reporter: read-only;
- Developer: собственные draft, normal domain edits, commit, push и MR;
- Maintainer: права Developer плюс Person, Team, Calendar, statuses, issue types и cleanup abandoned draft;
- GitPM Administrator: внешний server operator, заданный конфигурацией; UI server configuration отсутствует.

Backend повторно проверяет роль перед mutation, commit, push и MR. UI visibility не является security boundary. Изменение `.gitpm/repository.yaml` через domain API запрещено. `statuses.yaml` и `issue-types.yaml` доступны только Maintainer routes.

## 18. UI decisions

v0.1 использует browser polling каждые 3 секунды, а не SSE.

Внешнее обновление от агента отображается без автоматического перемещения focus или scroll:

- видимое изменившееся поле получает мягкий background tint и тонкий inset outline;
- переход проявляется за `200-300 ms`, сохраняется около `3 s` и затухает за `500-700 ms`;
- изменившаяся скрытая или свернутая сущность получает один спокойный indicator на строке/карточке до ее открытия;
- одна polite `aria-live` сводка сообщает количество обновленных сущностей/полей, не озвучивая каждое поле отдельно;
- `prefers-reduced-motion: reduce` отключает animation: остается статическое выделение примерно на `4 s`;
- цвет не является единственным сигналом, частые updates coalesce, мигание, пульсация и infinite animation запрещены.

Подсветка применяется только к данным, изменившимся между подтвержденными server revisions, и не используется для локальной optimistic mutation текущего пользователя. В памяти UI хранится `Map<entity-id, Set<field-path>>` с expiry timestamp; отдельное копирование domain state для animation не требуется.

Обязательные области:

- переключатель locale в пользовательском меню;
- Portfolio;
- Projects and Tasks;
- Board без swimlanes;
- People and Teams;
- Calendar administration;
- Repository settings только для statuses и issue types;
- Workload;
- read-only Gantt;
- Changes;
- History.

Repository selector и server configuration UI отсутствуют. Выбранный locale хранится в browser localStorage и не является бизнес-данными. Специальная virtualization не является требованием v0.1; она добавляется только при нарушении performance smoke.

## 19. Упрощенный semantic diff

Semantic diff сообщает:

- created, updated, archived и deleted entities;
- измененные поля before/after;
- changed files count;
- затронутые projects;
- invalid references и cycles из validation report.

Он не рассчитывает authorization impact, schedule simulation или сложную resource delta.

## 20. Calendar, read-only Gantt и Workload

Calendar schema и date utilities определяются в P01-P02, до API и UI.

Gantt только читает `start`, `due`, hierarchy, milestone и dependency. Drag, resize и inline date editing отсутствуют.

Workload:

- берет `estimate_hours` Task;
- равномерно распределяет часы по ISO-неделям между `start` и `due`;
- исключает archived Task и non-working dates Calendar;
- делит часы поровну между несколькими assignee;
- сравнивает результат с `weekly_capacity_hours`;
- показывает формулу и помечает отчет как approximation.

## 21. Агент через files и CLI

Агент получает отдельный draft в `external` writer mode и редактирует YAML непосредственно.

Рекомендуемый цикл:

```bash
gitpm format
gitpm validate --changed
gitpm diff --semantic
gitpm commit --all -m "..."
gitpm push
gitpm mr create
```

CLI принимает optional allowed Project ID и explicit delete flag. UI в external mode read-only. MCP и agent API отсутствуют.

Пока агент изменяет YAML, открытый read-only UI продолжает polling и обновляет read-model с небольшой задержкой. Затронутые поля временно получают ненавязчивую external-update индикацию по правилам разделов 10 и 18. Это позволяет наблюдать работу агента без filesystem watcher, отдельного agent API и ручного reload страницы.

## 22. Security baseline

Ранние обязательные меры:

- safe argv execution без shell;
- controlled Git config и disabled hooks, filters, textconv и submodules;
- path containment и symlink checks;
- atomic writes;
- static request, file and output limits;
- CSP, CSRF, safe Markdown и XSS tests;
- token не попадает в filesystem, URL, argv или logs.

## 23. Минимальная наблюдаемость

Обязательны:

- `/health/live` и `/health/ready`;
- structured logs;
- correlation ID;
- duration, exit code и timeout Git operations;
- GitLab OAuth/API errors;
- отсутствие secrets в logs.

Prometheus, dashboards, distributed tracing и отдельная metrics platform отсутствуют.

## 24. Reproducible performance smoke

Reference profile фиксируется в CI image:

- Linux x86_64;
- 4 vCPU;
- 8 GiB RAM;
- local ext4 filesystem;
- Node.js и Git versions pinned в CI image and lock files;
- network не входит в измерение.

Fixture детерминированно содержит 30 Projects, 30 People и 3000 Tasks. Cold load означает новый process без application cache; OS page cache специально не сбрасывается.

Для каждого сценария выполняются три независимых measured process runs, используется median:

- cold load 3000 Tasks: <= 5 секунд;
- изменение и full validation одной Task: <= 1 секунды;
- semantic diff 100 modified files: <= 3 секунд;
- process RSS после load 3000 Tasks: <= 512 MiB.

Это smoke gate, а не SLA на 30 concurrent users.

## 25. Deployment

Один Node.js process, системный Git и persistent volume:

```text
/data/repository.git
/data/worktrees
/data/state
```

Server configuration задается config file, environment и mounted secrets. Backup не входит в продукт.

## 26. Исполнение, evidence и release gates

Исполнимый порядок находится в `GitPM_Work_Plan_v0.8.md`.

Формальный DAG, requirements, verification checks и gate composition находятся в `GitPM_Requirements_Traceability_v0.5.yaml`.

Фактические статусы и evidence находятся в `GitPM_Execution_Status_v0.1.yaml`. Команда `scripts/check_release_gate.py` проверяет реальное выполнение gate, а не только структуру плана.

Правила поддержки находятся в `GitPM_Planning_Maintenance_Guide_v0.3.md`.

## 27. Локализация

GitPM проектируется как многоязычное приложение с зарегистрированными locale packs. Добавление нового языка не должно требовать изменения доменной модели, API или компонентов UI, кроме регистрации нового набора сообщений и locale metadata.

### 27.1. Обязательные locale v0.1

- русский `ru` является обязательным и должен иметь 100% покрытие пользовательских сообщений к release v0.1;
- английский `en` является source locale и техническим fallback;
- server default locale задается `GITPM_DEFAULT_LOCALE`, значение по умолчанию `ru`;
- при первом открытии применяется первый поддерживаемый locale из `navigator.languages`, иначе server default;
- явный выбор пользователя сохраняется в browser localStorage и имеет приоритет при следующих открытиях.

Наличие английского source locale не снижает обязательность русского: release gate падает при отсутствующем русском ключе, несовпадающих placeholders или использовании fallback на обязательных экранах.

### 27.2. Область локализации

Локализуются:

- весь application chrome и навигация;
- формы, действия, подтверждения и сообщения об ошибках;
- Changes, History, Board, Gantt и Workload UI;
- human-readable output CLI;
- даты, числа, длительности, plural forms и относительное время.

Не локализуются автоматически:

- названия и описания Project, Task, Milestone, Person, Team и Calendar;
- repository-defined titles из `statuses.yaml` и `issue-types.yaml`;
- commit messages, branch names и GitLab content;
- machine-readable JSON output CLI и API contracts.

API возвращает стабильный error code и параметры сообщения. UI и CLI локализуют сообщение на своей стороне. Persisted date-only значения остаются ISO `YYYY-MM-DD`; отображение locale-aware не должно менять дату через timezone conversion.

### 27.3. Формат сообщений

- сообщения хранятся в version-controlled JSON locale packs в code repository, а не в portfolio repository;
- ключи являются стабильными namespaced identifiers, например `task.delete.confirmation`;
- pluralization и параметризация используют ICU MessageFormat или эквивалентную семантику;
- placeholders обязаны совпадать во всех locale;
- HTML в переводах запрещен; dynamic values экранируются;
- locale metadata содержит `languageTag`, отображаемое имя и `direction: ltr|rtl`;
- root element получает корректные `lang` и `dir`;
- v0.1 проверяет `ltr` для `ru` и `en`, но архитектура не блокирует последующее добавление RTL locale.

### 27.4. CLI

Human-readable CLI принимает locale в следующем порядке приоритета:

1. `--locale`;
2. `GITPM_LOCALE`;
3. server default locale или `ru` для standalone CLI.

`--format json` всегда использует стабильные codes, field names и values, не зависящие от locale. Это необходимо для агентов и автоматизации.

### 27.5. Проверки локализации

CI обязан проверять:

- отсутствие пропущенных и лишних message keys относительно source locale;
- совпадение placeholders и plural branches;
- 100% полноту `ru`;
- отсутствие raw HTML в сообщениях;
- отсутствие hard-coded user-facing strings в обязательных UI surfaces, кроме allowlist;
- корректное форматирование date-only, чисел и plural forms для `ru`;
- переключение locale без изменения YAML, Git diff или API payload;
- сохранение выбранного locale после reload;
- возможность подключить тестовый третий locale только через registry и locale pack.

Полный localization acceptance выполняется перед Release Candidate. Перевод пользовательского контента и runtime upload переводов в v0.1 отсутствуют.
