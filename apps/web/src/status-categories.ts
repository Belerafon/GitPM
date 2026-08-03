export type StatusCategory = "backlog" | "active" | "done" | "cancelled";

export interface StatusOption {
  readonly slug: string;
  readonly title: string;
  readonly active: boolean;
  readonly category?: StatusCategory;
}

export function isCompletedStatus(options: readonly StatusOption[], slug: string): boolean {
  return options.find((option) => option.slug === slug)?.category === "done";
}

/**
 * Status slugs that mark a task as blocked when the configured status model has no
 * dedicated `blocked` category (the schema only defines backlog/active/done/cancelled).
 */
const BLOCKED_STATUS_SLUGS = ["blocked"];

export function isBlockedStatus(options: readonly { readonly slug: string; readonly category?: string }[], slug: string): boolean {
  const option = options.find((item) => item.slug === slug);
  if (option === undefined) return false;
  return option.category === "blocked" || BLOCKED_STATUS_SLUGS.includes(slug);
}

/**
 * Status slugs that mark a task as being directly executed. The `active` category is
 * too broad because it also covers review and blocked states, so the "In progress"
 * metric must only match this narrower signal.
 */
const IN_PROGRESS_STATUS_SLUGS = ["in-progress"];

/**
 * A task counts as in-progress only when its status is the dedicated in-progress
 * semantic. If a configuration ever introduces an explicit `in-progress` category it
 * wins; otherwise the documented fallback is the `in-progress` slug. Sibling active
 * statuses such as `review` are intentionally excluded.
 */
export function isInProgressStatus(options: readonly { readonly slug: string; readonly category?: string }[], slug: string): boolean {
  const option = options.find((item) => item.slug === slug);
  if (option === undefined) return false;
  return option.category === "in-progress" || IN_PROGRESS_STATUS_SLUGS.includes(slug);
}
