# GitPM: план глобального UX/UI-рефакторинга

Версия документа: 0.1  
Статус: active  
Область: web UI  
Оценка: 36–53 engineer-days

## Прогресс выполнения

Последнее обновление: 2026-07-14

| Этап | Состояние | Примечание |
| --- | --- | --- |
| UX00 | Завершён | Work packages, automated verification, manual acceptance, exit gate и handoff закрыты 2026-07-14; пакет зафиксирован commit `4a4c816`. |
| UX01 | В работе | Введены route adapter и History API, адресуемые разделы/Project/Task/commit/Task status, deep links, reload и back/forward; App Shell, группировка меню и breadcrumbs ещё открыты. |
| UX02–UX07 | Не начаты | Ожидают завершения exit gate UX00 и зависимостей по плану. |

Текущий следующий шаг: зафиксировать первый route package UX01, затем вынести App Shell, сгруппировать меню и добавить breadcrumbs без регрессии responsive/keyboard navigation.

## 1. Цель

Последовательно преобразовать текущий Git-first интерфейс в понятный PM-инструмент, сохранив существующие доменную модель, формат репозитория, Git workflow, роли и security boundaries.

Рефакторинг выполняется эволюционно. Каждый этап должен завершаться рабочим, тестируемым и пригодным к поставке состоянием. Big-bang rewrite не допускается.

## 2. Исходные проблемы

План закрывает следующие подтверждённые проблемы:

- навигация полностью исчезает при ширине до 880 px;
- экран «Люди» имеет перекрывающиеся поля и карточки уже при ширине 1280 px;
- позиция прокрутки сохраняется при переходе на другой раздел;
- UI задачи не позволяет редактировать тип, даты, оценку, исполнителей, родителя, зависимости и критерии приёмки;
- Гант и Загрузка показывают данные, которые невозможно полноценно изменить через UI;
- в русском интерфейсе отображаются raw-slug, Git-пути, технические ID и английские названия цветов;
- удаление и архивирование недостаточно различаются визуально, часть destructive actions не требует подтверждения;
- проекты, люди, команды и календари представлены множеством одновременно открытых форм;
- календарь редактируется через номера дней недели и CSV-строки дат;
- настройки статусов и типов используют текстовые значения цветов без preview;
- Доска, Гант и Загрузка требуют неочевидной горизонтальной прокрутки;
- Загрузка не имеет настройки горизонта и медленно открывается на локальном демо;
- экран Изменений дублирует метрики и использует устаревшую Alpha-терминологию;
- История показывает длинный плоский список технических путей без группировки;
- 12 пунктов навигации представлены одним плоским списком без смысловых групп.

## 3. Ограничения

- Не менять schema v1 без отдельного архитектурного решения.
- Не ломать чтение существующих GitPM-репозиториев.
- Не менять commit-all и writer-mode semantics в рамках UX/UI-рефакторинга.
- Сохранить роли Reporter, Developer и Maintainer и текущие ограничения редактирования.
- Сохранить обработку external updates и draft fingerprint conflicts.
- Не добавлять business database или отдельное серверное состояние интерфейса.
- Backend-изменения допустимы только для измеримо необходимой агрегации или производительности.

## 4. Целевая архитектура frontend

```text
apps/web/src/
  app/
    App.tsx
    AppShell.tsx
    router.tsx
    navigation.ts
  ui/
    Button/
    Dialog/
    FormField/
    EntityList/
    EmptyState/
    StatusChip/
    Toast/
  domain/
    presentation.ts
    permissions.ts
    validation.ts
  features/
    workspaces/
    portfolio/
    projects/
    tasks/
    board/
    people/
    calendars/
    settings/
    workload/
    gantt/
    changes/
    history/
  styles/
    tokens.css
    globals.css
```

### Архитектурные правила

- `App.tsx` содержит только providers, router и App Shell.
- Каждый пользовательский раздел является отдельным feature module.
- Feature-компоненты не используют глобальные element selectors для layout.
- Feature styles переводятся на CSS Modules или эквивалентную изоляцию.
- Глобальными остаются reset, design tokens, базовая типографика и App Shell.
- Названия статусов, типов и сущностей проходят через единый presentation layer.
- Права редактирования вычисляются централизованно через permission/capability model.
- Фильтры и выбранные сущности, необходимые для восстановления страницы, хранятся в URL.
- Технические ID показываются вторичным текстом и снабжаются действием копирования.

## 5. Общий Definition of Done

- Изменение поставляется связной reviewed commit series.
- Unit, integration, browser и visual regression проверки проходят.
- Русская и английская локализации обновлены одновременно.
- Reporter, Maintainer, external writer и closed draft состояния проверены.
- Для изменённых страниц проверены loading, empty, populated, error и stale-data состояния.
- Manual acceptance имеет наблюдаемый expected result и evidence artifact.
- На поддерживаемых viewport отсутствуют перекрытия и page-level horizontal overflow.
- Документация и `docs/PROGRESS.md` обновлены.
- Working tree clean после завершения этапа.

## 6. Этапы

## UX00. Срочная стабилизация

- Size: `S`
- Estimate: `2–3 engineer-days`
- Dependencies: `none`
- Responsible: `FE, QA`

### Objective

Устранить блокирующие UX-дефекты до начала архитектурного рефакторинга.

### Work packages

- [x] Добавить кнопку мобильного меню и доступный navigation drawer.
- [x] Временно перевести «Людей» в одну колонку на недостаточной ширине.
- [x] Устранить перекрытия полей, select и action buttons на ширине 1280 px.
- [x] При смене раздела прокручивать основной контент вверх.
- [x] После навигации переводить фокус на заголовок страницы.
- [x] Добавить единое подтверждение удаления сущностей.
- [x] Визуально развести `Архивировать` и `Удалить`.
- [x] Локализовать raw-статусы в Портфеле и списке задач.

### Automated verification

- [x] browser navigation test на 390, 800 и 1280 px;
- [x] отсутствие layout overlap на странице людей;
- [x] scroll and focus restoration test;
- [x] destructive confirmation tests;
- [x] locale tests для статусов.

Evidence 2026-07-14: `pnpm test` — 38 files / 129 tests; `pnpm typecheck`, `pnpm lint` и web production build — успешно; Playwright UX00 viewport flow — 1 passed на 320/390/800/1280/1920 px. Визуальные артефакты: `evidence/ux00/ux00-320-projects.png`, `evidence/ux00/ux00-320-navigation-open.png`, `evidence/ux00/ux00-1280-people.png`.

### Manual acceptance

1. [x] Открыть каждый из 12 разделов на ширине 390 px.
2. [x] Проверить, что navigation drawer открывается мышью и клавиатурой.
3. [x] Открыть «Люди» на 1280 px и убедиться, что контролы не перекрываются.
4. [x] Прокрутить длинную страницу, перейти в другой раздел и проверить верх страницы.
5. [x] Попытаться удалить проект и отменить действие.

### Exit gate

- [x] Все разделы достижимы на ширине 320–1920 px.
- [x] Нет известных перекрытий на основных viewport.
- [x] Необратимое удаление невозможно одним кликом.

## UX01. App Shell, маршрутизация и навигация

- Size: `M`
- Estimate: `4–6 engineer-days`
- Dependencies: `UX00`
- Responsible: `FE, QA`

### Objective

Сделать состояние интерфейса адресуемым, восстанавливаемым и предсказуемым.

### Work packages

- [ ] Вынести App Shell из текущего `App.tsx`.
- [x] Ввести маршруты:

```text
/workspaces
/portfolio
/projects
/projects/:projectId
/projects/:projectId/tasks
/projects/:projectId/tasks/:taskId
/board
/people
/calendars
/settings
/workload
/gantt
/changes
/history
/history/:commit
```

- [x] Перенести выбранный проект, задачу, commit и Task status filter в route/query state.
- [ ] Перенести Board filters/saved view и остальные контекстные фильтры в query state по мере реализации соответствующих экранов.
- [x] Реализовать back, forward, deep links и reload restoration.
- [ ] Сгруппировать меню:
  - Планирование: Портфель, Проекты, Задачи, Доска, Гант, Загрузка;
  - Команда: Люди, Календари;
  - Репозиторий: Рабочие копии, Изменения, История, Настройки.
- [ ] Добавить breadcrumbs для проекта, задачи и commit detail.
- [ ] Упростить topbar и перенести абсолютный путь репозитория в подробности.
- [x] Сохранить workspace switcher как глобальный контекст.

### Automated verification

- [x] route parsing and serialization tests;
- [x] deep-link tests;
- [x] browser back/forward tests;
- [x] query-filter restoration tests для Task status;
- [x] responsive navigation tests;
- [x] keyboard focus tests.

### Exit gate

- [ ] URL однозначно описывает весь пользовательский контекст.
- [ ] Перезагрузка страницы не теряет выбранную сущность и все фильтры.
- [x] Browser back/forward работает без рассинхронизации UI.

## UX02. UI Kit, design tokens и UX-контракты

- Size: `M`
- Estimate: `4–6 engineer-days`
- Dependencies: `UX00`
- Responsible: `FE, UX, QA`

### Objective

Создать единый визуальный и поведенческий фундамент для последующих этапов.

### Work packages

- Ввести design tokens для цвета, spacing, typography, radii, elevation и focus.
- Определить breakpoints для mobile, tablet, desktop и wide desktop.
- Создать компоненты `PageHeader`, `Section`, `Card`, `FormField`, `Button`, `ConfirmDialog`, `StatusChip`, `EntityPicker`, `MultiSelect`, `DateRange`, `EmptyState`, `LoadingSkeleton`, `ErrorState`, `Toast` и `OverflowContainer`.
- Убрать feature-layout из глобальных selectors `nav`, `form`, `label`, `input` и `select`.
- Ввести presentation registry для статусов, типов, цветов и entity references.
- Ввести централизованную capability model для edit/archive/delete/publish actions.
- Стандартизировать loading, empty, error, read-only и stale-data состояния.

### Automated verification

- component tests для всех primitives;
- keyboard and focus tests;
- locale tests presentation registry;
- accessibility checks;
- visual snapshots UI Kit.

### Exit gate

- Одинаковые действия имеют одинаковый вид и поведение.
- В пользовательском UI нет raw-slug без явного технического контекста.
- Новые feature screens используют UI Kit и изолированные стили.

## UX03. Проекты, вехи и полноценный редактор задач

- Size: `L`
- Estimate: `7–10 engineer-days`
- Dependencies: `UX01, UX02`
- Responsible: `FE, QA`

### Objective

Дать пользователю возможность полностью управлять данными, от которых зависят Доска, Гант и Загрузка.

### Work packages

- Перевести Проекты и Вехи с множества inline-форм на list-detail layout.
- Явно показывать, к какому проекту относятся вехи.
- Ввести режимы просмотра и редактирования.
- Добавить `Сохранить`, `Отменить` и dirty-state warning.
- Вынести архивные сущности в отдельный фильтр.
- Реализовать полный редактор задачи:
  - заголовок;
  - тип;
  - статус;
  - описание;
  - критерии приёмки;
  - родитель;
  - веха;
  - исполнители;
  - оценка в часах;
  - дата начала;
  - срок;
  - зависимости;
  - метки.
- Разбить форму задачи на блоки `Основное`, `Планирование`, `Исполнители и оценка`, `Связи`, `Описание и критерии`.
- Добавить searchable pickers для исполнителей, родителей и зависимостей.
- Валидировать `start <= due`, ссылки на сущности и циклические зависимости.
- Сохранить quick status change в списке, но локализовать значения.
- Сделать fingerprint conflict понятным и восстанавливаемым.

### Automated verification

- create/update/archive/delete tests для проектов, вех и задач;
- validation tests всех task fields;
- dependency cycle tests;
- stale fingerprint tests;
- external update tests;
- browser flow `задача → доска → Гант → Загрузка`.

### Manual acceptance

1. Создать задачу полностью через UI.
2. Назначить исполнителей, оценку, даты и зависимости.
3. Проверить появление задачи на Доске и в Ганте.
4. Проверить учёт задачи в Загрузке.
5. Изменить задачу внешне и проверить stale-data UX.

### Exit gate

- Для наполнения Ганта и Загрузки не требуется ручное редактирование YAML.
- Все поля schema v1 задачи доступны или явно объявлены read-only по продуктовой причине.

## UX04. Люди, команды, календари и настройки

- Size: `M`
- Estimate: `5–7 engineer-days`
- Dependencies: `UX02`
- Responsible: `FE, QA`

### Objective

Заменить технические и перегруженные административные формы на структурированные редакторы.

### Work packages

- Реализовать list-detail layout для людей и команд.
- Добавить поиск по имени и email.
- Создать searchable multi-select участников команды.
- Показывать количество участников и active/archive state.
- Заменить номера рабочих дней на переключатели Пн–Вс.
- Заменить CSV праздников на список дат с date picker.
- Валидировать дубли и некорректные даты.
- Сделать slug статуса/типа read-only и вторичным.
- Заменить текстовое поле цвета на палитру с preview.
- Добавить изменение порядка статусов и типов.
- Предупреждать при отключении используемого статуса или типа.

### Automated verification

- responsive tests 390–1920 px;
- people/team editor tests;
- member search and selection tests;
- calendar parsing and validation tests;
- status/type preview and ordering tests;
- destructive confirmation tests.

### Exit gate

- На странице нет перекрывающихся форм.
- Для календарей не требуется ввод CSV или номеров дней недели.
- Цвет и пользовательское название статуса видны до сохранения.

## UX05. Портфель, Доска, Гант и Загрузка

- Size: `L`
- Estimate: `6–9 engineer-days`
- Dependencies: `UX01, UX02, UX03`
- Responsible: `FE, QA, UX`

### Objective

Сделать аналитические и планировочные экраны управляемыми, объяснимыми и производительными.

### Work packages

#### Портфель

- Локализовать статусы.
- Добавить progress, ближайшую веху и просроченные элементы.
- Сделать affordance перехода в проект явным.
- Добавить фильтр активных и архивных проектов.

#### Доска

- Перенести сохранённые представления в верхнюю панель.
- Добавить индикаторы и кнопки горизонтальной прокрутки.
- Реализовать клавиатурное перемещение задач.
- Разделить drag affordance и открытие task detail.
- Сохранять фильтры и saved view в URL.

#### Гант

- Добавить масштабы день/неделя/месяц.
- Добавить `Сегодня` и выбор диапазона.
- Добавить легенду задач, вех и зависимостей.
- Использовать единый scroll-контейнер и sticky toolbar.
- Использовать осмысленное кодирование цветом.
- Добавить доступное табличное представление.

#### Загрузка

- Добавить горизонт 4/8/12 недель и начальную дату.
- Добавить фильтр команды и сотрудника.
- Добавить legend и состояния `свободен`, `норма`, `близко к пределу`, `перегружен`.
- Добавить tooltip со списком задач.
- Ограничить объём одновременно отрисовываемых недель.
- Измерить server, network, calculation и render duration.
- Добавлять cache или aggregate endpoint только после измерения bottleneck.

### Performance budgets

- Портфель и Доска на демо: ready state не более 1 секунды.
- Гант и Загрузка на демо: ready state не более 2 секунд.
- Переключение уже загруженного фильтра: не более 150 ms до визуального ответа.

### Automated verification

- model tests для Ганта и Загрузки;
- date-range and zoom tests;
- board keyboard interaction tests;
- filter URL restoration tests;
- performance smoke;
- visual regression wide-data states.

### Exit gate

- Пользователь понимает границы прокрутки и скрытые данные.
- Гант и Загрузка управляются диапазоном, а не показывают весь горизонт сразу.
- Performance budgets выполняются на reference demo.

## UX06. Рабочие копии, Изменения и История

- Size: `M`
- Estimate: `4–6 engineer-days`
- Dependencies: `UX01, UX02`
- Responsible: `FE, QA`

### Objective

Сохранить Git-first возможности, но отделить бизнес-информацию от технических подробностей.

### Work packages

#### Рабочие копии

- Генерировать ID автоматически.
- Перенести ручной ID в блок `Дополнительно`.
- Объяснить UI и external writer modes простым языком.
- Сделать validation count кликабельным.
- Показывать validation issues с переходом к сущности.

#### Изменения

- Убрать дублирующиеся нулевые метрики.
- Сделать empty state компактным.
- Показывать business summary раньше raw diff.
- Перенести raw Git diff в `Технические детали`.
- Удалить устаревшую Alpha-терминологию.
- Объяснять причину disabled commit action.

#### История

- Группировать файлы по проекту и типу сущности.
- Добавить collapse/expand и поиск.
- Показывать пользовательские названия рядом с Git-путями.
- Ставить semantic/business summary выше списка файлов.
- Сделать revert отдельным подтверждаемым сценарием.

### Automated verification

- automatic workspace ID tests;
- validation issue navigation tests;
- changes empty/populated state tests;
- history grouping and search tests;
- revert confirmation tests;
- hostile content and raw diff safety regression.

### Exit gate

- Основные сценарии понятны без знания структуры GitPM-файлов.
- Технические данные остаются доступными, но не доминируют визуально.

## UX07. Accessibility, responsive и hardening

- Size: `M`
- Estimate: `4–6 engineer-days`
- Dependencies: `UX03, UX04, UX05, UX06`
- Responsible: `FE, QA, SEC`

### Objective

Закрепить рефакторинг автоматическими контрактами качества и исключить регрессии.

### Viewport matrix

- 390×844;
- 768×1024;
- 1024×768;
- 1280×720;
- 1440×900;
- 1920×1080.

### Work packages

- Добавить Playwright visual regression для всех 12 разделов.
- Добавить accessibility scan и keyboard-only flows.
- Проверять отсутствие page-level horizontal overflow.
- Проверять deep links, reload и browser back/forward.
- Проверять полный create/edit/archive/delete lifecycle.
- Проверять read-only, Reporter, closed draft и external writer states.
- Проверять loading, empty, error, populated и stale-data states.
- Проверить contrast, focus order, accessible names и reduced motion.
- Провести финальный UX review на reference demo.

### Quality targets

- WCAG AA для текста и интерактивных элементов.
- Все основные операции доступны без мыши.
- Нет page-level horizontal overflow; исключения локализованы внутри Board, Gantt и Workload containers.
- Нет нелокализованных пользовательских значений.
- Нет перекрытий и обрезанных action controls на viewport matrix.
- Performance budgets UX05 остаются зелёными.

### Exit gate

- Все обязательные browser, visual, accessibility и performance проверки проходят.
- Manual acceptance выполнен на русском и английском языках.
- Нет unresolved P0/P1 UX-дефектов.

## 7. Зависимости

```text
UX00
├── UX01 ──┬── UX03 ──┬── UX05 ──┐
│          │          │          │
└── UX02 ──┼── UX04 ──┤          ├── UX07
           │          │          │
           └── UX06 ──┴──────────┘
```

UX01 и UX02 могут выполняться частично параллельно после UX00. UX03 и UX04 могут выполняться параллельно после стабилизации UI Kit. UX06 не должен блокировать UX03–UX05.

## 8. Релизные срезы

### Release A: UX Stabilization

- UX00;
- мобильная навигация;
- исправленная компоновка людей;
- scroll/focus restoration;
- destructive confirmations.

### Release B: Navigation Foundation

- UX01;
- основная часть UX02;
- маршруты, deep links, App Shell и базовый UI Kit.

### Release C: Editable Domain

- UX03;
- UX04;
- полный редактор задач и структурированные административные редакторы.

### Release D: Planning Experience

- UX05;
- управляемые Портфель, Доска, Гант и Загрузка.

### Release E: Git Experience

- UX06;
- упрощённые Рабочие копии, Изменения и История.

### Release F: Hardening

- UX07;
- responsive, accessibility, visual regression и performance gates.

## 9. Сквозные acceptance flows

### Flow 1. Создание и планирование задачи

1. Открыть проект по deep link.
2. Создать задачу с типом, статусом, исполнителем, оценкой и датами.
3. Добавить зависимость и веху.
4. Проверить задачу на Доске.
5. Проверить задачу в Ганте.
6. Проверить нагрузку исполнителя.
7. Перезагрузить страницу и убедиться, что контекст сохранён.

### Flow 2. Управление командой

1. Создать календарь через weekday controls и date picker.
2. Создать сотрудника с ёмкостью и календарём.
3. Добавить сотрудника в команду через поиск.
4. Отфильтровать Загрузку по команде.
5. Архивировать сотрудника и проверить понятную реакцию зависимых экранов.

### Flow 3. Git workflow

1. Изменить несколько сущностей через UI.
2. Открыть business summary Изменений.
3. При необходимости открыть raw diff.
4. Создать commit.
5. Открыть его в Истории.
6. Найти изменённую сущность через группировку.
7. Создать отдельную рабочую копию для revert.

### Flow 4. Responsive navigation

1. Открыть приложение на 390 px.
2. Перейти последовательно по всем смысловым группам меню.
3. Открыть проект и задачу.
4. Использовать back/forward.
5. Повторить операции только клавиатурой.

## 10. Основные риски

### Route migration

Риск: потеря текущего draft/project/task context при переходе с локального React state на URL.

Митигация: ввести route adapter, мигрировать разделы по одному и добавить deep-link tests до удаления старого состояния.

### Fingerprint conflicts

Риск: длинные формы увеличат вероятность сохранения устаревшего документа.

Митигация: dirty-state, stale-data banner, reload-and-compare flow и field-level external update indication.

### Перегруженный редактор задачи

Риск: отображение всей schema v1 в одной форме ухудшит UX.

Митигация: progressive disclosure, смысловые секции и компактный summary в режиме просмотра.

### Performance optimization without evidence

Риск: преждевременное добавление aggregate API или cache усложнит архитектуру.

Митигация: сначала измерить server/network/calculation/render phases, затем оптимизировать подтверждённый bottleneck.

### Долгая миграция CSS

Риск: одновременное существование старых global styles и новых modules вызовет визуальные регрессии.

Митигация: мигрировать route-by-route, namespace legacy styles и удалять global rules только после visual regression coverage.

## 11. Рекомендуемый порядок первых коммитов

1. `fix(web): restore responsive navigation and scroll position`
2. `fix(web): prevent people administration layout overlap`
3. `fix(web): confirm destructive entity actions`
4. `refactor(web): introduce app shell and route model`
5. `refactor(web): add design tokens and UI primitives`
6. `refactor(web): centralize domain presentation and permissions`
7. `feat(web): implement complete task editor`
8. `refactor(web): rebuild people teams and calendars editors`
9. `refactor(web): improve planning views and workload horizon`
10. `refactor(web): simplify changes and history experience`
11. `test(web): add responsive visual and accessibility gates`

## 12. Итоговый критерий успеха

Рефакторинг считается завершённым, когда пользователь без знания YAML и внутренней структуры GitPM может:

- открыть любой раздел на desktop, tablet или mobile;
- создать проект, веху и полностью заполненную задачу;
- назначить людей, даты, оценку и зависимости;
- увидеть согласованные данные на Доске, в Ганте и Загрузке;
- понять и опубликовать изменения;
- найти commit и подготовить revert;
- безопасно архивировать или удалить сущность;
- восстановить текущий контекст через URL, reload и browser history.
