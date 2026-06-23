import { access } from "node:fs/promises";
import { join } from "node:path";
import type { InputSelectorFn } from "./item-selector.js";

/**
 * Singleton selector — used by the v5 `retrospective` stage. Emits a single
 * {@link import("../types.js").StageInput} whose `scopeKey` is a time-derived
 * identifier (`YYYYWNN` for weekly stages, `YYYYMMDD` for daily, or a literal
 * string). The `beforeAgent` hook reads scopeKey from payload and drives the
 * stage end-to-end.
 *
 * Skip semantics (v4 parity — behavior-preserving port of the
 * `runImprovement` file-exists short-circuit):
 *
 *   1. When `selectorConfig.requiredFileTemplate` is present, resolve it
 *      against the workspace + scopeKey (e.g. `.operator/data/retrospectives/{scopeKey}.md`)
 *      and skip if the file already exists. This is what made re-running the
 *      retrospective on the same week a no-op in v4.
 *   2. When neither the file check nor `selectorConfig.forceRun` gate this,
 *      return `{ scopeKey, data: {scopeKind, scopeKey}, reason }` so the
 *      caller can compose `branchPrefix/scopeKey`.
 *
 * Decision flow is fully INFO-logged per the v5 observability mandate
 * (`intelligence/rules/typescript.md` — every selector decision is a log).
 */

export type SingletonScopeKind = "week" | "date" | "literal";

/** Payload carried inside {@link import("../types.js").StageInput}.data. */
export interface SingletonPayload {
  readonly scopeKind: SingletonScopeKind;
  readonly scopeKey: string;
}

/** `YYYYMMDD` UTC formatter — matches discovery-selector.formatDate. */
function formatDate(d: Date): string {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * ISO-like week formatter matching the v4 `getCurrentWeek`
 * (`YYYYWNN` with a naive day-of-year / 7 ceil). Accepts an explicit date so
 * tests are deterministic; otherwise reads `Date.now()`.
 */
export function formatWeek(d: Date = new Date()): string {
  const jan1 = new Date(d.getUTCFullYear(), 0, 1);
  const dayOfYear = Math.floor((d.getTime() - jan1.getTime()) / 86_400_000) + 1;
  const weekNum = Math.ceil((dayOfYear + jan1.getUTCDay()) / 7);
  return `${d.getUTCFullYear()}W${String(weekNum).padStart(2, "0")}`;
}

function resolveScopeKey(kind: SingletonScopeKind, cfg: Record<string, unknown>): string {
  if (kind === "literal") {
    const literal = cfg["scopeKey"];
    if (typeof literal !== "string" || literal.length === 0) {
      throw new Error("singleton selector with scopeKind=literal requires selectorConfig.scopeKey string");
    }
    return literal;
  }
  if (kind === "week") return formatWeek();
  return formatDate(new Date());
}

function resolveScopeKind(cfg: Record<string, unknown>): SingletonScopeKind {
  const kind = cfg["scopeKind"];
  if (kind === "week" || kind === "date" || kind === "literal") return kind;
  if (kind === undefined) return "literal"; // safe default — caller must supply scopeKey
  throw new Error(`singleton selector: unknown scopeKind "${String(kind)}"`);
}

/**
 * Singleton selector implementation. Registered in the default selector
 * registry under name `"singleton"` (see `./item-selector.ts`).
 */
export const singletonSelect: InputSelectorFn = async (stageDef, deps, _ctx) => {
  const cfg = (stageDef.selectorConfig ?? {}) as Record<string, unknown>;
  const scopeKind = resolveScopeKind(cfg);
  const scopeKey = resolveScopeKey(scopeKind, cfg);

  // Optional workspace-local file-exists skip (v4 parity). The template is
  // expected to contain `{scopeKey}` — the selector substitutes once.
  const template = cfg["requiredFileTemplate"];
  if (typeof template === "string" && template.length > 0) {
    const relPath = template.replace(/\{scopeKey\}/g, scopeKey);
    const absolutePath = join(deps.workspacePath, relPath);
    const exists = await access(absolutePath).then(() => true, () => false);
    if (exists) {
      deps.log?.info(`singleton: ${relPath} already present, stage ${stageDef.name} will skip`, {
        stage: stageDef.name, selector: "singleton", reason: "file-exists",
        scopeKind, scopeKey, file: relPath,
      });
      return null;
    }
  }

  deps.log?.info(`singleton: selected scopeKey=${scopeKey} (kind=${scopeKind}) for stage ${stageDef.name}`, {
    stage: stageDef.name, selector: "singleton", decision: "proceed",
    scopeKind, scopeKey,
  });

  const payload: SingletonPayload = { scopeKind, scopeKey };
  return {
    scopeKey,
    data: payload,
    reason: `${scopeKind}=${scopeKey}`,
  };
};
