import { useCallback, useEffect, useMemo, useState } from "react";
import { resolveSchedulingHierarchy, type SchedulingHierarchyTask } from "@gitpm/scheduling";
import { AsyncBoundary, useAsyncLoad } from "../../async-data.js";
import type { GitPmApi } from "../../api.js";
import { message, type Locale, type MessageKey } from "../../i18n.js";
import { ScheduleResolver, scheduleTracksConfig } from "../../schedules.js";
import type { ConfigurationResult, DraftStatus, EntityDocument, EntityResult, ProjectWorkspaceResult } from "../../types.js";
import type { WorkspaceNavigate } from "../../workspace-navigation.js";
import { ProjectActualReport, type ActualReportCategory } from "./project-actual-report.js";
import { normalizeActiveMilestone, normalizeActiveParent } from "./project-task-view-model.js";

interface WorkCategoryEntry { readonly slug: string; readonly title: string }

const text = (document: EntityDocument, key: string): string => typeof document[key] === "string" ? String(document[key]) : "";

export function ProjectEffortWorkspace({ api, draft, locale, projectId, onNavigate, onChanged }: {
  readonly api: GitPmApi;
  readonly draft: DraftStatus;
  readonly locale: Locale;
  readonly projectId: string;
  readonly onNavigate: WorkspaceNavigate;
  readonly onChanged?: () => Promise<void>;
}) {
  const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => message(locale, key, values);
  const loader = useAsyncLoad();
  const [workspace, setWorkspace] = useState<ProjectWorkspaceResult | null>(null);
  const [people, setPeople] = useState<readonly EntityResult[]>([]);
  const [categoriesConfig, setCategoriesConfig] = useState<ConfigurationResult | null>(null);
  const [tracksConfig, setTracksConfig] = useState<ConfigurationResult | null>(null);

  const load = useCallback(async () => {
    await loader.run(async () => {
      const [nextWorkspace, nextPeople, categories, tracks] = await Promise.all([
        api.projectWorkspace(draft.draft_id, projectId),
        api.listEntities(draft.draft_id, "people"),
        api.getConfiguration(draft.draft_id, "work-categories"),
        api.getConfiguration(draft.draft_id, "schedule-tracks"),
      ]);
      return { nextWorkspace, nextPeople, categories, tracks };
    }, ({ nextWorkspace, nextPeople, categories, tracks }) => {
      setWorkspace(nextWorkspace);
      setPeople(nextPeople.filter((item) => item.document.lifecycle === "active" || item.document.lifecycle === "archived"));
      setCategoriesConfig(categories);
      setTracksConfig(tracks);
    });
  }, [api, draft.draft_id, draft.fingerprint, loader.run, projectId]);

  useEffect(() => { void load(); }, [load]);

  const scheduling = useMemo(() => new ScheduleResolver(scheduleTracksConfig(tracksConfig?.document)), [tracksConfig]);
  const projectDoc = workspace?.project.document;
  const workloadTrack = projectDoc === undefined ? "" : scheduling.workloadTrack(projectDoc.planning);
  const tracks = useMemo(() => [...new Set([workloadTrack].filter((track): track is string => track !== undefined && track !== ""))], [workloadTrack]);
  // The current plan is built from ACTIVE tasks and ACTIVE milestones only: an archived task
  // must never inflate the plan, the schedule, or a parent branch. Archived tasks still reach
  // the actual report (as the `tasks` prop) so that those with historical time records can be
  // shown; their estimate simply no longer contributes because they are absent from the
  // read models. A task whose milestone points at an unknown or archived milestone is normalized
  // to `undefined` so it rolls into the project deadline instead of being dropped. A task whose
  // parent points at a non-existent, archived, deleted, or self-referential task is normalized to
  // `undefined` so it becomes a root and stays in the plan instead of vanishing under a parent
  // that the active hierarchy cannot resolve.
  const hierarchy = useMemo(() => {
    const activeTasks = (workspace?.tasks ?? []).filter((task) => task.document.lifecycle === "active");
    const activeTaskIds = new Set(activeTasks.map((task) => task.document.id));
    const activeMilestoneIds = new Set((workspace?.milestones ?? []).filter((milestone) => milestone.document.lifecycle === "active").map((milestone) => milestone.document.id));
    return resolveSchedulingHierarchy({
      project: projectDoc,
      milestones: (workspace?.milestones ?? []).filter((milestone) => milestone.document.lifecycle === "active").map((milestone) => milestone.document),
      tasks: activeTasks.map((task): SchedulingHierarchyTask => ({
        ...task.document,
        parent: normalizeActiveParent(activeTaskIds, task.document.id, typeof task.document.parent === "string" && task.document.parent !== "" ? task.document.parent : undefined),
        milestone: normalizeActiveMilestone(activeMilestoneIds, typeof task.document.milestone === "string" ? task.document.milestone : ""),
      })),
      tracks,
    });
  }, [projectDoc, tracks, workspace?.milestones, workspace?.tasks]);
  const categories = useMemo<readonly ActualReportCategory[]>(() => Array.isArray(categoriesConfig?.document.categories)
    ? (categoriesConfig!.document.categories as readonly unknown[]).filter((item): item is WorkCategoryEntry => typeof item === "object" && item !== null && typeof (item as WorkCategoryEntry).slug === "string" && typeof (item as WorkCategoryEntry).title === "string").map((item) => ({ slug: item.slug, title: item.title }))
    : [], [categoriesConfig]);

  return <section className="project-effort-workspace">
    <AsyncBoundary state={loader.state} loading={t("status.loading")} retry={() => { void load(); }} error={(loadError, retry) => <div className="alert error">{loadError}<button onClick={retry}>{t("status.retry")}</button></div>}>
      {workspace !== null && projectDoc !== undefined && <>
        <header className="project-effort-header">
          <span className="project-effort-eyebrow">{t("core.project")} <code>{projectDoc.id}</code></span>
          <h2>{text(projectDoc, "name")}</h2>
        </header>
        <ProjectActualReport api={api} categories={categories} draft={draft} locale={locale} milestones={workspace.milestones} onNavigate={onNavigate} people={people} project={workspace.project} projectId={projectId} readModels={hierarchy.readModels} tasks={workspace.tasks} trackTitle={(slug) => scheduling.trackTitle(slug)} workloadTrack={workloadTrack} />
      </>}
    </AsyncBoundary>
  </section>;
}
