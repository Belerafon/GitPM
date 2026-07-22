import { useEffect, useState, type FormEvent } from "react";
import type { GitPmApi } from "./api.js";
import { message, type Locale, type MessageKey } from "./i18n.js";
import type { RepositoryConnectionStatus } from "./types.js";

export function RepositoryConnectionSettings({ api, locale, maintainer, confirmAction = () => true }: {
  readonly api: GitPmApi;
  readonly locale: Locale;
  readonly maintainer: boolean;
  readonly confirmAction?: (message: string) => boolean;
}) {
  const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => message(locale, key, values);
  const [connection, setConnection] = useState<RepositoryConnectionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void api.repositoryConnection().then((value) => { if (active) setConnection(value); })
      .catch((caught) => { if (active) setError(caught instanceof Error ? caught.message : String(caught)); });
    return () => { active = false; };
  }, [api]);

  if (connection === null) return <section className="card repository-connection-settings">{error === null ? <p>{t("status.loading")}</p> : <div className="alert error">{error}</div>}</section>;
  const editable = maintainer && connection.remote_editable && connection.gitlab_editable;

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const repositoryUrl = String(form.get("repository_url") ?? "").trim();
    const previous = connection.repository_url ?? "";
    let confirmation: string | undefined;
    if (previous !== "" && repositoryUrl !== previous) {
      if (!confirmAction(t("repositoryConnection.changeConfirm", { url: repositoryUrl || t("repositoryConnection.removeRemote") }))) return;
      confirmation = repositoryUrl || "REMOVE_REMOTE";
    }
    setBusy(true); setError(null); setResult(null);
    try {
      const updated = await api.updateRepositoryConnection({
        repository_url: repositoryUrl || null,
        gitlab: {
          base_url: String(form.get("gitlab_base_url") ?? "").trim() || null,
          project: String(form.get("gitlab_project") ?? "").trim() || null,
          client_id: String(form.get("gitlab_client_id") ?? "").trim() || null,
        },
        ...(confirmation === undefined ? {} : { confirmation }),
      });
      setConnection(updated);
      setResult(t("repositoryConnection.saved"));
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };

  const test = async () => {
    setBusy(true); setError(null); setResult(null);
    try {
      const checked = await api.testRepositoryConnection();
      setResult(t("repositoryConnection.testPassed", { branch: checked.branch, commit: checked.commit.slice(0, 12) }));
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };

  const login = async () => {
    setBusy(true); setError(null);
    try { window.location.assign(await api.login()); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); setBusy(false); }
  };

  return <section className="card repository-connection-settings">
    <p className="card-lede">{t("repositoryConnection.description")}</p>
    {!maintainer && <div className="alert warning">{t("admin.maintainerOnly")}</div>}
    {(!connection.remote_editable || !connection.gitlab_editable) && <div className="alert info">{t("repositoryConnection.managedExternally")}</div>}
    {error !== null && <div className="alert error">{error}</div>}{result !== null && <div className="alert success">{result}</div>}
    <dl className="status-grid">
      <div><dt>{t("repositoryConnection.checkout")}</dt><dd><code>{connection.repository_path}</code></dd></div>
      <div><dt>{t("repositoryConnection.mode")}</dt><dd>{connection.repository_mode}</dd></div>
      <div><dt>{t("repositoryConnection.branch")}</dt><dd><code>{connection.default_branch}</code></dd></div>
      <div><dt>{t("repositoryConnection.source")}</dt><dd>{connection.remote_source}</dd></div>
    </dl>
    <form className="editor-drawer-form" onSubmit={save} key={`${connection.repository_url ?? ""}:${connection.gitlab.client_id ?? ""}`}>
      <label>{t("repositoryConnection.repositoryUrl")}<input name="repository_url" type="url" placeholder="https://gitlab.example/group/project.git" defaultValue={connection.repository_url ?? ""} disabled={!editable || busy} /></label>
      <div className="admin-columns">
        <label>{t("repositoryConnection.gitlabUrl")}<input name="gitlab_base_url" type="url" placeholder="https://gitlab.example" defaultValue={connection.gitlab.base_url ?? ""} disabled={!editable || busy} /></label>
        <label>{t("repositoryConnection.gitlabProject")}<input name="gitlab_project" placeholder="group/project" defaultValue={connection.gitlab.project ?? ""} disabled={!editable || busy} /></label>
        <label>{t("repositoryConnection.clientId")}<input name="gitlab_client_id" defaultValue={connection.gitlab.client_id ?? ""} disabled={!editable || busy} /></label>
      </div>
      <p>{t("repositoryConnection.securityHint")}</p>
      <div className="editor-drawer-actions">
        <button type="button" disabled={busy || !connection.gitlab.configured} onClick={() => { void login(); }}>{t("repositoryConnection.login")}</button>
        <button type="button" disabled={busy || !connection.gitlab.configured} onClick={() => { void test(); }}>{t("repositoryConnection.test")}</button>
        <button className="primary" disabled={!editable || busy}>{t("core.save")}</button>
      </div>
    </form>
  </section>;
}
