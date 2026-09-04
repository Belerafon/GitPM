import { useCallback, useEffect, useState } from "react";
import type { GitPmApi } from "../../api.js";
import { useAsyncLoad } from "../../async-data.js";
import { existingProjectGroups, type ConfigValue } from "../../core-ui.js";
import type { Locale } from "../../i18n.js";
import type { ConfigurationResult, DraftStatus, EntityResult, ProjectWorkspaceResult } from "../../types.js";

export type ProjectPlanDataApi = Pick<GitPmApi, "projectWorkspace" | "listEntities" | "getConfiguration">;

function configValues(document: Readonly<Record<string, unknown>>, key: "statuses" | "issue_types"): ConfigValue[] {
  return Array.isArray(document[key])
    ? (document[key] as unknown[]).filter((item): item is ConfigValue => typeof item === "object" && item !== null && typeof (item as ConfigValue).slug === "string" && typeof (item as ConfigValue).title === "string" && (item as ConfigValue).active === true)
    : [];
}

export function useProjectPlanData({ api, draft, locale, projectId }: {
  readonly api: ProjectPlanDataApi;
  readonly draft: DraftStatus;
  readonly locale: Locale;
  readonly projectId: string;
}) {
  const loader = useAsyncLoad();
  const [workspace, setWorkspace] = useState<ProjectWorkspaceResult | null>(null);
  const [projects, setProjects] = useState<readonly EntityResult[]>([]);
  const [availableProjectGroups, setAvailableProjectGroups] = useState<readonly string[]>([]);
  const [people, setPeople] = useState<readonly EntityResult[]>([]);
  const [statuses, setStatuses] = useState<readonly ConfigValue[]>([]);
  const [types, setTypes] = useState<readonly ConfigValue[]>([]);
  const [tracksConfig, setTracksConfig] = useState<ConfigurationResult | null>(null);

  const reload = useCallback(async () => {
    await loader.run(async () => {
      const [nextWorkspace, nextProjects, nextPeople, statusConfig, typeConfig, tracksDocument] = await Promise.all([
        api.projectWorkspace(draft.draft_id, projectId),
        api.listEntities(draft.draft_id, "projects"),
        api.listEntities(draft.draft_id, "people"),
        api.getConfiguration(draft.draft_id, "statuses"),
        api.getConfiguration(draft.draft_id, "issue-types"),
        api.getConfiguration(draft.draft_id, "schedule-tracks"),
      ]);
      return { nextWorkspace, nextProjects, nextPeople, statusConfig, typeConfig, tracksDocument };
    }, ({ nextWorkspace, nextProjects, nextPeople, statusConfig, typeConfig, tracksDocument }) => {
      setWorkspace(nextWorkspace);
      setProjects(nextProjects.filter((item) => item.document.lifecycle === "active"));
      setAvailableProjectGroups(existingProjectGroups(nextProjects, locale));
      setPeople(nextPeople.filter((item) => item.document.lifecycle === "active"));
      setStatuses(configValues(statusConfig.document, "statuses"));
      setTypes(configValues(typeConfig.document, "issue_types"));
      setTracksConfig(tracksDocument);
    });
  }, [api, draft.draft_id, draft.fingerprint, loader.run, locale, projectId]);

  useEffect(() => { void reload(); }, [reload]);

  return { loader, reload, workspace, setWorkspace, projects, availableProjectGroups, people, statuses, types, tracksConfig };
}
