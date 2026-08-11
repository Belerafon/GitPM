import { useEffect, useState, type FormEvent } from "react";
import { ApiError, formatApiError, type GitPmApi } from "./api.js";
import { message, type Locale, type MessageKey } from "./i18n.js";
import type { RepositoryConnectionStatus } from "./types.js";

type ProviderKind = "gitlab" | "ssh" | "https" | "none";

const CONNECTION_ERROR_KEYS: Readonly<Record<string, MessageKey>> = {
  GIT_URL_INVALID: "repositoryConnection.error.GIT_URL_INVALID",
  GITLAB_URL_INVALID: "repositoryConnection.error.GITLAB_URL_INVALID",
  GITLAB_PROJECT_INVALID: "repositoryConnection.error.GITLAB_PROJECT_INVALID",
  GITLAB_CLIENT_ID_INVALID: "repositoryConnection.error.GITLAB_CLIENT_ID_INVALID",
  GITLAB_CONFIGURATION_INCOMPLETE: "repositoryConnection.error.GITLAB_CONFIGURATION_INCOMPLETE",
  GIT_REMOTE_REQUIRED: "repositoryConnection.error.GIT_REMOTE_REQUIRED",
  GIT_REMOTE_PROJECT_MISMATCH: "repositoryConnection.error.GIT_REMOTE_PROJECT_MISMATCH",
  REPOSITORY_CONNECTION_CONFIRMATION_REQUIRED: "repositoryConnection.error.REPOSITORY_CONNECTION_CONFIRMATION_REQUIRED",
  REPOSITORY_CONNECTION_MANAGED_EXTERNALLY: "repositoryConnection.error.REPOSITORY_CONNECTION_MANAGED_EXTERNALLY",
  GITLAB_NOT_CONFIGURED: "repositoryConnection.error.GITLAB_NOT_CONFIGURED",
  SESSION_INVALID: "repositoryConnection.error.SESSION_INVALID",
};

function providerOf(connection: RepositoryConnectionStatus): ProviderKind {
  if (connection.gitlab.configured) return "gitlab";
  if (connection.transport === "ssh") return "ssh";
  if (connection.transport === "http" || connection.transport === "https") return "https";
  return "none";
}

const PROVIDER_LABEL_KEY: Readonly<Record<ProviderKind, MessageKey>> = {
  gitlab: "repositoryConnection.providerGitlab",
  ssh: "repositoryConnection.providerSsh",
  https: "repositoryConnection.providerHttps",
  none: "repositoryConnection.providerNone",
};

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
      .catch((caught) => { if (active) setError(explainError(caught, t)); });
    return () => { active = false; };
  }, [api]);

  if (connection === null) return <section className="card repository-connection-settings">{error === null ? <p>{t("status.loading")}</p> : <div className="alert error">{error}</div>}</section>;
  const editable = maintainer && connection.remote_editable && connection.gitlab_editable;
  const provider = providerOf(connection);
  const hasRemote = connection.repository_url !== undefined;

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
    } catch (caught) { setError(explainError(caught, t)); }
    finally { setBusy(false); }
  };

  const test = async () => {
    setBusy(true); setError(null); setResult(null);
    try {
      const checked = await api.testRepositoryConnection();
      setResult(t("repositoryConnection.testPassed", { branch: checked.branch, commit: checked.commit.slice(0, 12) }));
    } catch (caught) { setError(explainError(caught, t)); }
    finally { setBusy(false); }
  };

  const login = async () => {
    setBusy(true); setError(null);
    try { window.location.assign(await api.login()); }
    catch (caught) { setError(explainError(caught, t)); setBusy(false); }
  };

  const showLoginDisabledHint = provider !== "gitlab" && !connection.gitlab.configured;

  return <section className="card repository-connection-settings">
    <p className="card-lede">{t("repositoryConnection.description")}</p>
    {!maintainer && <div className="alert warning">{t("admin.maintainerOnly")}</div>}
    {(!connection.remote_editable || !connection.gitlab_editable) && <div className="alert info">{t("repositoryConnection.managedExternally")}</div>}
    {error !== null && <div className="alert error">{error}</div>}{result !== null && <div className="alert success">{result}</div>}
    <dl className="status-grid">
      <div><dt>{t("repositoryConnection.providerLabel")}</dt><dd>{t(PROVIDER_LABEL_KEY[provider])}</dd></div>
      <div><dt>{t("repositoryConnection.checkout")}</dt><dd><code>{connection.repository_path}</code></dd></div>
      <div><dt>{t("repositoryConnection.mode")}</dt><dd>{connection.repository_mode}</dd></div>
      <div><dt>{t("repositoryConnection.branch")}</dt><dd><code>{connection.default_branch}</code></dd></div>
      <div><dt>{t("repositoryConnection.source")}</dt><dd>{connection.remote_source}</dd></div>
    </dl>
    <form className="editor-drawer-form" onSubmit={save} key={`${connection.repository_url ?? ""}:${connection.gitlab.client_id ?? ""}`}>
      <h3 className="form-section-title">{t("repositoryConnection.originSection")}</h3>
      <label>{t("repositoryConnection.repositoryUrl")}
        <input inputMode="url" name="repository_url" type="text" placeholder="http://gitlab.local/group/project.git  или  git@gitlab.local:group/project.git" defaultValue={connection.repository_url ?? ""} disabled={!editable || busy} />
      </label>
      <p className="field-help">{t("repositoryConnection.originHelp")}</p>

      <h3 className="form-section-title">{t("repositoryConnection.gitlabSection")}</h3>
      <p className="field-help">{t("repositoryConnection.gitlabSectionHelp")}</p>
      <div className="admin-columns">
        <label>{t("repositoryConnection.gitlabUrl")}<input name="gitlab_base_url" type="url" placeholder="http://gitlab.local" defaultValue={connection.gitlab.base_url ?? ""} disabled={!editable || busy} /></label>
        <label>{t("repositoryConnection.gitlabProject")}<input name="gitlab_project" placeholder="group/project" defaultValue={connection.gitlab.project ?? ""} disabled={!editable || busy} /></label>
        <label>{t("repositoryConnection.clientId")}<input name="gitlab_client_id" placeholder="application-id" defaultValue={connection.gitlab.client_id ?? ""} disabled={!editable || busy} /></label>
      </div>
      <p className="field-help">{t("repositoryConnection.gitlabUrlHelp")}</p>
      <p className="field-help">{t("repositoryConnection.gitlabProjectHelp")}</p>
      <p className="field-help">{t("repositoryConnection.clientIdHelp")}</p>

      {provider === "gitlab" && <div className="alert info">{t(
        connection.gitlab.auth_mode === "oauth-identity-project-token"
          ? "repositoryConnection.credentialNoteIdentityProjectToken"
          : "repositoryConnection.credentialNote",
      )}</div>}
      {provider === "ssh" && <div className="alert info">{t("repositoryConnection.sshNote")}</div>}
      {provider === "https" && <div className="alert info">{t("repositoryConnection.httpsTokenNote")}</div>}
      {provider !== "gitlab" && hasRemote && <div className="alert info">{t("repositoryConnection.mrNote")}</div>}

      <p className="field-help">{t("repositoryConnection.securityHint")}</p>
      <div className="editor-drawer-actions">
        <button type="button" disabled={busy || !connection.gitlab.configured} onClick={() => { void login(); }}>{t("repositoryConnection.login")}</button>
        <button type="button" disabled={busy || !hasRemote} onClick={() => { void test(); }}>{t("repositoryConnection.test")}</button>
        <button className="primary" disabled={!editable || busy}>{t("core.save")}</button>
      </div>
      {showLoginDisabledHint && <p className="field-help">{t("repositoryConnection.buttonsDisabledHint")}</p>}
    </form>
  </section>;

  function explainError(reason: unknown, translate: (key: MessageKey) => string): string {
    if (reason instanceof ApiError) {
      const key = CONNECTION_ERROR_KEYS[reason.code];
      if (key !== undefined) return translate(key);
    }
    return formatApiError(reason);
  }
}
