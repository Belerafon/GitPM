import type { ProjectFileDeleteResult, ProjectFileList, ProjectFileRenameResult, ProjectFileReplaceResult, ProjectFileUploadResult } from "@gitpm/contracts";
import { useCallback, useEffect, useState } from "react";
import type { GitPmApi } from "../../api.js";
import { useAsyncLoad } from "../../async-data.js";
import { readProjectFilesView, type ProjectFilesView } from "./project-files-panel.js";

export type ProjectPlanFilesApi = Pick<GitPmApi, "listProjectFiles">;

export function useProjectPlanFiles({ api, draftId, projectId, onChanged, onDraftFingerprint }: {
  readonly api: ProjectPlanFilesApi;
  readonly draftId: string;
  readonly projectId: string;
  readonly onChanged: () => Promise<void>;
  readonly onDraftFingerprint: (fingerprint: string) => void;
}) {
  const { state: loadState, run } = useAsyncLoad();
  const [files, setFiles] = useState<ProjectFileList | null>(null);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<ProjectFilesView>(readProjectFilesView);

  const reload = useCallback(async (keepData = true) => {
    if (!keepData) setFiles(null);
    await run(
      async () => await api.listProjectFiles(draftId, projectId),
      setFiles,
      { keepData },
    );
  }, [api, draftId, projectId, run]);

  useEffect(() => { void reload(false); }, [reload]);

  const finishMutation = useCallback((fingerprint: string) => {
    onDraftFingerprint(fingerprint);
    void onChanged();
  }, [onChanged, onDraftFingerprint]);

  const handleUploaded = useCallback((result: ProjectFileUploadResult) => {
    setFiles((current) => {
      if (current === null) return { project_id: result.project_id, count: 1, total_size_bytes: result.item.size_bytes, items: [result.item], draft_fingerprint: result.draft_fingerprint };
      const previous = current.items.find((item) => item.name === result.item.name);
      const items = previous === undefined ? [...current.items, result.item] : current.items.map((item) => item.name === result.item.name ? result.item : item);
      return {
        ...current,
        count: items.length,
        total_size_bytes: current.total_size_bytes - (previous?.size_bytes ?? 0) + result.item.size_bytes,
        items,
        draft_fingerprint: result.draft_fingerprint,
      };
    });
    finishMutation(result.draft_fingerprint);
  }, [finishMutation]);

  const handleRenamed = useCallback((result: ProjectFileRenameResult) => {
    setFiles((current) => current === null ? current : {
      ...current,
      total_size_bytes: current.total_size_bytes - (current.items.find((item) => item.name === result.previous_name)?.size_bytes ?? 0) + result.item.size_bytes,
      items: current.items.map((item) => item.name === result.previous_name ? result.item : item),
      draft_fingerprint: result.draft_fingerprint,
    });
    finishMutation(result.draft_fingerprint);
  }, [finishMutation]);

  const handleReplaced = useCallback((result: ProjectFileReplaceResult) => {
    setFiles((current) => current === null ? current : {
      ...current,
      total_size_bytes: current.total_size_bytes - (current.items.find((item) => item.name === result.previous_name)?.size_bytes ?? 0) + result.item.size_bytes,
      items: current.items.map((item) => item.name === result.previous_name ? result.item : item),
      draft_fingerprint: result.draft_fingerprint,
    });
    finishMutation(result.draft_fingerprint);
  }, [finishMutation]);

  const handleDeleted = useCallback((result: ProjectFileDeleteResult) => {
    setFiles((current) => {
      if (current === null) return current;
      const items = current.items.filter((item) => item.name !== result.name);
      return { ...current, count: items.length, total_size_bytes: Math.max(0, current.total_size_bytes - result.size_bytes), items, draft_fingerprint: result.draft_fingerprint };
    });
    finishMutation(result.draft_fingerprint);
  }, [finishMutation]);

  return {
    files,
    loadState,
    open,
    setOpen,
    view,
    setView,
    reload,
    handleUploaded,
    handleRenamed,
    handleReplaced,
    handleDeleted,
  };
}
