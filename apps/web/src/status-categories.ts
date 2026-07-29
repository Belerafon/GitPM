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
