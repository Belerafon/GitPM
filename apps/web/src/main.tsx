import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { GITPM_VERSION } from "@gitpm/shared";
import { App } from "./App.js";
import { HttpGitPmApi } from "./api.js";
import { assertLocalePacks } from "./i18n.js";
import { BUILD_COMMIT, BUILD_COMMIT_DATE, BUILD_VERSION } from "./version.js";
import "./styles.css";

assertLocalePacks();
const root = document.querySelector<HTMLElement>("#app");
if (root !== null) {
  root.dataset.gitpmVersion = GITPM_VERSION;
  root.dataset.gitpmBuildVersion = BUILD_VERSION;
  root.dataset.gitpmBuildCommit = BUILD_COMMIT;
  if (BUILD_COMMIT_DATE !== "") root.dataset.gitpmBuildDate = BUILD_COMMIT_DATE;
  createRoot(root).render(<StrictMode><App api={new HttpGitPmApi()} /></StrictMode>);
}
