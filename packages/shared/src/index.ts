export const GITPM_VERSION = "0.1.0";

export interface HealthPayload {
  correlation_id: string;
  status: "ok" | "not_ready";
}
