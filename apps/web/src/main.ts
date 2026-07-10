import { GITPM_VERSION } from "@gitpm/shared";

const root = document.querySelector<HTMLElement>("#app");

if (root !== null) {
  root.dataset.gitpmVersion = GITPM_VERSION;
}
