import type { ExportLocale } from "./types.js";

export interface CopyText {
  readonly title: string;
  readonly portfolio: string;
  readonly projects: string;
  readonly people: string;
  readonly person: string;
  readonly projectPlan: string;
  readonly projectDetails: string;
  readonly gantt: string;
  readonly planFact: string;
  readonly workload: string;
  readonly vacations: string;
  readonly personProfile: string;
  readonly audit: string;
  readonly tasks: string;
  readonly milestones: string;
  readonly teams: string;
  readonly calendars: string;
  readonly calendar: string;
  readonly capacity: string;
  readonly status: string;
  readonly owner: string;
  readonly due: string;
  readonly risk: string;
  readonly riskOnTrack: string;
  readonly riskNear: string;
  readonly riskOverdue: string;
  readonly riskUnknown: string;
  readonly unassigned: string;
  readonly ungrouped: string;
  readonly activeProjects: string;
  readonly activeTasks: string;
  readonly activeMilestones: string;
  readonly completedTasks: string;
  readonly assignees: string;
  readonly schedule: string;
  readonly actual: string;
  readonly plan: string;
  readonly variance: string;
  readonly category: string;
  readonly date: string;
  readonly hours: string;
  readonly week: string;
  readonly allocated: string;
  readonly available: string;
  readonly overload: string;
  readonly exclusions: string;
  readonly archived: string;
  readonly undated: string;
  readonly unestimated: string;
  readonly unavailable: string;
  readonly kind: string;
  readonly state: string;
  readonly note: string;
  readonly taken: string;
  readonly planned: string;
  readonly remaining: string;
  readonly allowance: string;
  readonly absentToday: string;
  readonly leavingSoon: string;
  readonly overlap: string;
  readonly comments: string;
  readonly files: string;
  readonly history: string;
  readonly voided: string;
  readonly author: string;
  readonly subject: string;
  readonly email: string;
  readonly hoursPerWeek: string;
  readonly noData: string;
  readonly generated: string;
  readonly commit: string;
  readonly board: string;
  readonly dependencies: string;
  readonly track: string;
}

export const COPY: Readonly<Record<ExportLocale, CopyText>> = {
  en: {
    title: "GitPM portfolio",
    portfolio: "Portfolio",
    projects: "Projects",
    people: "People",
    person: "Person",
    projectPlan: "Project plan",
    projectDetails: "Project details",
    gantt: "Gantt",
    planFact: "Plan versus actual",
    workload: "Team workload",
    vacations: "Time off",
    personProfile: "Person profile",
    audit: "Audit",
    tasks: "Tasks",
    milestones: "Milestones",
    teams: "Teams",
    calendars: "Calendars",
    calendar: "Calendar",
    capacity: "Weekly capacity (hours)",
    status: "Status",
    owner: "Project owner",
    due: "Due date",
    risk: "Risk",
    riskOnTrack: "On track",
    riskNear: "Due soon",
    riskOverdue: "Overdue",
    riskUnknown: "No due date",
    unassigned: "Unassigned",
    ungrouped: "Ungrouped",
    activeProjects: "Active projects",
    activeTasks: "Active tasks",
    activeMilestones: "Active milestones",
    completedTasks: "Completed tasks",
    assignees: "Assignees",
    schedule: "Schedule",
    actual: "Actual",
    plan: "Plan",
    variance: "Variance",
    category: "Category",
    date: "Date",
    hours: "Hours",
    week: "Week",
    allocated: "Allocated",
    available: "Capacity",
    overload: "Overload",
    exclusions: "Excluded tasks",
    archived: "Archived",
    undated: "Undated",
    unestimated: "Unestimated",
    unavailable: "Unavailable assignees",
    kind: "Kind",
    state: "State",
    note: "Note",
    taken: "Taken",
    planned: "Planned",
    remaining: "Remaining",
    allowance: "Allowance",
    absentToday: "Absent today",
    leavingSoon: "Leaving soon",
    overlap: "Max overlap",
    comments: "Comments",
    files: "Files",
    history: "Change history",
    voided: "Voided time entries",
    author: "Author",
    subject: "Subject",
    email: "Email",
    hoursPerWeek: "h/week",
    noData: "No data",
    generated: "Generated",
    commit: "Commit",
    board: "Board",
    dependencies: "Dependencies",
    track: "Track",
  },
  ru: {
    title: "Портфель GitPM",
    portfolio: "Портфель",
    projects: "Проекты",
    people: "Люди",
    person: "Сотрудник",
    projectPlan: "План проекта",
    projectDetails: "Подробности проектов",
    gantt: "Гант",
    planFact: "План-факт",
    workload: "Загрузка команды",
    vacations: "Отпуска и отсутствия",
    personProfile: "Профиль сотрудника",
    audit: "Аудит",
    tasks: "Задачи",
    milestones: "Этапы",
    teams: "Команды",
    calendars: "Календари",
    calendar: "Календарь",
    capacity: "Недельная ёмкость (часы)",
    status: "Статус",
    owner: "Ответственный за проект",
    due: "Срок",
    risk: "Риск",
    riskOnTrack: "По плану",
    riskNear: "Срок близко",
    riskOverdue: "Просрочен",
    riskUnknown: "Без срока",
    unassigned: "Не назначен",
    ungrouped: "Без группы",
    activeProjects: "Активных проектов",
    activeTasks: "Активных задач",
    activeMilestones: "Активных этапов",
    completedTasks: "Завершённых задач",
    assignees: "Исполнители",
    schedule: "Сроки",
    actual: "Факт",
    plan: "План",
    variance: "Отклонение",
    category: "Категория",
    date: "Дата",
    hours: "Часы",
    week: "Неделя",
    allocated: "Назначено",
    available: "Ёмкость",
    overload: "Перегрузка",
    exclusions: "Исключённые задачи",
    archived: "Архив",
    undated: "Без дат",
    unestimated: "Без оценки",
    unavailable: "Недоступные исполнители",
    kind: "Тип",
    state: "Состояние",
    note: "Заметка",
    taken: "Использовано",
    planned: "Запланировано",
    remaining: "Остаток",
    allowance: "Норма",
    absentToday: "Отсутствуют сегодня",
    leavingSoon: "Скоро уйдут",
    overlap: "Макс. пересечение",
    comments: "Комментарии",
    files: "Файлы",
    history: "История изменений",
    voided: "Аннулированные трудозатраты",
    author: "Автор",
    subject: "Тема",
    email: "Email",
    hoursPerWeek: "ч/нед.",
    noData: "Нет данных",
    generated: "Сформировано",
    commit: "Коммит",
    board: "Доска",
    dependencies: "Зависимости",
    track: "Дорожка",
  },
};

export const ABSENCE_KIND: Readonly<Record<ExportLocale, Readonly<Record<string, string>>>> = {
  en: { vacation: "Vacation", "day-off": "Day off", "sick-leave": "Sick leave", training: "Training", other: "Other" },
  ru: { vacation: "Отпуск", "day-off": "Отгул", "sick-leave": "Больничный", training: "Обучение", other: "Другое" },
};

export const ABSENCE_STATE: Readonly<Record<ExportLocale, Readonly<Record<string, string>>>> = {
  en: { planned: "Planned", taken: "Taken", cancelled: "Cancelled" },
  ru: { planned: "Запланировано", taken: "Использовано", cancelled: "Отменено" },
};

export function copyFor(locale: ExportLocale): CopyText {
  return COPY[locale];
}

export function absenceKindLabel(locale: ExportLocale, kind: string): string {
  return ABSENCE_KIND[locale][kind] ?? kind;
}

export function absenceStateLabel(locale: ExportLocale, state: string): string {
  return ABSENCE_STATE[locale][state] ?? state;
}
