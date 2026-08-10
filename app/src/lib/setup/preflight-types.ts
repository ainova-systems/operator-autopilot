/**
 * Shape of a preflight report, kept free of imports so a client component
 * can describe the payload it renders without pulling the server-only
 * modules (`node:fs`, `better-sqlite3`) that produce it into the browser
 * bundle.
 */
export type CheckStatus = "pass" | "warn" | "fail";

export interface PreflightCheck {
  readonly id: string;
  readonly label: string;
  readonly status: CheckStatus;
  readonly detail: string;
  readonly hint?: string;
}

export interface PreflightReport {
  readonly checks: readonly PreflightCheck[];
  /** False when at least one check failed — the wizard blocks on this. */
  readonly ok: boolean;
}
