import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Logger } from "../../logging/logger.js";
import type { InputSelectorFn } from "./item-selector.js";
import { errorMessage } from "@operator/core";

/**
 * Discovery selector — used by the v5 `research` stage. Reads a directory of
 * analyzer markdown files (defaults to `.operator/analyst/*.md` — the v4
 * convention kept for workspace compatibility) and returns a SINGLE
 * {@link import("../types.js").StageInput} whose `data` carries the full
 * analyzer batch plus the scope date. The stage's `beforeAgent` hook iterates
 * analyzers, invokes the analyst agent once per entry, and aggregates findings
 * (v4 parity — one research PR per day, regardless of analyzer count).
 *
 * Rationale for batch-per-cycle: the
 * v4 research stage semantically produces ONE PR per day with N findings;
 * splitting into N runStage invocations would require workspace-scope to
 * reuse the same branch N times and persist to coalesce N commits into one
 * PR. Keeping the iteration internal to the stage keeps `run-stage.ts`
 * simple and matches the single-PR-per-cycle contract.
 *
 * Decision flow:
 *
 *   1. Read `selectorConfig.discoveryDir` (default `.operator/analyst`).
 *   2. Enumerate `*.md` entries alphabetically (deterministic ordering).
 *      Non-readable directory → null (skip with reason `no-analyzer-dir`).
 *   3. Parse each analyzer's frontmatter (`schedule`, `enabled`, optional
 *      `path`). Skip `enabled: false`. Skip `schedule` that does not match
 *      the caller's current day-of-week via {@link shouldRunAnalyzer}.
 *   4. Return `{scopeKey: todayDate, data: {date, analyzers}, reason}`
 *      with the filtered list. When zero analyzers survive filtering
 *      → null (skip with reason `no-eligible-analyzers`).
 */

/** Analyzer definition extracted from a `.operator/analyst/*.md` file. */
export interface AnalyzerDef {
  readonly id: string;
  readonly schedule: string;
  readonly enabled: boolean;
  readonly path?: string;
  readonly body: string;
}

/** Payload carried inside {@link import("../types.js").StageInput}.data. */
export interface DiscoveryPayload {
  /** `YYYYMMDD` scope key — shared across all analyzers this cycle. */
  readonly date: string;
  /** Alphabetically-ordered analyzers that passed the schedule filter. */
  readonly analyzers: readonly AnalyzerDef[];
}

/**
 * Day-of-week schedule filter. Ported from v4 `runAnalyzers` so existing
 * analyzer frontmatter keeps working without migration. Accepted values:
 *
 *   - `""` / `"daily"` / `"unknown"` → always runs
 *   - `"on-demand"` → never runs in automatic mode
 *   - `"weekly"` → runs on `retroDay`
 *   - `"weekly:N"` → runs on day-of-week `N` (Monday=1…Sunday=7)
 */
export function shouldRunAnalyzer(
  schedule: string,
  currentDow: number,
  retroDay: number,
): boolean {
  if (!schedule || schedule === "daily") return true;
  if (schedule === "on-demand") return false;
  if (schedule === "weekly") return currentDow === retroDay;
  const weeklyMatch = schedule.match(/^weekly:(\d)$/);
  if (weeklyMatch) return currentDow === parseInt(weeklyMatch[1], 10);
  return true;
}

/** Parse flat `key: value` frontmatter. Keeps semantics of v4 `parseFrontmatterFields`. */
function parseAnalyzerFrontmatter(block: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const match = line.match(/^(\w[\w_]*):\s*(.*)$/);
    if (match) {
      result[match[1]] = match[2].replace(/^["']|["']$/g, "").trim();
    }
  }
  return result;
}

/**
 * Load analyzer definitions from `discoveryDir`. Alphabetical by filename for
 * determinism (v4 parity: `readdir` is alphabetical on POSIX + NTFS).
 */
export async function loadAnalyzerDefs(
  discoveryDir: string,
  log?: Logger,
): Promise<AnalyzerDef[]> {
  let files: string[];
  try {
    files = await readdir(discoveryDir);
  } catch (err) {
    log?.warn(`discovery: analyzer directory ${discoveryDir} not readable (stage will skip)`, {
      selector: "discovery", discoveryDir, error: errorMessage(err),
    });
    return [];
  }
  files.sort();

  const defs: AnalyzerDef[] = [];
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    try {
      const content = await readFile(join(discoveryDir, file), "utf-8");
      const parts = content.split(/^---\s*$/m);
      if (parts.length < 3) continue;
      const fm = parseAnalyzerFrontmatter(parts[1]);
      defs.push({
        id: basename(file, ".md"),
        schedule: fm.schedule || "daily",
        enabled: fm.enabled !== "false",
        path: fm.path,
        body: parts.slice(2).join("---").trim(),
      });
    } catch (err) {
      log?.warn(`discovery: analyzer file ${file} unreadable (skipping)`, {
        selector: "discovery", file, error: errorMessage(err),
      });
    }
  }
  return defs;
}

export const discoverySelect: InputSelectorFn = async (stageDef, deps, _ctx) => {
  const cfg = stageDef.selectorConfig ?? {};
  const discoveryDir = typeof cfg["discoveryDir"] === "string"
    ? (cfg["discoveryDir"] as string)
    : ".operator/analyst";
  const retroDay = typeof cfg["retroDay"] === "number"
    ? (cfg["retroDay"] as number)
    : 1;
  const date = typeof cfg["date"] === "string"
    ? (cfg["date"] as string)
    : formatDate(new Date());
  const dow = new Date().getUTCDay() || 7; // 0 (Sun) → 7 for ISO Mon..Sun

  const absoluteDir = join(deps.workspacePath, discoveryDir);
  const all = await loadAnalyzerDefs(absoluteDir, deps.log);
  if (all.length === 0) {
    deps.log?.info(`discovery: no analyzers under ${discoveryDir}, stage ${stageDef.name} will skip`, {
      stage: stageDef.name, selector: "discovery", reason: "no-analyzer-dir",
      discoveryDir,
    });
    return null;
  }

  const filtered: AnalyzerDef[] = [];
  for (const analyzer of all) {
    if (!analyzer.enabled) {
      deps.log?.info(`discovery: analyzer ${analyzer.id} disabled, skipping`, {
        stage: stageDef.name, selector: "discovery", analyzerId: analyzer.id,
        reason: "disabled",
      });
      continue;
    }
    if (!shouldRunAnalyzer(analyzer.schedule, dow, retroDay)) {
      deps.log?.info(`discovery: analyzer ${analyzer.id} not due today (schedule=${analyzer.schedule}, dow=${dow})`, {
        stage: stageDef.name, selector: "discovery", analyzerId: analyzer.id,
        reason: "schedule-not-due", schedule: analyzer.schedule, dow,
      });
      continue;
    }
    filtered.push(analyzer);
  }

  if (filtered.length === 0) {
    deps.log?.info(`discovery: ${all.length} analyzer file(s) found, none eligible today — stage ${stageDef.name} will skip`, {
      stage: stageDef.name, selector: "discovery", reason: "no-eligible-analyzers",
      totalAnalyzers: all.length,
    });
    return null;
  }

  deps.log?.info(`discovery: selected ${filtered.length}/${all.length} analyzer(s) for stage ${stageDef.name} (date=${date})`, {
    stage: stageDef.name, selector: "discovery", decision: "proceed",
    date, eligibleCount: filtered.length, totalCount: all.length,
    analyzerIds: filtered.map((a) => a.id),
  });

  const payload: DiscoveryPayload = { date, analyzers: filtered };
  return {
    scopeKey: date,
    data: payload,
    reason: `${filtered.length}-analyzers`,
  };
};

/** `YYYYMMDD` UTC formatter — matches v4 `formatDate`. */
export function formatDate(d: Date): string {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}
