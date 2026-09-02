import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEventHandler, type FormEvent, type ReactNode } from "react";
import { activeProjectIds, ENTITY_ID_PREFIX, isOperationalTask, newUniqueEntityId, personNameSearchText } from "@gitpm/shared";
import { buildTaskHierarchy } from "@gitpm/task-hierarchy";
import { formatApiError, type GitPmApi } from "./api.js";
import { formatDateOnly, formatDurationHours, message, type Locale, type MessageKey } from "./i18n.js";
import type { ConfigurationResult, DraftStatus, EntityDocument, EntityResult, GitPmDocument, ProjectPlanning } from "./types.js";
import { changedEntityFields, useExternalHighlights, useReducedMotion } from "./external-updates.js";
import { AsyncBoundary, useAsyncLoad } from "./async-data.js";
import type { WorkspaceNavigate } from "./workspace-navigation.js";
import { EntityCatalog } from "./entity-catalog.js";
import { EditorDrawer } from "./editor-drawer.js";
import { upsertEntity } from "./optimistic-ui.js";
import { PersonLinks } from "./person-link.js";
import { ProjectLink } from "./project-link.js";
import { MilestoneLink } from "./milestone-link.js";
import { TaskComments } from "./task-comments-ui.js";
import { TaskTimeEntries } from "./task-time-entries.js";
import { scheduleEffort, scheduleText, ScheduleResolver, scheduleTracksConfig, withSchedulesMap, type ScheduleMap } from "./schedules.js";
import { ScheduleTracksEditor } from "./schedule-tracks-editor.js";
import { isCompletedStatus, type StatusCategory } from "./status-categories.js";
import { DraftReadOnlyAlert, draftReadOnlyReason } from "./draft-read-only.js";
import { AdvancedViewControls, type QuickViewPreset } from "./advanced-view-controls.js";
import { applyAdvancedViewQuery, countViewConditions, defaultLifecycleViewQuery, filterOnlyViewQuery, newViewNodeId, parseAdvancedViewQuery, serializeAdvancedViewQuery, type AdvancedViewQuery, type ViewField, type ViewFilterOperator } from "./advanced-view-query.js";
import { ProjectFileMarkdownField, type ProjectFileReferenceContext } from "./project-file-reference-ui.js";
import { SafeMarkdown } from "./safe-markdown.js";
import { PortfolioTaskTable } from "./portfolio-task-table.js";
import { useDefaultPersonNameFormat, usePersonNameFormatter } from "./person-name.js";

export { SafeMarkdown } from "./safe-markdown.js";

const stringValue = (document: GitPmDocument, key: string) => typeof document[key] === "string" ? document[key] as string : "";
const effortString = (document: GitPmDocument, track: string): string => { const effort = scheduleEffort(document, track); return typeof effort === "number" ? String(effort) : ""; };
const values = (document: GitPmDocument, key: string): string[] => Array.isArray(document[key]) ? (document[key] as unknown[]).filter((item): item is string => typeof item === "string") : [];
export interface ConfigValue { readonly slug: string; readonly title: string; readonly active: boolean; readonly category?: StatusCategory }
interface MutationFeedback { readonly kind: "saving" | "saved" | "undone"; readonly text: string }
type CoreCreateEditor = "project" | "task" | null;
const configValues = (document: GitPmDocument, key: "statuses" | "issue_types"): ConfigValue[] => Array.isArray(document[key]) ? (document[key] as unknown[]).filter((item): item is ConfigValue => typeof item === "object" && item !== null && typeof (item as ConfigValue).slug === "string" && typeof (item as ConfigValue).title === "string" && (item as ConfigValue).active === true) : [];
const NEW_PROJECT_GROUP = "__new__";

const localCalendarDate = (date: Date = new Date()): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const portfolioTaskPresetQuery = (field: string, operator: ViewFilterOperator): AdvancedViewQuery => ({
  filter: {
    kind: "group",
    id: newViewNodeId("group"),
    combinator: "and",
    children: [
      { kind: "condition", id: newViewNodeId("condition"), field: "lifecycle", operator: "equals", value: "active" },
      { kind: "condition", id: newViewNodeId("condition"), field, operator },
    ],
  },
  sort: [],
});

export interface ProjectGroupSection {
  readonly key: string;
  readonly title: string;
  readonly projects: readonly EntityResult[];
  readonly isUngrouped: boolean;
}

export type ScheduleTextReader = (document: Readonly<Record<string, unknown>>, key: string) => string;

export function existingProjectGroups(projects: readonly EntityResult[], locale: Locale): string[] {
  return [...new Set(projects.map((project) => stringValue(project.document, "group").trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, locale));
}

export function groupProjects(projects: readonly EntityResult[], locale: Locale, ungroupedTitle: string, compareProjects?: (left: EntityResult, right: EntityResult) => number): ProjectGroupSection[] {
  const named = new Map<string, EntityResult[]>();
  const ungrouped: EntityResult[] = [];
  for (const project of projects) {
    const group = stringValue(project.document, "group").trim();
    if (group === "") ungrouped.push(project);
    else named.set(group, [...(named.get(group) ?? []), project]);
  }
  const byName = compareProjects ?? ((left: EntityResult, right: EntityResult) =>
    stringValue(left.document, "name").localeCompare(stringValue(right.document, "name"), locale));
  const sections = [...named.entries()]
    .sort(([left], [right]) => left.localeCompare(right, locale))
    .map(([title, items]) => ({
      key: `group:${title}`,
      title,
      projects: [...items].sort(byName),
      isUngrouped: false,
    }));
  if (ungrouped.length > 0) {
    sections.push({
      key: "ungrouped",
      title: ungroupedTitle,
      projects: [...ungrouped].sort(byName),
      isUngrouped: true,
    });
  }
  return sections;
}

function groupOptionValue(group: string, groups: readonly string[]): string {
  const index = groups.indexOf(group.trim());
  return index < 0 ? "" : `group:${index}`;
}

export function projectGroupFromForm(data: FormData, groups: readonly string[]): { readonly valid: boolean; readonly group: string; readonly duplicate: boolean } {
  const selected = String(data.get("group") ?? "");
  if (selected === "") return { valid: true, group: "", duplicate: false };
  if (selected === NEW_PROJECT_GROUP) {
    const group = String(data.get("newGroup") ?? "").trim();
    if (group === "" || [...group].length > 100) return { valid: false, group, duplicate: false };
    const duplicate = groups.includes(group);
    return { valid: !duplicate, group, duplicate };
  }
  const match = /^group:(\d+)$/u.exec(selected);
  const group = match === null ? undefined : groups[Number(match[1])];
  return group === undefined ? { valid: false, group: "", duplicate: false } : { valid: true, group, duplicate: false };
}

export function ProjectGroupField({ currentGroup = "", disabled, groups, t }: {
  readonly currentGroup?: string;
  readonly disabled: boolean;
  readonly groups: readonly string[];
  readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string;
}) {
  const [selected, setSelected] = useState(groupOptionValue(currentGroup, groups));
  const [newGroup, setNewGroup] = useState("");
  useEffect(() => {
    setSelected(groupOptionValue(currentGroup, groups));
    setNewGroup("");
  }, [currentGroup, groups]);
  const duplicate = selected === NEW_PROJECT_GROUP && groups.includes(newGroup.trim());
  return <>
    <label>{t("core.group")}<select disabled={disabled} name="group" onChange={(event) => setSelected(event.target.value)} value={selected}>
      <option value="">{t("core.noGroup")}</option>
      {groups.map((group, index) => <option key={group} value={`group:${index}`}>{group}</option>)}
      <option value={NEW_PROJECT_GROUP}>{t("core.createNewGroup")}</option>
    </select></label>
    {selected === NEW_PROJECT_GROUP && <label>{t("core.newGroupName")}<input disabled={disabled} maxLength={100} name="newGroup" onChange={(event) => setNewGroup(event.target.value)} pattern=".*\S.*" required value={newGroup} />{duplicate && <small className="field-error" role="alert">{t("core.groupAlreadyExists")}</small>}</label>}
  </>;
}

export { newEntityId } from "@gitpm/shared";

export type CoreSurface = "projects" | "tasks";

type ProjectRiskLevel = "onTrack" | "near" | "overdue" | "unknown";

export function CoreWorkspace({ api, draft, locale, surface = "projects", initialProjectId = "", initialTaskId = "", initialCommentId = "", initialStatusFilter = "", initialMilestoneFilter = "", initialAdvancedQuery, onNavigate = () => undefined, confirmAction = () => true, onChanged }: {
  readonly api: GitPmApi;
  readonly draft: DraftStatus;
  readonly locale: Locale;
  readonly surface?: CoreSurface;
  readonly initialProjectId?: string;
  readonly initialTaskId?: string;
  readonly initialCommentId?: string;
  readonly initialStatusFilter?: string;
  readonly initialMilestoneFilter?: string;
  readonly initialAdvancedQuery?: string;
  readonly onNavigate?: WorkspaceNavigate;
  readonly confirmAction?: (message: string) => boolean;
  readonly onChanged: () => Promise<void>;
}) {
  const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => message(locale, key, values);
  const personName = usePersonNameFormatter();
  const [projects, setProjects] = useState<readonly EntityResult[]>([]);
  const [milestones, setMilestones] = useState<readonly EntityResult[]>([]);
  const [tasks, setTasks] = useState<readonly EntityResult[]>([]);
  const [people, setPeople] = useState<readonly EntityResult[]>([]);
  const [projectId, setProjectId] = useState<string>(initialProjectId);
  const [selectedTask, setSelectedTask] = useState<string>(initialTaskId);
  const [filter, setFilter] = useState(initialStatusFilter);
  const [milestoneFilter, setMilestoneFilter] = useState(initialMilestoneFilter);
  const [advancedQuery, setAdvancedQuery] = useState<AdvancedViewQuery>(() => defaultLifecycleViewQuery());
  const [hasExplicitAdvancedQuery, setHasExplicitAdvancedQuery] = useState(initialAdvancedQuery !== undefined);
  const [fingerprint, setFingerprint] = useState(draft.fingerprint);
  const [error, setError] = useState<string | null>(null);
  const [statusOptions, setStatusOptions] = useState<readonly ConfigValue[]>([]);
  const [typeOptions, setTypeOptions] = useState<readonly ConfigValue[]>([]);
  const [tracksConfig, setTracksConfig] = useState<ConfigurationResult | null>(null);
  const [feedback, setFeedback] = useState<MutationFeedback | null>(null);
  const [createEditor, setCreateEditor] = useState<CoreCreateEditor>(null);
  const [createSchedules, setCreateSchedules] = useState<ScheduleMap | undefined>(undefined);
  const [statusPending, setStatusPending] = useState<string | null>(null);
  const previousEntities = useRef<readonly EntityResult[]>([]);
  const lastExternalFingerprint = useRef(draft.external_fingerprint);
  const loadRequest = useAsyncLoad();
  const { highlights: externalHighlights, mark: markExternal } = useExternalHighlights();
  const { highlights: localHighlights, mark: markLocal } = useExternalHighlights(500);
  const highlights = { ...externalHighlights, ...localHighlights };
  const reducedMotion = useReducedMotion();
  const readOnly = draftReadOnlyReason(draft) !== null;
  const acknowledgeExternalChanges = () => {
    setError(null);
    void api.acknowledgeExternalChanges(draft.draft_id)
      .then(async () => await onChanged())
      .catch((caught: unknown) => setError(formatApiError(caught)));
  };

  const load = useCallback(async (preferredProject = projectId, externalUpdate = false) => {
    await loadRequest.run(async () => {
      const [nextProjects, nextPeople, statusConfig, typeConfig, tracksDocument] = await Promise.all([api.listEntities(draft.draft_id, "projects"), api.listEntities(draft.draft_id, "people"), api.getConfiguration(draft.draft_id, "statuses"), api.getConfiguration(draft.draft_id, "issue-types"), api.getConfiguration(draft.draft_id, "schedule-tracks")]);
      const nextProject = surface === "projects" ? "" : nextProjects.some((item) => item.document.id === preferredProject && item.document.lifecycle === "active") ? preferredProject : "";
      const [nextMilestones, nextTasks] = await Promise.all([
        api.listEntities(draft.draft_id, "milestones"),
        api.listEntities(draft.draft_id, "tasks", surface === "tasks" && nextProject !== "" ? nextProject : undefined),
      ]);
      return { nextProjects, nextPeople, nextProject, nextMilestones, nextTasks, statusConfig, typeConfig, tracksDocument };
    }, ({ nextProjects, nextPeople, nextProject, nextMilestones, nextTasks, statusConfig, typeConfig, tracksDocument }) => {
      const nextEntities = [...nextProjects, ...nextPeople, ...nextMilestones, ...nextTasks];
      if (externalUpdate) markExternal(changedEntityFields(previousEntities.current, nextEntities));
      previousEntities.current = nextEntities;
      setProjects(nextProjects); setPeople(nextPeople); setProjectId(nextProject); setMilestones(nextMilestones); setTasks(nextTasks);
      setStatusOptions(configValues(statusConfig.document, "statuses")); setTypeOptions(configValues(typeConfig.document, "issue_types"));
      setTracksConfig(tracksDocument);
      setFingerprint(nextProjects[0]?.draft_fingerprint ?? nextMilestones[0]?.draft_fingerprint ?? nextTasks[0]?.draft_fingerprint ?? draft.fingerprint);
    }, { keepData: true });
  }, [api, draft.draft_id, draft.fingerprint, loadRequest.run, markExternal, projectId, surface]);

  useEffect(() => { setSelectedTask(initialTaskId); void load(initialProjectId); }, [draft.draft_id, surface]);
  useEffect(() => { setFilter(initialStatusFilter); setMilestoneFilter(initialMilestoneFilter); }, [initialMilestoneFilter, initialStatusFilter]);
  useEffect(() => {
    if (draft.writer_mode !== "external" || draft.external_fingerprint === undefined || draft.external_fingerprint === lastExternalFingerprint.current) return;
    lastExternalFingerprint.current = draft.external_fingerprint;
    void load(projectId, true);
  }, [draft.external_fingerprint]);

  const scheduling = useMemo(() => new ScheduleResolver(scheduleTracksConfig(tracksConfig?.document)), [tracksConfig]);
  const projectPlanningById = useMemo(() => {
    const map = new Map<string, ProjectPlanning>();
    for (const project of projects) {
      const id = typeof project.document.id === "string" ? project.document.id : "";
      const planning = project.document.planning;
      if (id !== "" && planning !== undefined && typeof planning === "object") map.set(id, planning as ProjectPlanning);
    }
    return map;
  }, [projects]);
  const trackOf = useCallback((document: Readonly<Record<string, unknown>>): string => {
    const id = document.schema === "gitpm/project@2" ? (typeof document.id === "string" ? document.id : "") : (typeof document.project === "string" ? document.project : "");
    return scheduling.primaryTrack(projectPlanningById.get(id));
  }, [projectPlanningById, scheduling]);
  const value = useCallback((document: Readonly<Record<string, unknown>>, key: string): string =>
    key === "start" || key === "due" ? scheduleText(document, key, trackOf(document)) : stringValue(document as GitPmDocument, key), [trackOf]);
  const effortOf = useCallback((document: Readonly<Record<string, unknown>>): number | undefined => scheduleEffort(document, trackOf(document)), [trackOf]);
  const effortStringOf = useCallback((document: Readonly<Record<string, unknown>>): string => { const effort = effortOf(document); return typeof effort === "number" ? String(effort) : ""; }, [effortOf]);

  const mutate = async (operation: () => Promise<EntityResult>, preferredProject = projectId) => {
    setError(null); setFeedback({ kind: "saving", text: t("feedback.saving") });
    try {
      const result = await operation(); setFingerprint(result.draft_fingerprint);
      if (result.document.schema === "gitpm/project@2") setProjects((current) => upsertEntity(current, result));
      if (result.document.schema === "gitpm/person@1") setPeople((current) => upsertEntity(current, result));
      if (result.document.schema === "gitpm/milestone@2") setMilestones((current) => upsertEntity(current, result));
      if (result.document.schema === "gitpm/task@2") setTasks((current) => upsertEntity(current, result));
      markLocal({ [result.document.id]: ["$local"] }); await onChanged(); await load(preferredProject); setFeedback({ kind: "saved", text: t("feedback.saved") }); return result;
    }
    catch (caught) { setFeedback(null); setError(formatApiError(caught)); return null; }
  };
  const remove = async (operation: () => Promise<void>) => {
    setError(null); setFeedback({ kind: "saving", text: t("feedback.saving") });
    try { await operation(); await load(); await onChanged(); setFeedback({ kind: "saved", text: t("feedback.saved") }); return true; } catch (caught) { setFeedback(null); setError(formatApiError(caught)); return false; }
  };
  const changeTaskStatus = (task: EntityResult, status: string) => {
    if (statusPending !== null || value(task.document, "status") === status) return;
    const previous = tasks;
    const document = { ...task.document, status } as EntityDocument;
    setStatusPending(task.document.id);
    setTasks(upsertEntity(tasks, { ...task, document }));
    void mutate(async () => { const result = await api.updateEntity(draft.draft_id, "tasks", task, fingerprint, document); setStatusPending(null); return result; })
      .then((result) => { if (result === null) setTasks(previous); })
      .finally(() => setStatusPending(null));
  };
  const projectTrack = (id: string): string => scheduling.primaryTrack(projectPlanningById.get(id));

  const activeProjects = projects.filter((item) => item.document.lifecycle === "active");
  const activeMilestones = milestones.filter((item) => item.document.lifecycle === "active");
  const operationalProjectIds = activeProjectIds(activeProjects.map((project) => project.document));
  const activeTasks = tasks.filter((item) => isOperationalTask(item.document, operationalProjectIds));
  const createPlanning = projectPlanningById.get(projectId);
  const createManualTracks = scheduling.manualTracks(createPlanning);
  const createActualTrack = scheduling.actualTrack(createPlanning);
  const createDependencyOptions = tasks.filter((item) => item.document.lifecycle === "active" && item.document.project === projectId);
  useEffect(() => { if (createEditor === "task") setCreateSchedules(undefined); }, [createEditor]);
  const projectRisk = useCallback((project: EntityResult): ProjectRiskLevel => {
    const due = value(project.document, "due");
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(due)) return "unknown";
    const days = Math.ceil((Date.parse(`${due}T00:00:00Z`) - Date.now()) / 86_400_000);
    return days < 0 ? "overdue" : days <= 14 ? "near" : "onTrack";
  }, [value]);
  const existingGroups = useMemo(() => existingProjectGroups(projects, locale), [projects, locale]);
  const peopleOptions = useMemo(() => people.map((person) => ({ value: person.document.id, label: personName(person.document) })).sort((left, right) => left.label.localeCompare(right.label, locale)), [people, locale, personName]);
  const lifecycleOptions = useMemo(() => [{ value: "active", label: t("core.lifecycleActive") }, { value: "archived", label: t("core.lifecycleArchived") }], [locale]);
  const projectFields = useMemo<readonly ViewField<EntityResult>[]>(() => [
    { id: "id", label: t("advancedView.field.id"), type: "text", read: (item) => item.document.id },
    { id: "name", label: t("advancedView.field.name"), type: "text", read: (item) => value(item.document, "name") },
    { id: "group", label: t("advancedView.field.group"), type: "text", read: (item) => value(item.document, "group") },
    { id: "owner", label: t("advancedView.field.owner"), type: "select", options: peopleOptions, read: (item) => value(item.document, "owner") },
    { id: "status", label: t("advancedView.field.status"), type: "select", options: statusOptions.map((status) => ({ value: status.slug, label: status.title })), read: (item) => value(item.document, "status") },
    { id: "lifecycle", label: t("advancedView.field.lifecycle"), type: "select", options: lifecycleOptions, read: (item) => item.document.lifecycle },
    { id: "start", label: t("advancedView.field.start"), type: "date", read: (item) => value(item.document, "start") },
    { id: "due", label: t("advancedView.field.due"), type: "date", read: (item) => value(item.document, "due") },
    { id: "overdue", label: t("advancedView.field.overdue"), type: "boolean", hint: t("advancedView.field.projectOverdueHint"), read: (item) => projectRisk(item) === "overdue" },
    { id: "risk", label: t("advancedView.field.risk"), type: "select", options: [{ value: "onTrack", label: t("core.riskOnTrack") }, { value: "near", label: t("core.riskNear") }, { value: "overdue", label: t("core.riskOverdue") }, { value: "unknown", label: t("core.riskUnknown") }], read: projectRisk },
    { id: "tasks", label: t("advancedView.field.tasks"), type: "number", read: (item) => activeTasks.filter((task) => task.document.project === item.document.id).length },
    { id: "milestones", label: t("advancedView.field.milestones"), type: "number", read: (item) => activeMilestones.filter((milestone) => milestone.document.project === item.document.id).length },
  ], [activeMilestones, activeTasks, lifecycleOptions, locale, peopleOptions, projectRisk, statusOptions, value]);
  const filteredProjects = useMemo(() => applyAdvancedViewQuery(projects, projectFields, advancedQuery, locale), [advancedQuery, locale, projectFields, projects]);
  const projectGroupSections = useMemo(
    () => groupProjects(
      filteredProjects,
      locale,
      message(locale, "core.ungroupedProjects"),
    ),
    [filteredProjects, locale],
  );
  const statusTitle = (slug: string) => statusOptions.find((item) => item.slug === slug)?.title ?? slug;
  const confirmDelete = (name: string) => confirmAction(t("core.deleteConfirm", { name }));
  const today = localCalendarDate();
  const taskDepthById = useMemo(() => {
    const hierarchy = buildTaskHierarchy(tasks.map((item) => ({ id: item.document.id, ...(value(item.document, "parent") === "" ? {} : { parent: value(item.document, "parent") }) })));
    return new Map(tasks.map((item) => [item.document.id, hierarchy.depthOf(item.document.id)] as const));
  }, [tasks, value]);
  const nextPortfolioTaskIds = useMemo(() => {
    const nextByProject = new Map<string, EntityResult>();
    const comparePriority = (left: EntityResult, right: EntityResult) => {
      const leftDue = value(left.document, "due") || "9999-12-31";
      const rightDue = value(right.document, "due") || "9999-12-31";
      if (leftDue !== rightDue) return leftDue.localeCompare(rightDue);
      const leftStart = value(left.document, "start") || "9999-12-31";
      const rightStart = value(right.document, "start") || "9999-12-31";
      return leftStart.localeCompare(rightStart)
        || value(left.document, "title").localeCompare(value(right.document, "title"), locale)
        || left.document.id.localeCompare(right.document.id);
    };
    for (const task of activeTasks) {
      if (isCompletedStatus(statusOptions, value(task.document, "status"))) continue;
      const taskProject = value(task.document, "project");
      const current = nextByProject.get(taskProject);
      if (current === undefined || comparePriority(task, current) < 0) nextByProject.set(taskProject, task);
    }
    return new Set([...nextByProject.values()].map((task) => task.document.id));
  }, [activeTasks, locale, statusOptions, value]);
  const taskFields = useMemo<readonly ViewField<EntityResult>[]>(() => [
    { id: "id", label: t("advancedView.field.id"), type: "text", read: (item) => item.document.id },
    { id: "title", label: t("advancedView.field.title"), type: "text", read: (item) => value(item.document, "title") },
    { id: "project", label: t("advancedView.field.project"), type: "select", options: projects.map((project) => ({ value: project.document.id, label: value(project.document, "name") || project.document.id })), read: (item) => value(item.document, "project") },
    { id: "milestone", label: t("advancedView.field.milestone"), type: "select", options: milestones.map((milestone) => ({ value: milestone.document.id, label: value(milestone.document, "name") || milestone.document.id })), read: (item) => value(item.document, "milestone") },
    { id: "status", label: t("advancedView.field.status"), type: "select", options: statusOptions.map((status) => ({ value: status.slug, label: status.title })), read: (item) => value(item.document, "status") },
    { id: "type", label: t("advancedView.field.type"), type: "select", options: typeOptions.map((type) => ({ value: type.slug, label: type.title })), read: (item) => value(item.document, "type") },
    { id: "parent", label: t("advancedView.field.parent"), type: "text", read: (item) => value(item.document, "parent") },
    { id: "depth", label: t("advancedView.field.depth"), type: "number", read: (item) => taskDepthById.get(item.document.id) ?? 0 },
    { id: "assignees", label: t("advancedView.field.assignees"), type: "multi-select", options: peopleOptions, read: (item) => values(item.document, "assignees") },
    { id: "lifecycle", label: t("advancedView.field.lifecycle"), type: "select", options: lifecycleOptions, read: (item) => isOperationalTask(item.document, operationalProjectIds) ? "active" : "archived" },
    { id: "start", label: t("advancedView.field.start"), type: "date", read: (item) => value(item.document, "start") },
    { id: "due", label: t("advancedView.field.due"), type: "date", read: (item) => value(item.document, "due") },
    { id: "estimate", label: t("advancedView.field.estimate"), type: "number", read: (item) => effortOf(item.document) },
    { id: "overdue", label: t("advancedView.field.overdue"), type: "boolean", hint: t("portfolioTasks.presetOverdueHint"), read: (item) => { const due = value(item.document, "due"); return /^\d{4}-\d{2}-\d{2}$/u.test(due) && due < today && !isCompletedStatus(statusOptions, value(item.document, "status")); } },
    { id: "nextProjectTask", label: t("portfolioTasks.presetNext"), type: "boolean", hint: t("portfolioTasks.presetNextHint"), read: (item) => nextPortfolioTaskIds.has(item.document.id) },
  ], [effortOf, lifecycleOptions, locale, milestones, nextPortfolioTaskIds, operationalProjectIds, peopleOptions, projects, statusOptions, taskDepthById, today, typeOptions, value]);
  const portfolioTaskPresets = useMemo<readonly QuickViewPreset[]>(() => [
    { id: "portfolio-overdue", label: t("portfolioTasks.presetOverdue"), hint: t("portfolioTasks.presetOverdueHint"), query: portfolioTaskPresetQuery("overdue", "is-true") },
    { id: "portfolio-next", label: t("portfolioTasks.presetNext"), hint: t("portfolioTasks.presetNextHint"), query: portfolioTaskPresetQuery("nextProjectTask", "is-true") },
    { id: "portfolio-unassigned", label: t("portfolioTasks.presetUnassigned"), hint: t("portfolioTasks.presetUnassignedHint"), query: portfolioTaskPresetQuery("assignees", "is-empty") },
    { id: "portfolio-without-due", label: t("portfolioTasks.presetWithoutDue"), hint: t("portfolioTasks.presetWithoutDueHint"), query: portfolioTaskPresetQuery("due", "is-empty") },
  ], [locale]);
  useEffect(() => { setHasExplicitAdvancedQuery(initialAdvancedQuery !== undefined); }, [initialAdvancedQuery]);
  useEffect(() => {
    if (initialAdvancedQuery !== undefined) setAdvancedQuery(filterOnlyViewQuery(parseAdvancedViewQuery(initialAdvancedQuery, surface === "projects" ? projectFields : taskFields)));
  }, [initialAdvancedQuery, projectFields, surface, taskFields]);
  const filteredTasks = useMemo(() => applyAdvancedViewQuery(tasks, taskFields, advancedQuery, locale).filter((item) => projectId === "" || (
    value(item.document, "project") === projectId
    && (filter === "" || value(item.document, "status") === filter)
    && (milestoneFilter === "" || (milestoneFilter === "none" ? value(item.document, "milestone") === "" : value(item.document, "milestone") === milestoneFilter)))), [advancedQuery, filter, locale, milestoneFilter, projectId, taskFields, tasks, value]);
  const task = tasks.find((item) => item.document.id === selectedTask);
  const selectedProject = projects.find((item) => item.document.id === projectId);
  const selectedProjectName = selectedProject === undefined ? "" : value(selectedProject.document, "name");
  const catalog = useMemo(() => new EntityCatalog({ projects, milestones, tasks }), [projects, milestones, tasks]);
  const filterMilestones = activeMilestones.filter((item) => projectId === "" || item.document.project === projectId);
  const completedTasks = activeTasks.filter((item) => isCompletedStatus(statusOptions, value(item.document, "status"))).length;
  const openPerson = (personId: string) => onNavigate("people", { personId });
  const externalTaskQuery = (status = filter, milestone = milestoneFilter) => projectId === "" ? {} : ({
    ...(status === "" ? {} : { status: [status] }),
    ...(milestone === "" ? {} : { milestone: [milestone] }),
  });
  const taskQuery = (status = filter, milestone = milestoneFilter) => ({
    ...externalTaskQuery(status, milestone),
    ...(!hasExplicitAdvancedQuery || countViewConditions(advancedQuery.filter) === 0 ? {} : { filters: [serializeAdvancedViewQuery(advancedQuery)] }),
  });
  const applyAdvancedQuery = (next: AdvancedViewQuery) => {
    const filterQuery = filterOnlyViewQuery(next);
    setAdvancedQuery(filterQuery);
    setHasExplicitAdvancedQuery(countViewConditions(filterQuery.filter) > 0);
    const selection = surface === "tasks" && projectId !== "" ? { projectId } : {};
    onNavigate(surface, countViewConditions(filterQuery.filter) > 0
      ? { ...selection, query: { ...externalTaskQuery(), filters: [serializeAdvancedViewQuery(filterQuery)] } }
      : { ...selection, query: externalTaskQuery() });
  };
  const renderProjectRegisterHeader = () => <div className="project-register-head"><span>{t("core.projects")}</span><span>{t("core.status")}</span><span>{t("core.owner")}</span><span>{t("core.tasks")}</span><span>{t("core.milestones")}</span><span>{t("core.due")}</span><span>{t("core.risk")}</span></div>;
  const renderProjectRow = (project: EntityResult) => {
    const projectTasks = activeTasks.filter((item) => item.document.project === project.document.id).length;
    const projectMilestones = activeMilestones.filter((item) => item.document.project === project.document.id).length;
    const due = value(project.document, "due");
    const risk = projectRisk(project);
    return <button className="project-register-row" key={project.document.id} onClick={() => onNavigate("projects", { projectId: project.document.id })}><span><strong>{value(project.document, "name")}</strong><code>{project.document.id}</code><small>{value(project.document, "description_markdown") || t("core.noDescription")}</small></span><span title={t("tooltip.projectStatus")}><span className="state open">{statusTitle(value(project.document, "status"))}</span></span><span title={t("core.owner")}><PersonLinks empty={t("core.unassigned")} onOpen={openPerson} people={people} personIds={value(project.document, "owner") ? [value(project.document, "owner")] : []} /></span><span title={t("core.tasks")}>{projectTasks}</span><span title={t("core.milestones")}>{projectMilestones}</span><span title={t("tooltip.projectDue")}>{due === "" ? "—" : formatDateOnly(locale, due)}</span><span className={`project-risk ${risk}`} title={t("tooltip.projectRisk")}>{t(`core.risk${risk === "onTrack" ? "OnTrack" : risk === "near" ? "Near" : risk === "overdue" ? "Overdue" : "Unknown"}` as MessageKey)}</span></button>;
  };
  const headingKey: MessageKey = surface === "tasks" ? "core.tasksHeading" : "core.projectsHeading";
  const descriptionKey: MessageKey = surface === "tasks" ? "core.tasksDescription" : "core.projectsDescription";
  const pageHeading = task !== undefined ? value(task.document, "title") : t(headingKey);
  const pageDescription = task !== undefined ? t("core.taskDetailDescription") : projectId === "" && surface === "tasks" ? t("core.allTasksDescription") : t(descriptionKey);

  const createProject = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const data = new FormData(event.currentTarget); const id = newUniqueEntityId(ENTITY_ID_PREFIX.project, new Set(projects.map((item) => item.document.id)));
    const selectedGroup = projectGroupFromForm(data, existingGroups);
    if (!selectedGroup.valid) {
      if (selectedGroup.duplicate) setError(t("core.groupAlreadyExists"));
      return;
    }
    const document = { schema: "gitpm/project@2", id, name: String(data.get("name")), status: statusOptions[0]?.slug ?? "backlog", lifecycle: "active", ...(selectedGroup.group === "" ? {} : { group: selectedGroup.group }), description_markdown: String(data.get("description")) } as EntityDocument;
    void mutate(async () => await api.createEntity(draft.draft_id, "projects", fingerprint, document), id).then((result) => { if (result !== null) { setCreateEditor(null); onNavigate("projects", { projectId: id }); } });
  };
  const createTask = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const data = new FormData(event.currentTarget); const milestone = String(data.get("milestone"));
    const document = withSchedulesMap({ schema: "gitpm/task@2", id: newUniqueEntityId(ENTITY_ID_PREFIX.task, new Set(tasks.map((item) => item.document.id))), project: projectId, title: String(data.get("title")), type: String(data.get("type")), status: String(data.get("status")), lifecycle: "active", description_markdown: String(data.get("description")), assignees: data.getAll("assignees").map(String), ...(milestone ? { milestone } : {}) } as EntityDocument, createSchedules);
    void mutate(async () => await api.createEntity(draft.draft_id, "tasks", fingerprint, document)).then((result) => { if (result !== null) setCreateEditor(null); });
  };

  return <section className={`core-workspace core-${surface}-workspace${reducedMotion ? " reduced-motion" : ""}`} data-reduced-motion={reducedMotion} data-surface={surface}>
    {!(surface === "projects" && projectId === "") && <div className="section-heading"><div><span className="eyebrow draft-context-id">{draft.draft_id}</span><h2 aria-hidden="true">{pageHeading}</h2><p>{pageDescription}</p></div></div>}
    <DraftReadOnlyAlert draft={draft} locale={locale} onAcknowledge={acknowledgeExternalChanges} />{error !== null && <div className="alert error">{error}</div>}
    {feedback !== null && <div aria-live="polite" className={`save-feedback ${feedback.kind}`} role="status"><span>{feedback.text}</span></div>}
    <AsyncBoundary state={loadRequest.state} loading={t("status.loading")} retry={() => { void load(); }} error={(loadError, retry) => <div className="alert error">{loadError}<button onClick={retry}>{t("status.retry")}</button></div>}>
    <>
    {surface === "projects" && <section className="project-directory"><div className="card-heading"><div><h3>{t("core.projectList")}</h3><p>{t("core.projectListDescription")}</p></div><button className="primary" disabled={readOnly} onClick={() => { setError(null); setCreateEditor("project"); }} type="button">+ {t("core.createProjectAction")}</button><EditorDrawer closeLabel={t("core.closeEditor")} onClose={() => setCreateEditor(null)} open={createEditor === "project"} title={t("core.createProjectAction")}><form className="editor-drawer-form" onSubmit={createProject}><label>{t("core.name")}<input disabled={readOnly} name="name" required /></label><ProjectGroupField currentGroup="" disabled={readOnly} groups={existingGroups} key={createEditor === "project" ? "open" : "closed"} t={t} /><label>{t("core.description")}<textarea disabled={readOnly} name="description" /></label><div className="editor-drawer-actions"><button onClick={() => setCreateEditor(null)} type="button">{t("core.cancel")}</button><button className="primary" disabled={readOnly}>{t("core.createProject")}</button></div></form></EditorDrawer></div>
      <AdvancedViewControls allowSorting={false} fields={projectFields} locale={locale} onChange={applyAdvancedQuery} query={advancedQuery} resultCount={filteredProjects.length} t={t} totalCount={projects.length} />
      <dl className="project-register-summary"><div><dt>{t("core.projectsTotal")}</dt><dd>{activeProjects.length}</dd></div><div><dt>{t("core.tasksTotal")}</dt><dd>{activeTasks.length}</dd></div><div><dt>{t("core.milestonesTotal")}</dt><dd>{activeMilestones.length}</dd></div><div><dt>{t("core.completedTasks")}</dt><dd>{completedTasks}</dd></div></dl>
      {filteredProjects.length === 0 ? <p>{t("core.empty")}</p> : <div className="project-groups">{projectGroupSections.map((group) => <section className="project-group" data-ungrouped={group.isUngrouped || undefined} key={group.key}><header className="project-group-heading"><h4>{group.title}</h4><span>{t("core.projectsCount", { count: group.projects.length })}</span></header><div className="project-register" aria-label={group.title}>{renderProjectRegisterHeader()}{group.projects.map(renderProjectRow)}</div></section>)}</div>}
    </section>}
    {surface === "tasks" && projectId === "" && selectedTask === "" && <section className="card portfolio-task-area"><div className="task-toolbar"><div><h3>{t("core.allTasks")}</h3><p>{t("core.allTasksHint")}</p></div></div><AdvancedViewControls allowSorting={false} fields={taskFields} locale={locale} onChange={applyAdvancedQuery} query={advancedQuery} quickPresets={portfolioTaskPresets} resultCount={filteredTasks.length} totalCount={tasks.length} t={t} />
      <dl className="project-register-summary portfolio-task-summary"><div><dt>{t("core.projectsTotal")}</dt><dd>{new Set(filteredTasks.map((item) => item.document.project)).size}</dd></div><div><dt>{t("core.tasksTotal")}</dt><dd>{filteredTasks.length}</dd></div><div><dt>{t("core.milestonesTotal")}</dt><dd>{new Set(filteredTasks.map((item) => value(item.document, "milestone")).filter(Boolean)).size}</dd></div><div><dt>{t("core.completedTasks")}</dt><dd>{filteredTasks.filter((item) => isCompletedStatus(statusOptions, value(item.document, "status"))).length}</dd></div></dl>
      <PortfolioTaskTable effortOf={effortOf} filteredTasks={filteredTasks} highlights={highlights} locale={locale} milestones={milestones} onNavigate={onNavigate} onStatusChange={changeTaskStatus} people={people} projects={projects} query={taskQuery()} readOnly={readOnly} statusBusy={statusPending !== null} statusOptions={statusOptions} statusPending={statusPending} statusTitle={statusTitle} t={t} tasks={tasks} typeOptions={typeOptions} value={value} />
    </section>}
    {surface === "tasks" && projectId !== "" && (task !== undefined ? <div className="task-detail-page"><button className="text-link back-link" onClick={() => onNavigate("tasks", { projectId, query: taskQuery() })}>← {t("core.backToTasks")}</button><TaskPanel api={api} catalog={catalog} confirmCommentDelete={() => confirmAction(t("comments.deleteConfirm"))} confirmDelete={confirmDelete} draft={draft} entity={task} fingerprint={fingerprint} focusedCommentId={initialCommentId || undefined} milestones={milestones} people={people} projects={activeProjects} readOnly={readOnly} externalFields={highlights[task.document.id]} locale={locale} statusOptions={statusOptions} tasks={tasks} typeOptions={typeOptions} value={value} effortString={effortStringOf} track={projectTrack(String(task.document.project))} scheduling={scheduling} planning={projectPlanningById.get(String(task.document.project))} onCommentChanged={async (nextFingerprint) => { setFingerprint(nextFingerprint); await onChanged(); }} onNavigate={onNavigate} onDeleted={() => onNavigate("tasks", { projectId })} onStatusChange={(status) => changeTaskStatus(task, status)} save={mutate} remove={remove} statusBusy={statusPending !== null} /></div> : selectedTask !== "" ? <div className="card empty-workspace"><p>{t("core.taskNotFound")}</p><button onClick={() => onNavigate("tasks", { projectId, query: taskQuery() })}>{t("core.backToTasks")}</button></div> : <section className="card task-area"><div className="task-toolbar"><div><h3>{t("core.tasksFor", { project: selectedProjectName })}</h3><p>{t("core.projectTasksHint")}</p></div><div className="task-toolbar-controls"><label>{t("core.project")}<select aria-label={t("core.project")} value={projectId} onChange={(event) => onNavigate("tasks", { projectId: event.target.value, query: taskQuery(filter, "") })}><option value="">{t("core.chooseProjectOption")}</option>{activeProjects.map((project) => <option key={project.document.id} value={project.document.id}>{value(project.document, "name")}</option>)}</select></label></div></div><AdvancedViewControls allowSorting={false} fields={taskFields} locale={locale} onChange={applyAdvancedQuery} query={advancedQuery} resultCount={filteredTasks.length} t={t} totalCount={tasks.length} />
      {projectId === "" ? <div className="scope-hint">{t("core.selectProjectToCreate")}</div> : <><button className="primary editor-trigger" disabled={readOnly} onClick={() => setCreateEditor("task")} type="button">+ {t("core.createTaskAction")}</button><EditorDrawer closeLabel={t("core.closeEditor")} onClose={() => setCreateEditor(null)} open={createEditor === "task"} size="wide" title={t("core.createTaskAction")}><form className="editor-drawer-form task-editor-form" onSubmit={createTask}>
        <TaskEditorSection className="task-editor-basic" title={t("taskEditor.basic")}><div className="task-editor-basic-grid"><label>{t("core.title")}<input disabled={readOnly} name="title" required /></label><label>{t("core.status")}<select disabled={readOnly} name="status">{statusOptions.map((status) => <option key={status.slug} value={status.slug}>{status.title}</option>)}</select></label><label>{t("core.type")}<select disabled={readOnly} name="type">{typeOptions.map((item) => <option key={item.slug} value={item.slug}>{item.title}</option>)}</select></label><label>{t("core.milestone")}<select disabled={readOnly} name="milestone"><option value="">{t("core.noMilestone")}</option>{filterMilestones.map((milestone) => <option key={milestone.document.id} value={milestone.document.id}>{value(milestone.document, "name")}</option>)}</select></label></div></TaskEditorSection>
        <TaskEditorSection title={t("taskEditor.people")}><AssigneeChecks disabled={readOnly} people={people.filter((person) => person.document.lifecycle === "active")} selected={[]} t={t} /></TaskEditorSection>
        <TaskEditorSection title={t("taskEditor.planning")}><ScheduleTracksEditor actualTrack={createActualTrack} dependencies={createDependencyOptions} disabled={readOnly} locale={locale} onChange={setCreateSchedules} primaryTrack={projectTrack(projectId)} schedules={createSchedules} tracks={createManualTracks} /></TaskEditorSection>
        <TaskEditorSection title={t("taskEditor.description")}><label>{t("core.description")}<textarea disabled={readOnly} name="description" /></label></TaskEditorSection>
        <div className="editor-drawer-actions"><button onClick={() => setCreateEditor(null)} type="button">{t("core.cancel")}</button><button className="primary" disabled={readOnly}>{t("core.createTask")}</button></div>
      </form></EditorDrawer></>}
      <div className="task-table">{filteredTasks.length === 0 ? <p>{t("core.empty")}</p> : filteredTasks.map((item) => { const assignees = values(item.document, "assignees"); const itemProjectId = value(item.document, "project"); const itemMilestone = catalog.milestone(item.document.milestone); return <div className={`task-row${highlights[item.document.id]?.includes("$local") ? " recently-changed" : highlights[item.document.id] ? " external-update" : ""}${statusPending === item.document.id ? " is-saving" : ""}`} data-external-fields={highlights[item.document.id]?.join(",")} key={item.document.id}><button onClick={() => onNavigate("tasks", { projectId: itemProjectId, taskId: item.document.id, query: taskQuery() })}><strong>{value(item.document, "title")}</strong><code>{item.document.id}</code><ProjectLink name={catalog.project(itemProjectId).name} onOpen={(nextProjectId) => onNavigate("projects", { projectId: nextProjectId })} projectId={itemProjectId} />{itemMilestone !== undefined && <MilestoneLink className="task-milestone" milestoneId={itemMilestone.id} name={itemMilestone.name} onOpen={(milestoneId) => onNavigate("stages", { projectId: itemProjectId, stageId: milestoneId })} />}<span className="task-assignees" title={t("tooltip.taskAssignees")}><PersonLinks empty={t("core.unassigned")} onOpen={openPerson} people={people} personIds={assignees} /></span></button>{readOnly ? <span className="state open" title={t("tooltip.taskStatus")}>{statusTitle(value(item.document, "status"))}</span> : <select aria-label={`${t("core.status")}: ${value(item.document, "title")}`} className="inline-status-select" disabled={statusPending !== null} onChange={(event) => changeTaskStatus(item, event.target.value)} title={t("tooltip.changeStatus")} value={value(item.document, "status")}>{statusOptions.map((status) => <option key={status.slug} value={status.slug}>{status.title}</option>)}</select>}</div>; })}</div>
    </section>)}
    </>
    </AsyncBoundary>
  </section>;
}

export function TaskEditorSection({ title, children, className = "" }: { readonly title: string; readonly children: ReactNode; readonly className?: string }) {
  return <section className={`task-editor-section${className === "" ? "" : ` ${className}`}`}><header><h3>{title}</h3></header><div className="task-editor-section-fields">{children}</div></section>;
}

function TaskReferenceSelect({ disabled, emptyLabel, hint, label, onChange, selectedId, tasks }: { readonly disabled: boolean; readonly emptyLabel: string; readonly hint: string; readonly label: string; readonly onChange: ChangeEventHandler<HTMLSelectElement>; readonly selectedId: string; readonly tasks: readonly EntityResult[] }) {
  const selectedTask = tasks.find((item) => item.document.id === selectedId);
  const selectedTitle = selectedId === "" ? emptyLabel : selectedTask === undefined ? "" : stringValue(selectedTask.document, "title");
  return <label className="task-reference-field" data-field-hint={hint}>{label}<span className="task-reference-control"><select aria-label={label} className="task-reference-select" disabled={disabled} onChange={onChange} value={selectedId}><option value="">{emptyLabel}</option>{tasks.map((item) => <option key={item.document.id} value={item.document.id}>{stringValue(item.document, "title")}</option>)}</select>{selectedTitle !== "" && <span aria-hidden="true" className="task-reference-tooltip">{selectedTitle}</span>}</span></label>;
}

export function TaskPanel({ api, catalog, draft, entity, fileContext, fingerprint, milestones, people, projects, tasks, readOnly, externalFields, locale, statusOptions, typeOptions, confirmDelete, confirmCommentDelete, focusedCommentId, onNavigate, onDeleted, onCommentChanged, onStatusChange, statusBusy = false, value, effortString, track, scheduling, planning, save, remove }: { readonly api: GitPmApi; readonly catalog: EntityCatalog; readonly draft: DraftStatus; readonly entity: EntityResult; readonly fileContext?: ProjectFileReferenceContext; readonly fingerprint: string; readonly milestones: readonly EntityResult[]; readonly people: readonly EntityResult[]; readonly projects: readonly EntityResult[]; readonly tasks: readonly EntityResult[]; readonly readOnly: boolean; readonly externalFields?: readonly string[]; readonly locale: Locale; readonly statusOptions: readonly ConfigValue[]; readonly typeOptions: readonly ConfigValue[]; readonly confirmDelete: (name: string) => boolean; readonly confirmCommentDelete: () => boolean; readonly focusedCommentId?: string; readonly onNavigate: WorkspaceNavigate; readonly onDeleted: () => void; readonly onCommentChanged: (fingerprint: string) => Promise<void>; readonly onStatusChange?: (status: string) => void; readonly statusBusy?: boolean; readonly value: ScheduleTextReader; readonly effortString: (document: Readonly<Record<string, unknown>>) => string; readonly track: string; readonly scheduling: ScheduleResolver; readonly planning?: ProjectPlanning; readonly save: (operation: () => Promise<EntityResult>) => Promise<EntityResult | null>; readonly remove: (operation: () => Promise<void>) => Promise<boolean> }) {
  const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => message(locale, key, values);
  const [title, setTitle] = useState(value(entity.document, "title"));
  const [status, setStatus] = useState(value(entity.document, "status"));
  const [type, setType] = useState(value(entity.document, "type"));
  const [description, setDescription] = useState(value(entity.document, "description_markdown"));
  const [acceptanceCriteria, setAcceptanceCriteria] = useState(values(entity.document, "acceptance_criteria_markdown"));
  const [milestone, setMilestone] = useState(value(entity.document, "milestone"));
  const [parent, setParent] = useState(value(entity.document, "parent"));
  const [assignees, setAssignees] = useState(values(entity.document, "assignees"));
  const [schedules, setSchedules] = useState<ScheduleMap | undefined>(entity.document.schedules as ScheduleMap | undefined);
  const [subtaskSchedules, setSubtaskSchedules] = useState<ScheduleMap | undefined>(undefined);
  const [targetProject, setTargetProject] = useState("");
  const [targetMilestone, setTargetMilestone] = useState("");
  const [targetParent, setTargetParent] = useState("");
  const [moveTargetTasks, setMoveTargetTasks] = useState<readonly EntityResult[]>([]);
  const [moveTargetMilestones, setMoveTargetMilestones] = useState<readonly EntityResult[]>([]);
  const [moveTargetsLoading, setMoveTargetsLoading] = useState(false);
  const [editor, setEditor] = useState<"edit" | "move" | "subtask" | null>(null);
  useEffect(() => { setTitle(value(entity.document, "title")); setStatus(value(entity.document, "status")); setType(value(entity.document, "type")); setDescription(value(entity.document, "description_markdown")); setAcceptanceCriteria(values(entity.document, "acceptance_criteria_markdown")); setMilestone(value(entity.document, "milestone")); setParent(value(entity.document, "parent")); setAssignees(values(entity.document, "assignees")); setSchedules(entity.document.schedules as ScheduleMap | undefined); }, [entity]);
  useEffect(() => { if (editor === "subtask") setSubtaskSchedules(undefined); }, [editor]);
  const manualTracks = useMemo(() => scheduling.manualTracks(planning), [scheduling, planning]);
  const actualTrack = useMemo(() => scheduling.actualTrack(planning), [scheduling, planning]);
  const entityStatus = value(entity.document, "status");
  const entityType = value(entity.document, "type");
  const statusTitle = statusOptions.find((item) => item.slug === entityStatus)?.title ?? entityStatus;
  const typeTitle = typeOptions.find((item) => item.slug === entityType)?.title ?? entityType;
  const references = catalog.referencesForTask(entity.document);
  const selectableMilestones = milestones.filter((item) => item.document.lifecycle === "active" || item.document.id === milestone);
  const selectablePeople = people.filter((item) => item.document.lifecycle === "active" || assignees.includes(item.document.id));
  const assigneeIds = values(entity.document, "assignees");
  const targetProjects = projects.filter((item) => item.document.lifecycle === "active");
  const targetMilestones = moveTargetMilestones.filter((item) => item.document.lifecycle === "active" && item.document.project === targetProject);
  const projectTasks = tasks.filter((item) => item.document.project === entity.document.project);
  const projectIsActive = projects.some((item) => item.document.id === entity.document.project && item.document.lifecycle === "active");
  const archivedMilestone = milestones.find((item) => item.document.id === entity.document.milestone && item.document.lifecycle === "archived");
  useEffect(() => {
    if (editor !== "move" || targetProject === "") {
      setMoveTargetTasks([]);
      setMoveTargetMilestones([]);
      setMoveTargetsLoading(false);
      return;
    }
    if (targetProject === entity.document.project) {
      setMoveTargetTasks(projectTasks);
      setMoveTargetMilestones(milestones.filter((item) => item.document.project === targetProject));
      setMoveTargetsLoading(false);
      return;
    }
    let current = true;
    setMoveTargetTasks([]);
    setMoveTargetMilestones([]);
    setMoveTargetsLoading(true);
    void Promise.all([
      api.listEntities(draft.draft_id, "tasks", targetProject),
      api.listEntities(draft.draft_id, "milestones", targetProject),
    ]).then(([nextTasks, nextMilestones]) => {
      if (current) {
        setMoveTargetTasks(nextTasks);
        setMoveTargetMilestones(nextMilestones);
      }
    }).catch(() => {
      if (current) {
        setMoveTargetTasks([]);
        setMoveTargetMilestones([]);
      }
    }).finally(() => {
      if (current) setMoveTargetsLoading(false);
    });
    return () => { current = false; };
  }, [api, draft.draft_id, editor, entity.document.project, targetProject, tasks, milestones]);
  const hierarchy = buildTaskHierarchy(projectTasks.map((task) => ({
    id: task.document.id,
    parent: value(task.document, "parent") || undefined,
    entity: task,
  })));
  const ancestors = hierarchy.ancestorsOf(entity.document.id);
  const descendants = hierarchy.descendantsOf(entity.document.id);
  const directChildren = hierarchy.childrenOf(entity.document.id);
  const descendantIds = new Set(descendants.map((item) => item.id));
  const dependencyOptions = projectTasks.filter((item) => item.document.id !== entity.document.id && !descendantIds.has(item.document.id) && item.document.lifecycle === "active");
  const targetParentTasks = moveTargetTasks.filter((item) =>
    item.document.lifecycle === "active"
    && item.document.project === targetProject
    && value(item.document, "milestone") === targetMilestone
    && item.document.id !== entity.document.id
    && !descendantIds.has(item.document.id));
  const selectableParents = projectTasks.filter((item) =>
    item.document.id !== entity.document.id
    && !descendantIds.has(item.document.id)
    && (item.document.lifecycle === "active" || item.document.id === parent)
    && value(item.document, "milestone") === milestone);
  const completedDescendants = descendants.filter((item) => isCompletedStatus(statusOptions, value(item.entity.document, "status"))).length;
  const descendantEstimate = descendants.reduce((sum, item) => sum + (scheduleEffort(item.entity.document, track) ?? 0), 0);
  const createSubtask = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const newAcceptanceCriteria = data.getAll("acceptanceCriteria").map(String).filter((criterion) => criterion !== "");
    const document = withSchedulesMap({
      schema: "gitpm/task@2",
      id: newUniqueEntityId(ENTITY_ID_PREFIX.task, new Set(tasks.map((item) => item.document.id))),
      project: entity.document.project,
      parent: entity.document.id,
      ...(value(entity.document, "milestone") ? { milestone: value(entity.document, "milestone") } : {}),
      title: String(data.get("title")).trim(),
      status: String(data.get("status")),
      type: String(data.get("type")),
      lifecycle: "active",
      description_markdown: String(data.get("description")),
      ...(newAcceptanceCriteria.length === 0 ? {} : { acceptance_criteria_markdown: newAcceptanceCriteria }),
      assignees: data.getAll("assignees").map(String),
    } as EntityDocument, subtaskSchedules);
    void save(async () => await api.createEntity(draft.draft_id, "tasks", fingerprint, document)).then((result) => {
      if (result !== null) setEditor(null);
    });
  };
  return <section className={`card task-detail-card${externalFields?.includes("$local") ? " recently-changed" : externalFields ? " external-update" : ""}`} data-external-fields={externalFields?.join(",")}>
    {entity.document.lifecycle === "archived" && projectIsActive && <div className="alert warning"><span>{archivedMilestone === undefined ? t("core.archived") : t("projectArchive.taskNeedsMilestone", { name: value(archivedMilestone.document, "name") })}</span><button className="primary" disabled={readOnly} onClick={() => { void save(async () => await api.restoreEntity(draft.draft_id, "tasks", entity, fingerprint, archivedMilestone === undefined ? {} : { restoreMilestone: true })); }} type="button">{archivedMilestone === undefined ? t("core.restore") : t("projectArchive.restoreTaskAndMilestone")}</button></div>}
    {!projectIsActive && <div className="alert warning">{t("core.inactiveProjectTask")}</div>}
    {ancestors.length > 0 && <nav aria-label={t("taskHierarchy.path")} className="task-hierarchy-breadcrumbs">{ancestors.map((ancestor) => <button className="text-link" key={ancestor.id} onClick={() => onNavigate("tasks", { projectId: references.project.id, taskId: ancestor.id })} type="button">{value(ancestor.entity.document, "title")}</button>)}</nav>}
    <div className="detail-heading"><div><span className="eyebrow">{t("core.details")}</span><h2>{value(entity.document, "title")}</h2><code>{entity.document.id}</code></div>{onStatusChange === undefined || readOnly ? <span className="state open" title={t("tooltip.taskStatus")}>{statusTitle}</span> : <select aria-label={`${t("core.status")}: ${value(entity.document, "title")}`} className="inline-status-select" disabled={statusBusy} onChange={(event) => onStatusChange(event.target.value)} title={t("tooltip.changeStatus")} value={entityStatus}>{statusOptions.map((item) => <option key={item.slug} value={item.slug}>{item.title}</option>)}</select>}</div>
    <dl className="task-detail-meta"><div><dt>{t("core.project")}</dt><dd><button className="text-link" onClick={() => onNavigate("projects", { projectId: references.project.id })}>{references.project.name}</button></dd></div><div><dt>{t("core.type")}</dt><dd>{typeTitle}</dd></div><div><dt>{t("core.milestone")}</dt><dd>{references.milestone === undefined ? t("core.noMilestone") : <button className="text-link" onClick={() => onNavigate("stages", { projectId: references.project.id, stageId: references.milestoneId })}>{references.milestone.name}{references.milestone.lifecycle === "archived" && <small className="archived-reference"> · {t("core.archived")}</small>}</button>}</dd></div><div><dt>{t("taskHierarchy.parent")}</dt><dd>{ancestors.length === 0 ? t("taskHierarchy.noParent") : <button className="text-link" onClick={() => onNavigate("tasks", { projectId: references.project.id, taskId: ancestors.at(-1)!.id })}>{value(ancestors.at(-1)!.entity.document, "title")}</button>}</dd></div><div><dt>{t("core.assignees")}</dt><dd><PersonLinks empty={t("core.unassigned")} onOpen={(personId) => onNavigate("people", { personId })} people={people} personIds={assigneeIds} /></dd></div><div><dt>{t("projectPlan.start")}</dt><dd>{value(entity.document, "start") ? formatDateOnly(locale, value(entity.document, "start")) : "—"}</dd></div><div><dt>{t("core.due")}</dt><dd>{value(entity.document, "due") ? formatDateOnly(locale, value(entity.document, "due")) : "—"}</dd></div><div><dt>{t("projectPlan.estimate")}</dt><dd>{(() => { const e = scheduleEffort(entity.document, track); return typeof e === "number" ? formatDurationHours(locale, e) : "—"; })()}</dd></div></dl>
    {descendants.length > 0 && <section className="task-hierarchy-summary"><div className="task-hierarchy-summary-heading"><div><h3>{t("taskHierarchy.subtasks")}</h3><p>{t("taskHierarchy.descendantProgress", { completed: completedDescendants, count: descendants.length, hours: descendantEstimate })}</p></div></div><div className="task-child-list">{directChildren.map((child) => <button className="text-link" key={child.id} onClick={() => onNavigate("tasks", { projectId: references.project.id, taskId: child.id })} type="button"><strong>{value(child.entity.document, "title")}</strong><span>{statusOptions.find((item) => item.slug === value(child.entity.document, "status"))?.title ?? value(child.entity.document, "status")}</span></button>)}</div></section>}
    <div className="task-description"><h3>{t("core.description")}</h3>{value(entity.document, "description_markdown") === "" ? <p className="empty-copy">{t("core.noDescription")}</p> : <SafeMarkdown fileContext={fileContext} source={value(entity.document, "description_markdown")} />}</div>
    {values(entity.document, "acceptance_criteria_markdown").length > 0 && <section className="task-acceptance-criteria"><h3>{t("projectFileReferences.acceptanceCriteria")}</h3><ol>{values(entity.document, "acceptance_criteria_markdown").map((criterion, index) => <li key={index}>{criterion === "" ? <span className="empty-copy">{t("projectFileReferences.emptyCriterion")}</span> : <SafeMarkdown fileContext={fileContext} source={criterion} />}</li>)}</ol></section>}
    <div className="editor-actions"><button className="primary" data-control-hint={t("controlHint.createSubtask")} disabled={readOnly} onClick={() => setEditor("subtask")} type="button">+ {t("taskHierarchy.newSubtask")}</button><button className="editor-trigger" onClick={() => { setTitle(value(entity.document, "title")); setStatus(entityStatus); setType(entityType); setDescription(value(entity.document, "description_markdown")); setAcceptanceCriteria(values(entity.document, "acceptance_criteria_markdown")); setMilestone(value(entity.document, "milestone")); setParent(value(entity.document, "parent")); setAssignees(values(entity.document, "assignees")); setSchedules(entity.document.schedules as ScheduleMap | undefined); setEditor("edit"); }} type="button">{t("core.edit")}</button><button data-control-hint={t("controlHint.openMoveTask")} onClick={() => { setTargetProject(""); setTargetMilestone(""); setTargetParent(""); setEditor("move"); }} type="button">{t("core.moveTask")}</button></div>
    <TaskTimeEntries api={api} draft={draft} fileContext={fileContext} fingerprint={fingerprint} locale={locale} onFingerprintChange={onCommentChanged} onOpenPerson={(personId) => onNavigate("people", { personId })} people={people} projectId={references.project.id} readOnly={readOnly} taskId={entity.document.id} assigneeIds={assigneeIds} />
    <TaskComments api={api} confirmDelete={confirmCommentDelete} draft={draft} fileContext={fileContext} fingerprint={fingerprint} focusCommentId={focusedCommentId} locale={locale} onFingerprintChange={onCommentChanged} onNavigate={onNavigate} people={people} projectId={references.project.id} readOnly={readOnly} taskId={entity.document.id} />
    <EditorDrawer closeLabel={t("core.closeEditor")} onClose={() => setEditor(null)} open={editor === "subtask"} size="wide" title={t("taskHierarchy.newSubtask")}><form className="editor-drawer-form task-editor-form" onSubmit={createSubtask}>
      <p className="task-parent-context">{t("taskHierarchy.parent")}: <strong>{value(entity.document, "title")}</strong></p>
      <TaskEditorSection title={t("taskEditor.basic")}><div className="task-editor-basic-grid"><label>{t("core.title")}<input disabled={readOnly} name="title" required /></label><label>{t("core.status")}<select disabled={readOnly} name="status">{statusOptions.map((item) => <option key={item.slug} value={item.slug}>{item.title}</option>)}</select></label><label>{t("core.type")}<select disabled={readOnly} name="type">{typeOptions.map((item) => <option key={item.slug} value={item.slug}>{item.title}</option>)}</select></label></div></TaskEditorSection>
      <TaskEditorSection title={t("taskEditor.people")}><AssigneeChecks disabled={readOnly} people={people.filter((item) => item.document.lifecycle === "active")} selected={assigneeIds} t={t} /></TaskEditorSection>
      <TaskEditorSection title={t("taskEditor.planning")}><ScheduleTracksEditor actualTrack={actualTrack} dependencies={dependencyOptions} disabled={readOnly} locale={locale} onChange={setSubtaskSchedules} primaryTrack={track} schedules={subtaskSchedules} tracks={manualTracks} /></TaskEditorSection>
      <TaskEditorSection title={t("taskEditor.description")}><ProjectFileMarkdownField context={fileContext} disabled={readOnly} label={t("core.description")} name="description" /><ProjectFileMarkdownField context={fileContext} disabled={readOnly} label={t("projectFileReferences.acceptanceCriterion")} name="acceptanceCriteria" /></TaskEditorSection>
      <div className="editor-drawer-actions"><button onClick={() => setEditor(null)} type="button">{t("core.cancel")}</button><button className="primary" disabled={readOnly}>{t("core.createTask")}</button></div>
    </form></EditorDrawer>
    <EditorDrawer closeLabel={t("core.closeEditor")} onClose={() => setEditor(null)} open={editor === "edit"} size="wide" title={`${t("core.edit")}: ${value(entity.document, "title")}`}><div className="editor-drawer-form task-editor-form">
      <TaskEditorSection title={t("taskEditor.basic")}><div className="task-editor-basic-grid"><label>{t("core.title")}<input disabled={readOnly} value={title} onChange={(event) => setTitle(event.target.value)} /></label><label>{t("core.status")}<select disabled={readOnly} value={status} onChange={(event) => setStatus(event.target.value)}>{statusOptions.map((item) => <option key={item.slug} value={item.slug}>{item.title}</option>)}</select></label><label>{t("core.type")}<select disabled={readOnly} value={type} onChange={(event) => setType(event.target.value)}>{typeOptions.map((item) => <option key={item.slug} value={item.slug}>{item.title}</option>)}</select></label><label>{t("core.milestone")}<select disabled={readOnly || parent !== "" || descendants.length > 0} value={milestone} onChange={(event) => setMilestone(event.target.value)}><option value="">{t("core.noMilestone")}</option>{selectableMilestones.map((item) => <option key={item.document.id} value={item.document.id}>{value(item.document, "name")}{item.document.lifecycle === "archived" ? ` · ${t("core.archived")}` : ""}</option>)}</select>{(parent !== "" || descendants.length > 0) && <small>{t("taskHierarchy.milestoneInherited")}</small>}</label></div></TaskEditorSection>
      <TaskEditorSection title={t("taskEditor.people")}><TaskReferenceSelect disabled={readOnly} emptyLabel={t("taskHierarchy.noParent")} hint={t("fieldHint.parent")} label={t("taskHierarchy.parent")} onChange={(event) => { const nextParent = event.target.value; setParent(nextParent); const selectedParent = projectTasks.find((item) => item.document.id === nextParent); if (selectedParent !== undefined) setMilestone(value(selectedParent.document, "milestone")); }} selectedId={parent} tasks={selectableParents} /><AssigneeChecks disabled={readOnly} onChange={setAssignees} people={selectablePeople} selected={assignees} t={t} /></TaskEditorSection>
      <TaskEditorSection title={t("taskEditor.planning")}><ScheduleTracksEditor schedules={schedules} tracks={manualTracks} actualTrack={actualTrack} primaryTrack={track} dependencies={dependencyOptions} disabled={readOnly} locale={locale} onChange={setSchedules} /></TaskEditorSection>
      <TaskEditorSection title={t("taskEditor.description")}><ProjectFileMarkdownField context={fileContext} disabled={readOnly} label={t("core.description")} onValueChange={setDescription} value={description} /><fieldset className="acceptance-criteria-editor"><legend>{t("projectFileReferences.acceptanceCriteria")}</legend>{acceptanceCriteria.map((criterion, index) => <div className="acceptance-criterion-editor" key={index}><ProjectFileMarkdownField context={fileContext} disabled={readOnly} label={t("projectFileReferences.acceptanceCriterionNumber", { number: index + 1 })} onValueChange={(next) => setAcceptanceCriteria((current) => current.map((item, itemIndex) => itemIndex === index ? next : item))} value={criterion} /><button aria-label={t("projectFileReferences.removeCriterionNumber", { number: index + 1 })} disabled={readOnly} onClick={() => setAcceptanceCriteria((current) => current.filter((_item, itemIndex) => itemIndex !== index))} type="button">{t("projectFileReferences.removeCriterion")}</button></div>)}<button disabled={readOnly} onClick={() => setAcceptanceCriteria((current) => [...current, ""])} type="button">+ {t("projectFileReferences.addCriterion")}</button></fieldset></TaskEditorSection>
      <div className="editor-drawer-actions"><details className="more-actions"><summary>{t("core.moreActions")}</summary><div>{descendants.length > 0 && <small>{t("taskHierarchy.archiveBlocked", { count: descendants.length })}</small>}<button disabled={readOnly || descendants.length > 0} onClick={() => { void save(async () => await api.archiveEntity(draft.draft_id, "tasks", entity, fingerprint)).then((result) => { if (result !== null) { setEditor(null); onDeleted(); } }); }} type="button">{t("core.archive")}</button><button className="danger" data-control-hint={t("controlHint.deleteEntity")} disabled={readOnly} onClick={() => { if (confirmDelete(value(entity.document, "title"))) void remove(async () => await api.deleteEntity(draft.draft_id, "tasks", entity, fingerprint)).then((success) => { if (success) { setEditor(null); onDeleted(); } }); }} type="button">{t("core.delete")}</button></div></details><button onClick={() => setEditor(null)} type="button">{t("core.cancel")}</button><button type="button" className="primary" disabled={readOnly || title.trim() === ""} onClick={() => { void save(async () => await api.updateEntity(draft.draft_id, "tasks", entity, fingerprint, withSchedulesMap({ ...entity.document, title: title.trim(), status, type, assignees, description_markdown: description, acceptance_criteria_markdown: acceptanceCriteria, parent: parent || undefined, milestone: milestone || undefined }, schedules))).then((result) => { if (result !== null) setEditor(null); }); }}>{t("core.save")}</button></div>
    </div></EditorDrawer>
    <EditorDrawer closeLabel={t("core.closeEditor")} onClose={() => setEditor(null)} open={editor === "move"} title={t("core.moveTask")}><div className="editor-drawer-form move-task-editor"><p>{t("core.moveTaskDescription")}</p>{descendants.length > 0 && <p className="task-parent-context">{t("taskHierarchy.moveSubtreeImpact", { count: descendants.length })}</p>}<label>{t("core.targetProject")}<select disabled={readOnly} value={targetProject} onChange={(event) => { setTargetProject(event.target.value); setTargetMilestone(""); setTargetParent(""); }}><option value="">{t("core.selectTargetProject")}</option>{targetProjects.map((project) => <option key={project.document.id} value={project.document.id}>{value(project.document, "name")}</option>)}</select></label><label data-field-hint={t("fieldHint.targetMilestone")}>{t("core.milestone")}<select disabled={readOnly || targetProject === ""} value={targetMilestone} onChange={(event) => { setTargetMilestone(event.target.value); setTargetParent(""); }}><option value="">{t("core.noMilestone")}</option>{targetMilestones.map((item) => <option key={item.document.id} value={item.document.id}>{value(item.document, "name")}</option>)}</select></label><TaskReferenceSelect disabled={readOnly || targetProject === "" || moveTargetsLoading} emptyLabel={t("taskHierarchy.noParent")} hint={t("fieldHint.targetParent")} label={t("taskHierarchy.parent")} onChange={(event) => setTargetParent(event.target.value)} selectedId={targetParent} tasks={targetParentTasks} /><div className="editor-drawer-actions"><button onClick={() => setEditor(null)} type="button">{t("core.cancel")}</button><button className="primary" data-control-hint={t("controlHint.moveTask")} disabled={readOnly || targetProject === ""} onClick={() => { const project = targetProject; const nextMilestone = targetMilestone || undefined; const nextParent = targetParent || undefined; void save(async () => await api.moveTask(draft.draft_id, entity, fingerprint, project, nextMilestone, nextParent)).then((result) => { if (result !== null) { setEditor(null); onNavigate("tasks", { projectId: project, taskId: entity.document.id }); } }); }} type="button">{t("core.moveTaskAction")}</button></div></div></EditorDrawer>
  </section>;
}

export function AssigneeChecks({ people, selected, disabled, onChange, t }: {
  readonly people: readonly EntityResult[];
  readonly selected: readonly string[];
  readonly disabled: boolean;
  readonly onChange?: (next: string[]) => void;
  readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string;
}) {
  const personName = usePersonNameFormatter();
  const defaultPersonNameFormat = useDefaultPersonNameFormat();
  const [internalSelected, setInternalSelected] = useState([...selected]);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const current = onChange === undefined ? internalSelected : selected;
  const update = (next: string[]) => onChange === undefined ? setInternalSelected(next) : onChange(next);
  const selectedPeople = current.map((id) => people.find((person) => person.document.id === id)).filter((person): person is EntityResult => person !== undefined);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matches = people.filter((person) => !current.includes(person.document.id) && (normalizedQuery === "" || `${personNameSearchText(person.document, defaultPersonNameFormat)} ${stringValue(person.document, "email")}`.toLocaleLowerCase().includes(normalizedQuery)));
  const availableCount = people.filter((person) => !current.includes(person.document.id)).length;
  return <fieldset className="assignee-fieldset"><legend>{t("core.assignees")}</legend>
    <div className="assignee-current">
      {selectedPeople.length === 0 ? <span className="empty-copy">{t("core.unassigned")}</span> : selectedPeople.map((person) => { const name = personName(person.document) || person.document.id; return <div className="assignee-row" key={person.document.id}><span>{name}</span><button aria-label={t("core.removeAssigneeLabel", { name })} disabled={disabled} onClick={() => update(current.filter((id) => id !== person.document.id))} type="button">{t("core.removeAssignee")}</button></div>; })}
    </div>
    {current.map((id) => <input key={id} name="assignees" type="hidden" value={id} />)}
    {!adding && <button className="assignee-add" disabled={disabled || availableCount === 0} onClick={() => { setAdding(true); setQuery(""); }} type="button">+ {t("core.addAssignee")}</button>}
    {adding && <div className="assignee-search-panel">
      <label>{t("core.assigneeSearch")}<input autoFocus onChange={(event) => setQuery(event.target.value)} type="search" value={query} /></label>
      {matches.length === 0 ? <span className="assignee-search-message">{t("core.assigneeNoMatches")}</span> : <div className="assignee-search-results">{matches.map((person) => <button key={person.document.id} onClick={() => { update([...current, person.document.id]); setAdding(false); setQuery(""); }} type="button"><span>{personName(person.document) || person.document.id}</span>{stringValue(person.document, "email") !== "" && <small>{stringValue(person.document, "email")}</small>}</button>)}</div>}
      <button onClick={() => { setAdding(false); setQuery(""); }} type="button">{t("core.cancel")}</button>
    </div>}
    {people.length === 0 && <span className="empty-copy">{t("core.noPeople")}</span>}
    <small className="assignee-hint">{t("core.assigneesHint")}</small>
  </fieldset>;
}
