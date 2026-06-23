import { readFile, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, basename } from "node:path";
import type { WorkItemStatus, WorkItemKind, Priority, CodeReview, KindRegistry, KVStore, StatusSources } from "@operator/core";
import type { StateManager } from "@operator/core";
import type { OperationContext } from "@operator/core";
import { reconcileEffectiveStatus, computeDrift } from "@operator/core";
import { observeDevelopFile, observePRLabel, observePRState, observeChecks } from "../pipeline/primitives/observe-status.js";
import { workItemScore } from "../pipeline/primitives/success-score.js";
import type { WorkspaceGit } from "../infra/git.js";
import type { PRManager } from "../delivery/pr-manager.js";

// ── Work item file data ──────────────────────────────────────────────

export interface WorkItemFileData {
  readonly id: string;
  readonly kind: WorkItemKind;
  readonly title: string;
  readonly body: string;
  readonly status: WorkItemStatus;
  readonly priority: Priority;
  readonly source?: string;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly failedAt?: string;
  readonly rejectedAt?: string;
  /**
   * Parent work-item id. Set when a stage spawns a child (today: planner
   * creates tasks from a finding; future workflows declare their own
   * parent kinds in `kinds.yaml`). The kind registry's `parentKinds`
   * declares which kinds may legally appear as a parent.
   */
  readonly parentId?: string;
  readonly dependsOn?: string[];
  readonly previousPrs?: string;
  readonly issueNumber?: number;
  readonly path?: string;
}

// ── File operations (ports task-complete.sh, finding-complete.sh, etc.) ──

/**
 * Create a work item file with YAML frontmatter and markdown body.
 * Returns the full path of the created file.
 */
export async function createWorkItemFile(dir: string, item: WorkItemFileData): Promise<string> {
  const frontmatter = buildFrontmatter(item);
  const content = `---\n${frontmatter}---\n\n${item.body}\n`;
  const filePath = join(dir, `${item.id}.md`);
  await writeFile(filePath, content, "utf-8");
  return filePath;
}

/**
 * Keys that change every cycle as a side-effect of observing fresh state
 * but do NOT represent semantic change to the work item. Stripped from
 * the hash so `updatedAt` only moves when something the user cares about
 * actually changed (status flipped, PR number changed, observation value
 * differs, etc.). Without this projection the per-source `observedAt`
 * timestamps poison the hash and force `updatedAt = now` every cycle.
 */
const HASH_IGNORED_KEYS = new Set(["observedAt"]);

/**
 * Stable JSON serialization with sorted keys — makes content hash
 * insensitive to property-insertion order, so a row written by a patch
 * (`...priorValue`) hashes the same as one written by the full
 * reconcile. Volatile timestamp keys listed in {@link HASH_IGNORED_KEYS}
 * are excluded recursively so re-observation alone never bumps the hash.
 */
function stableStringify(v: unknown): string {
  if (v === undefined) return "undefined";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v as object)
    .filter((k) => !HASH_IGNORED_KEYS.has(k))
    .sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + stableStringify((v as Record<string, unknown>)[k]))
      .join(",") +
    "}"
  );
}

/**
 * Extract the "event signature" of a work-item KV value — the small set
 * of fields a human would recognize as activity. `lastEventAt` only
 * bumps when this signature differs from the prior row, so the UI's
 * activity column reflects real transitions rather than every cycle's
 * bookkeeping write.
 *
 * Watched signals (anything in this set is considered an event):
 *   - `status`                                — lifecycle state changed
 *   - `statusSources.prState.value`           — open → merged / closed
 *   - `statusSources.prLabel.value`           — label transition
 *   - `statusSources.checks.value`            — CI passing/failing/pending
 *   - `statusSources.executionVerdict.executionId` — new verdict pinned
 *   - `recentExecutionIds[0]`                 — newest execution id
 *   - `hasDrift`, `isActive`                  — drift state changes
 *
 * Note: per-source `observedAt` and `recentExecutionIds.length` alone
 * are *not* events. A re-observation that finds the same value, or a
 * re-stamp that does not append a new id, must not bump the column.
 */
function eventSignature(value: Record<string, unknown> | undefined): string {
  if (!value) return "";
  const sources = (value["statusSources"] ?? {}) as Record<string, unknown>;
  const prState = sources["prState"] as { value?: string; prNumber?: number } | undefined;
  const prLabel = sources["prLabel"] as { value?: string } | undefined;
  const checks = sources["checks"] as { value?: string } | undefined;
  const verdict = sources["executionVerdict"] as { executionId?: string } | undefined;
  const recent = (value["recentExecutionIds"] as string[] | undefined) ?? [];
  return JSON.stringify({
    status: value["status"],
    prState: prState?.value,
    prNumber: prState?.prNumber,
    prLabel: prLabel?.value,
    checks: checks?.value,
    verdictExecutionId: verdict?.executionId,
    latestExecutionId: recent[0],
    hasDrift: value["hasDrift"],
    isActive: value["isActive"],
  });
}

/**
 * Stamp a `kv:work-items/{id}` value with `contentHash`, `updatedAt`,
 * and `lastEventAt`.
 *
 * - `contentHash` / `updatedAt` track *any* meaningful row change. Hash
 *   is computed over the next value with `updatedAt`, `contentHash`,
 *   and `lastEventAt` stripped, plus volatile `observedAt` keys filtered
 *   recursively. `updatedAt` carries forward when the hash matches.
 * - `lastEventAt` tracks domain-meaningful events only — see
 *   {@link eventSignature}. The UI's activity column reads this to keep
 *   recently-touched items on top while letting stale rows fall behind.
 *   For brand-new items (no prior) `lastEventAt` seeds from `createdAt`
 *   so the creation event itself is the first activity entry.
 */
export function stampWorkItem<T extends Record<string, unknown>>(
  prior: Record<string, unknown> | undefined,
  next: T,
): Omit<T, "updatedAt" | "contentHash" | "lastEventAt"> & {
  readonly updatedAt: string;
  readonly contentHash: string;
  readonly lastEventAt: string;
} {
  const { updatedAt: _u, contentHash: _h, lastEventAt: _l, ...payload } = next as Record<string, unknown>;
  void _u;
  void _h;
  void _l;
  const hash = createHash("sha256").update(stableStringify(payload)).digest("hex");
  const priorHash =
    typeof prior?.["contentHash"] === "string" ? (prior["contentHash"] as string) : undefined;
  const priorUpdatedAt =
    typeof prior?.["updatedAt"] === "string" ? (prior["updatedAt"] as string) : undefined;
  const now = new Date().toISOString();
  const updatedAt = priorHash === hash && priorUpdatedAt ? priorUpdatedAt : now;

  const priorSignature = eventSignature(prior);
  const nextSignature = eventSignature(payload as Record<string, unknown>);
  const priorLastEventAt =
    typeof prior?.["lastEventAt"] === "string" ? (prior["lastEventAt"] as string) : undefined;
  const createdAt =
    typeof payload["createdAt"] === "string" ? (payload["createdAt"] as string) : undefined;
  const lastEventAt = !prior
    ? createdAt ?? now
    : priorSignature !== nextSignature
      ? now
      : priorLastEventAt ?? createdAt ?? updatedAt;

  return {
    ...(payload as Omit<T, "updatedAt" | "contentHash" | "lastEventAt">),
    updatedAt,
    contentHash: hash,
    lastEventAt,
  };
}

/**
 * Derive a workspace-relative path glob from a work-item body's
 * `## Affected Files` section. Returns undefined when the section is
 * absent or no recognisable file paths can be extracted.
 *
 * Used as fallback when frontmatter does not carry an explicit `path:`
 * field — drives layer-3 / layer-5 filtering in `buildSystemPrompt` so a
 * frontend-only task stops loading the repo's `Source/Backend/**`
 * context (and vice versa). Without this fallback, tasks pre-dating the
 * `path:` frontmatter convention had no way to opt in to context
 * filtering, so a backend-only task carried ~3k chars of frontend rules
 * and vice versa. Discovered 2026-05-20 on a task whose body listed only
 * frontend-test paths yet shipped with the full Backend Operator Context
 * block.
 *
 * Heuristic:
 *   1. Locate first `## Affected Files` section (case-insensitive),
 *      bounded by EOF or the next `##` heading.
 *   2. Extract file paths from backtick-wrapped tokens AND bullet leads.
 *      A token counts as file-like when it contains `/` AND ends with
 *      `.{ext}`.
 *   3. Compute common directory prefix (segments before each path's
 *      last `/`). Require ≥2 shared segments — `Source/Frontend/**` ok,
 *      bare `Source/**` is too broad and falls back to undefined so the
 *      task loads all contexts.
 *   4. Return `{prefix}/**` for direct use with `pathsOverlap`.
 *
 * Conservative defaults: every failure mode returns undefined ("no path
 * hint"), preserving the pre-heuristic behaviour where all context
 * layers load.
 */
export function derivePathFromBody(body: string): string | undefined {
  if (!body) return undefined;
  return deriveFromAffectedFiles(body) ?? deriveFromDomainField(body);
}

/**
 * Task-shape heuristic: scan the `## Affected Files` section for
 * backtick-wrapped or bullet-led file paths and return the common
 * directory glob. Returns undefined when the section is missing or
 * yields no usable signal.
 */
function deriveFromAffectedFiles(body: string): string | undefined {
  const sectionStart = body.search(/^##\s+Affected\s+Files\b/im);
  if (sectionStart === -1) return undefined;
  const after = body.slice(sectionStart);
  const nextSection = after.slice(2).search(/^##\s/m);
  const section = nextSection === -1 ? after : after.slice(0, nextSection + 2);

  const paths = new Set<string>();
  const fileLike = /([A-Za-z][\w.-]*(?:\/[\w.-]+)+\.[A-Za-z]+)/;
  for (const match of section.matchAll(/`([^`\n]+)`/g)) {
    const m = match[1].match(fileLike);
    if (m) paths.add(m[0]);
  }
  for (const match of section.matchAll(/^\s*[-*]\s+([^\s`]+)/gm)) {
    const m = match[1].match(fileLike);
    if (m) paths.add(m[0]);
  }
  if (paths.size === 0) return undefined;

  const segArrays = [...paths].map((p) => {
    const idx = p.lastIndexOf("/");
    const dir = idx === -1 ? "" : p.slice(0, idx);
    return dir.split("/").filter(Boolean);
  });
  if (segArrays.some((a) => a.length === 0)) return undefined; // top-level file kills the heuristic
  const minLen = Math.min(...segArrays.map((a) => a.length));
  let depth = 0;
  for (let i = 0; i < minLen; i++) {
    if (segArrays.every((a) => a[i] === segArrays[0][i])) depth++;
    else break;
  }
  if (depth < 2) return undefined; // require ≥2 shared segments
  const prefix = segArrays[0].slice(0, depth).join("/");
  return `${prefix}/**`;
}

/**
 * Finding-shape heuristic: extract the `**Domain**: <path>` key-value
 * pair findings emit instead of an Affected Files section (see analyst
 * prompt template). The value is a directory path; convert to a glob.
 *
 * Discovered 2026-05-20 when PR-888 (F20260322-0004) shipped both
 * Backend and Frontend operator context blocks despite the finding's
 * domain being `Source/Frontend/src/shared/components/fields/` —
 * `## Affected Files` heuristic returned undefined because findings
 * don't carry that section.
 */
function deriveFromDomainField(body: string): string | undefined {
  const match = body.match(/\*\*Domain\*\*:\s*([^\s`*\n]+)/i);
  if (!match) return undefined;
  const raw = match[1].replace(/[/]+$/, ""); // strip trailing slashes
  const segs = raw.split("/").filter(Boolean);
  if (segs.length < 2) return undefined; // top-level / single-segment too broad
  return `${segs.join("/")}/**`;
}

/**
 * Read and parse a work item file. Returns structured data.
 */
export async function readWorkItemFile(filePath: string): Promise<WorkItemFileData> {
  const content = await readFile(filePath, "utf-8");
  return parseWorkItemContent(content, filePath);
}

/**
 * Parse work item content (frontmatter + body) into structured data.
 * Kind inference uses the static F/T/R prefix convention that matches
 * the shipped {@link KindRegistry} (idPrefix = F / T / R). New kinds
 * that follow the same `{idPrefix}{date}-{seq}` scheme are inferred
 * automatically via {@link inferKindFromId} when a registry is passed.
 */
export function parseWorkItemContent(
  content: string,
  filePath: string,
  registry?: KindRegistry,
): WorkItemFileData {
  const parts = content.split(/^---\s*$/m);
  if (parts.length < 3) {
    throw new Error(`Invalid frontmatter in ${filePath}`);
  }

  const fm = parseFrontmatterFields(parts[1]);
  const body = parts.slice(2).join("---").trim();
  const id = fm.id || basename(filePath, ".md");
  const kind = fm.kind || fm.type || inferKindFromId(id, registry);

  return {
    id,
    kind,
    title: fm.title || "untitled",
    body,
    status: (fm.status as WorkItemStatus) || "pending",
    priority: parsePriority(fm.priority),
    source: fm.source,
    createdAt: fm.created_at || "",
    startedAt: fm.started_at,
    completedAt: fm.completed_at,
    failedAt: fm.failed_at,
    rejectedAt: fm.rejected_at,
    parentId: fm.parent_id || undefined,
    dependsOn: fm.depends_on ? fm.depends_on.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    previousPrs: fm.previous_prs,
    issueNumber: fm.issue_number ? parseInt(fm.issue_number, 10) : undefined,
    // Explicit frontmatter `path:` wins; fall back to body-derived path
    // (`## Affected Files` heuristic) so tasks pre-dating the path
    // frontmatter convention still get per-task context filtering.
    path: fm.path || derivePathFromBody(body),
  };
}

/**
 * Update work item status in-place. Adds appropriate timestamp.
 * Ports task-complete.sh / finding-complete.sh / task-start.sh / finding-start.sh.
 */
export async function updateWorkItemFileStatus(
  filePath: string,
  newStatus: WorkItemStatus,
  timestamp?: string,
): Promise<void> {
  const ts = timestamp || new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  let content = await readFile(filePath, "utf-8");

  // Update status field
  content = replaceFrontmatterField(content, "status", newStatus);

  // Add/update timestamp based on status
  const tsField = statusTimestampField(newStatus);
  if (tsField) {
    content = upsertFrontmatterField(content, tsField, `"${ts}"`);
  }

  await writeFile(filePath, content, "utf-8");
}

// ── DB sync ──────────────────────────────────────────────────────────

/**
 * Sync a work item file to the StateManager DB cache.
 */
export async function syncWorkItemToDb(
  state: StateManager,
  ctx: OperationContext,
  item: WorkItemFileData,
): Promise<void> {
  await state.upsertWorkItem(ctx, {
    id: item.id,
    kind: item.kind,
    title: item.title,
    body: item.body,
    status: item.status,
    priority: item.priority,
    source: item.source,
    createdAt: item.createdAt,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Update work item status in file AND sync to DB in one call.
 * Replaces the scattered pattern of updateWorkItemFileStatus + syncWorkItemToDb.
 * Re-reads the file after updating to ensure DB matches file state.
 */
export async function updateStatusAndSync(
  filePath: string,
  newStatus: WorkItemStatus,
  state: StateManager,
  ctx: OperationContext,
): Promise<WorkItemFileData> {
  await updateWorkItemFileStatus(filePath, newStatus);
  const updated = await readWorkItemFile(filePath);
  await syncWorkItemToDb(state, ctx, updated);
  return updated;
}

/**
 * Optional deps for the observability reconciliation phase of
 * {@link syncFilesToState} (Step 14). When provided, every synced item is
 * also observed (develop-file + PR label), reconciled via
 * `reconcileEffectiveStatus`, and written into `kv:work-items/{id}` with
 * `statusSources` / `hasDrift` / `driftDetails` columns. When omitted, the
 * sync runs exactly as before (StateManager-only, no KV observations —
 * used by tests that do not care about the observation layer).
 */
export interface SyncObservationDeps {
  readonly kv: KVStore;
  readonly git: Pick<WorkspaceGit, "headSha">;
  readonly prManager: Pick<PRManager, "findOpenPR">;
  /**
   * VCS handle used by `observePRState` to detect merged/closed state.
   * Optional — when omitted, `prState` is not observed (drift always uses
   * the label-only codepath, falling back to pre-1.1 behavior).
   */
  readonly vcs?: Pick<import("@operator/core").VCSPlatform, "getCodeReviews" | "getCheckRuns">;
  readonly workspacePath: string;
  /** Branch prefix under which per-kind feature branches live (e.g. `ai/tasks`). */
  readonly branchPrefixFor: (kind: WorkItemKind) => string | null;
}

/**
 * Sync all work item files to StateManager DB cache.
 *
 * Scans every `{idPrefix}{...}.md` file under the per-kind `dataDirFor(kind)`
 * that the registry exposes. Called once per repo at the start of each cycle
 * to ensure DB reflects file state (files are source of truth, DB is a query
 * cache — architecture-v5.md §6.3).
 *
 * When `observations` deps are provided, each synced item also writes its
 * reconciled row into `kv:work-items/{id}` with observation slots populated
 * (Step 14).
 */
export async function syncFilesToState(
  registry: KindRegistry,
  workspacePath: string,
  state: StateManager,
  ctx: OperationContext,
  observations?: SyncObservationDeps,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  // Cross-kind aggregation cache populated during the per-kind scan
  // below and consumed by the post-sync `aggregateDerivedCompletions`
  // pass — maps parent_id → list of {kind, status} for every child item
  // seen on develop. Built here (vs re-iterating files later) so the
  // statuses we read are the freshly reconciled values, not pre-sync
  // stale rows from SQLite.
  const childrenByParent = new Map<string, { kind: WorkItemKind; status: WorkItemStatus }[]>();
  // `kindDef.dataDir` is the workspace-relative path (e.g. `.operator/data/tasks`)
  // — the kind registry IS the single source of truth for per-kind paths
  // after the 2026-05-14 d16d88b dataDir-prefix fix. Reading the dir is
  // therefore one join against the workspace root; any second prefix
  // here re-introduces the double-prefix bug that caused syncFilesToState
  // to see zero files on a real repo (hundreds of tasks and findings on
  // develop, engine reported `0 finding, 0 task` until the 2026-05-20
  // regression fix realigned the caller contract with the new registry
  // shape).
  for (const kindDef of registry.all) {
    const dir = join(workspacePath, kindDef.dataDir);
    const files = await safeReaddir(dir);
    // Pre-compute the set of IDs visible on develop right now. Drives
    // the post-loop reconciliation below — anything tracked in DB but
    // missing from this set is an orphan and gets evicted. We use the
    // file LIST (not successfully-parsed items) so a transient parse
    // error on one cycle never triggers a delete: as long as the file
    // is present in the directory, its id stays alive.
    const seenIds = new Set<string>();
    for (const file of files) {
      if (!file.startsWith(kindDef.idPrefix) || !file.endsWith(".md")) continue;
      seenIds.add(file.slice(0, -".md".length));
    }
    let count = 0;
    for (const file of files) {
      if (!file.startsWith(kindDef.idPrefix) || !file.endsWith(".md")) continue;
      try {
        const item = await readWorkItemFile(join(dir, file));
        // Reconcile first when observations available — produces the
        // authoritative computed status from KV's prior row + develop
        // file + PR label + last execution verdict. Then mirror that
        // computed status (not the raw file literal) to SQLite so the
        // selector sees the same truth the reconciler computed.
        //
        // Pre-fix bug: SQLite was written with `item.status` (raw
        // develop literal) BEFORE reconciliation, so the selector
        // saw stale `pending` for findings whose previous run had
        // already set KV status=rejected — re-picked them every cycle
        // until attemptCount cap (PR-on-PR loop). File is authoritative
        // for content (title/body/priority/source), NOT for current
        // lifecycle status. Status flips through executions + reconciler.
        let statusForDb: WorkItemStatus = item.status;
        if (observations) {
          const relKindDir = kindDef.dataDir.replace(/\\/g, "/");
          statusForDb = await reconcileAndWrite(item, relKindDir, registry, observations, ctx);
        }
        await syncWorkItemToDb(state, ctx, { ...item, status: statusForDb });
        if (item.parentId) {
          const arr = childrenByParent.get(item.parentId) ?? [];
          arr.push({ kind: item.kind, status: statusForDb });
          childrenByParent.set(item.parentId, arr);
        }
        count++;
      } catch {
        // Skip unreadable files — files are source of truth but best-effort on read.
      }
    }
    counts[kindDef.name] = count;

    // Reconcile deletions: drop DB rows (and their KV mirrors) for
    // ids of this kind that no longer have a develop file. Without
    // this the per-item selector keeps re-picking phantom tasks
    // (root cause of T20260416-000102 ENOENT failures: a finding-plan
    // task whose feature branch never merged sits forever in
    // `work_items` while its file lives only on the abandoned
    // branch). The kv:work-items mirror is also evicted so the App
    // UI's lifecycle column doesn't show ghosts.
    const dbItems = await state.listWorkItems(ctx, { kind: kindDef.name });
    for (const dbItem of dbItems) {
      if (seenIds.has(dbItem.id)) continue;
      await state.deleteWorkItem(ctx, dbItem.id);
      if (observations?.kv) {
        await observations.kv.delete("work-items", dbItem.id);
      }
    }
  }

  // Post-sync derivation: promote `merged` parents to `completed` once
  // every child is terminal. Runs AFTER all kinds are reconciled so the
  // child statuses we read are the post-reconcile values, not pre-sync
  // stale rows. Requires `observations.kv` to keep the KV mirror aligned
  // with SQLite — skipped when observations are absent (test paths).
  if (observations) {
    await aggregateDerivedCompletions(registry, state, ctx, observations, childrenByParent);
  }
  return counts;
}

/**
 * Promote parent work items to `completed` once every child reaches a
 * terminal status. Runs once per cycle from {@link syncFilesToState}
 * after the per-kind reconcile pass has populated the children map.
 *
 * Rule:
 *   - parent currently in `merged` status (terminal-success on its own
 *     PR — planner work is done)
 *   - AND parent has at least one child indexed in `childrenByParent`
 *   - AND every child is in the kind registry's terminal set for its
 *     own kind (kindRegistry.isTerminal)
 *   → write `status: completed` to both the KV record and SQLite mirror
 *
 * `completed` MUST be present in the parent kind's `terminalStatuses`
 * (kinds.yaml) so the per-item selector continues filtering the
 * promoted parent — otherwise the selector would re-pick a "fully
 * done" item and trigger a redundant planner re-run.
 *
 * Idempotent: a second pass that finds the parent already at
 * `completed` does nothing (the `merged`-only candidate filter
 * short-circuits subsequent runs).
 */
export async function aggregateDerivedCompletions(
  registry: KindRegistry,
  state: StateManager,
  ctx: OperationContext,
  observations: Pick<SyncObservationDeps, "kv">,
  childrenByParent: ReadonlyMap<string, { kind: WorkItemKind; status: WorkItemStatus }[]>,
): Promise<void> {
  const parentKindNames = new Set<string>();
  for (const kindDef of registry.all) {
    for (const pk of kindDef.parentKinds ?? []) {
      parentKindNames.add(pk);
    }
  }
  if (parentKindNames.size === 0) return;

  for (const parentKind of parentKindNames) {
    const candidates = await state.listWorkItems(ctx, {
      kind: parentKind, status: ["merged", "accepted"],
    });
    for (const parent of candidates) {
      const children = childrenByParent.get(parent.id);
      if (!children || children.length === 0) continue;
      const allTerminal = children.every((c) => registry.isTerminal(c.kind, c.status));
      if (!allTerminal) continue;
      const kvEntry = await observations.kv.get("work-items", parent.id);
      if (kvEntry) {
        const value = kvEntry.value as Record<string, unknown>;
        if (value.status !== "completed") {
          await observations.kv.put("work-items", parent.id, { ...value, status: "completed" });
        }
      }
      await state.updateWorkItemStatus(ctx, parent.id, "completed");
    }
  }
}

/**
 * Observe develop-file + PR label for one item, reconcile with the prior KV
 * row, and write back `kv:work-items/{id}` with the full observation layer.
 * Shared by {@link syncFilesToState} and the post-commit re-observation path
 * in `persist-output.ts`.
 *
 * Returns the reconciled computed status so callers (notably
 * {@link syncFilesToState}) can mirror it into SQLite as well, keeping both
 * stores in sync. Without this return value the SQLite mirror would carry
 * the raw develop-file literal which is stale for any work item whose
 * lifecycle advanced past whatever develop currently shows (PR not merged
 * yet, finding rejected by planner, etc.) — that mismatch was the root
 * cause of the PR-on-PR loop fixed alongside this signature change.
 */
export async function reconcileAndWrite(
  item: WorkItemFileData,
  dataDir: string,
  registry: KindRegistry,
  observations: SyncObservationDeps,
  ctx?: OperationContext,
): Promise<WorkItemStatus> {
  const developObs = await observeDevelopFile(
    { id: item.id, kind: item.kind, path: item.path },
    dataDir,
    { git: observations.git, workspacePath: observations.workspacePath, workspaceDataDir: dataDir },
  );

  const prefix = observations.branchPrefixFor(item.kind);
  const branch = prefix ? `${prefix}/${item.id}` : null;
  const prObs = branch
    ? await observePRLabel(branch, { prManager: observations.prManager, vcs: observations.vcs })
    : null;
  const prStateObs = branch && observations.vcs
    ? await observePRState(branch, {
        prManager: observations.prManager,
        vcs: observations.vcs,
        kv: observations.kv,
        ctx,
      })
    : null;
  // CI / pipeline status — fifth observation slot. Only fetched when the
  // current PR is open; once closed, the existing `prState` observation
  // already carries the terminal signal and re-fetching checks is wasted
  // API budget.
  const checksObs = branch && observations.vcs && prStateObs?.value === "open"
    ? await observeChecks(prStateObs.prNumber, { vcs: observations.vcs })
    : null;

  const priorEntry = await observations.kv.get("work-items", item.id);
  const priorValue = (priorEntry?.value ?? {}) as {
    status?: WorkItemStatus;
    developFileStatus?: WorkItemStatus;
    statusSources?: StatusSources;
    recentExecutionIds?: string[];
  };
  const mergedSources: StatusSources = {
    ...(priorValue.statusSources ?? {}),
    developFile: developObs,
    ...(prObs ? { prLabel: prObs } : {}),
    ...(prStateObs ? { prState: prStateObs } : {}),
    ...(checksObs ? { checks: checksObs } : {}),
  };
  const drift = computeDrift(mergedSources);
  const reconciled = reconcileEffectiveStatus({
    sources: mergedSources,
    currentKV: { status: priorValue.status, developFileStatus: priorValue.developFileStatus },
    // Kind-aware terminal set — comes from `kinds.yaml`. PR-bound kinds
    // (finding/task) terminate at `merged`; virtual / DB-only kinds (no
    // PR in the loop) at `completed`. Lets `prState=merged` upgrade only
    // those kinds where merge is the canonical end-state.
    terminalStatuses: registry.terminalStatusesFor(item.kind),
  });

  // 2026-04-20 status-semantics inversion + 2026-05-13 field rename:
  //   top-level `status`        = computed (what the UI shows / selector reads)
  //   `developFileStatus`        = raw develop-file literal (observability only)
  //   `statusReason`             = which source produced `status`
  // The mental model is "status = what's happening now; developFileStatus
  // = what the merged develop branch literally records". UI reads `status`
  // for the primary badge and can fall back to `developFileStatus` for
  // debug / drift display.
  // Success-rate metric: 1 only for terminal SUCCESS (PR merged, or
  // non-PR stage completed), 0 for terminal FAILURE (failed / cancelled
  // / rejected / duplicate), and undefined while still in flight
  // (pending / in-progress / in-review / ready-to-merge / reopened —
  // these may yet turn either way). UI renders undefined as "—" so the
  // metric never bakes in the wrong answer prematurely.
  const computed = reconciled.effectiveStatus;
  // Success-rate metric — continuous score via `workItemScore` primitive.
  // Same lifecycle base table (merged/completed/rejected → 1, failed/
  // cancelled/duplicate → 0, in-flight → undefined) plus penalty
  // multipliers for pr-review cycles past the first (× 0.85 each) and
  // failed executions on the way (× 0.7 each), floored at SCORE_FLOOR.
  // Fetch the execution rows referenced by `recentExecutionIds` so the
  // primitive can read each one's verdict + agent; passing an empty list
  // is harmless (no penalties applied, score = base).
  const recentIds = priorValue.recentExecutionIds ?? [];
  const executionsForScore: { readonly verdict?: string; readonly agent?: string }[] = [];
  const executionEntriesById = new Map<string, { value: Record<string, unknown> }>();
  for (const eid of recentIds) {
    const execEntry = await observations.kv.get("executions", eid);
    if (!execEntry) continue;
    const ev = execEntry.value as Record<string, unknown>;
    executionEntriesById.set(eid, { value: ev });
    executionsForScore.push({
      verdict: typeof ev.verdict === "string" ? ev.verdict : undefined,
      agent: typeof ev.agent === "string" ? ev.agent : undefined,
    });
  }
  const successScore = workItemScore({ status: computed, executions: executionsForScore });

  await observations.kv.put(
    "work-items",
    item.id,
    stampWorkItem(priorEntry?.value as Record<string, unknown> | undefined, {
      id: item.id,
      kind: item.kind,
      title: item.title,
      body: item.body,
      status: reconciled.effectiveStatus,
      statusReason: reconciled.effectiveStatusReason,
      developFileStatus: item.status,
      priority: item.priority,
      source: item.source,
      createdAt: item.createdAt,
      statusSources: mergedSources,
      isActive: drift.isActive,
      hasDrift: drift.hasDrift,
      driftDetails: drift.driftDetails.length > 0 ? drift.driftDetails : undefined,
      recentExecutionIds: priorValue.recentExecutionIds,
      successScore,
    }),
  );

  // Backfill per-execution scores when this work item just transitioned
  // to a terminal lifecycle state. Engine writes `successScore: undefined`
  // (pending) on PR-emitting executions at finalize time; the score is
  // graded here once we know the merged / closed / rejected outcome.
  //
  // Continuous-score semantics (2026-05-20): only PROMOTE pending
  // executions (`successScore` null/undefined) — never overwrite a row
  // that already carries its own per-execution number. The per-execution
  // score reflects "how clean was this particular agent run" (attempts,
  // verdict at THAT moment); the work-item rollup reflects "how well did
  // the item land overall". They are intentionally different signals and
  // overwriting the former with the latter destroys per-attempt detail.
  const wasTerminal = isTerminalStatus(priorValue.status);
  const isTerminalNow = isTerminalStatus(reconciled.effectiveStatus);
  if (!wasTerminal && isTerminalNow && successScore != null) {
    for (const eid of recentIds) {
      const entry = executionEntriesById.get(eid);
      if (!entry) continue;
      const execValue = entry.value as { successScore?: number | null } & Record<string, unknown>;
      if (execValue.successScore != null) continue; // preserve per-execution detail
      await observations.kv.put("executions", eid, {
        ...execValue,
        successScore,
      });
    }
  }
  void registry;
  return reconciled.effectiveStatus;
}

const TERMINAL_WORK_ITEM_STATUSES: ReadonlySet<WorkItemStatus> = new Set([
  "completed", "merged", "accepted", "failed", "cancelled", "rejected", "duplicate",
]);

function isTerminalStatus(s: WorkItemStatus | undefined): boolean {
  return s ? TERMINAL_WORK_ITEM_STATUSES.has(s) : false;
}

// ── State context for agent prompts (ports build_state_context) ──────

export interface StateContextVars {
  readonly KNOWN_ISSUES: string;
  readonly PENDING_TASKS: string;
  readonly RECENTLY_FIXED: string;
  readonly HISTORICAL_PATTERNS: string;
}

/**
 * Build state context variables for agent prompt substitution.
 * Ports `build_state_context()` from agents.sh.
 * Reads from StateManager DB (not files) for efficiency.
 *
 * Finding/task references are resolved against the registry rather than
 * hardcoded — adding a new kind + re-running this builder uses the new
 * kind's `terminalStatuses` with no code changes (§8 contract).
 */
export async function buildStateContext(
  state: StateManager,
  registry: KindRegistry,
  ctx: OperationContext,
): Promise<StateContextVars> {
  // Known Issues — all findings
  const findings = await state.listWorkItems(ctx, { kind: "finding" });
  let knownIssues: string;
  if (findings.length === 0) {
    knownIssues = "(none — no existing findings)";
  } else {
    const lines = findings.map((f) =>
      `- \`${f.source || f.id}\` — ${f.title} (priority: ${f.priority}, status: ${f.status})`,
    );
    knownIssues = `**${findings.length} known findings. DO NOT report these again:**\n\n${lines.join("\n")}`;
  }

  // Pending Tasks — non-terminal
  const allTasks = await state.listWorkItems(ctx, { kind: "task" });
  const pendingTasks = allTasks.filter((t) => !registry.isTerminal("task", t.status));
  const inProgressCount = pendingTasks.filter((t) => t.status === "in-progress").length;
  let pendingTasksStr: string;
  if (pendingTasks.length === 0) {
    pendingTasksStr = "(none — no pending tasks)";
  } else {
    const lines = pendingTasks.map((t) => {
      const marker = t.status === "in-progress" ? ", **in-progress**" : "";
      return `- **${t.id}**: ${t.title} (priority: ${t.priority}${marker})`;
    });
    pendingTasksStr = `**${pendingTasks.length} tasks in queue (${inProgressCount} in-progress). These are ALREADY BEING ADDRESSED:**\n\n${lines.join("\n")}`;
  }

  // Recently Fixed — last 10 completed tasks (reverse sorted)
  const completedTasks = allTasks
    .filter((t) => t.status === "completed")
    .sort((a, b) => b.id.localeCompare(a.id))
    .slice(0, 10);
  let recentlyFixed: string;
  if (completedTasks.length === 0) {
    recentlyFixed = "(none — no recently completed tasks)";
  } else {
    const lines = completedTasks.map((t) =>
      `- **${t.id}**: ${t.title} (${t.updatedAt || "unknown date"})`,
    );
    recentlyFixed = `**${completedTasks.length} recently completed. Verify these are still fixed:**\n\n${lines.join("\n")}`;
  }

  // Historical Patterns — summary stats
  const historical = [
    `- Total known findings: ${findings.length}`,
    `- Pending tasks: ${pendingTasks.length} (${inProgressCount} in-progress)`,
    `- Recently completed: ${completedTasks.length}`,
  ].join("\n");

  return {
    KNOWN_ISSUES: knownIssues,
    PENDING_TASKS: pendingTasksStr,
    RECENTLY_FIXED: recentlyFixed,
    HISTORICAL_PATTERNS: historical,
  };
}

// ── Generic (non-per-kind) work-item queries ─────────────────────────
// These helpers are used by the retrospective stage to aggregate metrics
// across pending items + tasks without reaching into per-kind symbols.

/**
 * List all pending (non-terminal) work items of the given kind by scanning
 * its per-kind data directory. Used by the retrospective stage to build the
 * metrics block.
 */
export async function listPendingItems(
  registry: KindRegistry,
  kind: WorkItemKind,
  workspacePath: string,
): Promise<WorkItemFileData[]> {
  const def = registry.get(kind);
  if (!def) return [];
  const dir = join(workspacePath, def.dataDir);
  const files = await safeReaddir(dir);
  const items: WorkItemFileData[] = [];
  for (const file of files) {
    if (!file.startsWith(def.idPrefix) || !file.endsWith(".md")) continue;
    try {
      const item = await readWorkItemFile(join(dir, file));
      if (registry.isTerminal(kind, item.status)) continue;
      items.push(item);
    } catch {
      // Skip unreadable files — retrospective metrics is best-effort.
    }
  }
  return items;
}

/**
 * List task items grouped by lifecycle state: completed/failed/pending.
 * Used by the retrospective stage for the "Task Statistics" block. Kept
 * task-specific because the retrospective brief partitions the task queue
 * along completed/failed/pending dimensions — other kinds don't have the
 * same semantics.
 */
export async function summarizeTasks(
  registry: KindRegistry,
  workspacePath: string,
): Promise<{
  readonly completed: WorkItemFileData[];
  readonly failed: WorkItemFileData[];
  readonly pending: WorkItemFileData[];
}> {
  const def = registry.get("task");
  if (!def) return { completed: [], failed: [], pending: [] };
  const dir = join(workspacePath, def.dataDir);
  const files = await safeReaddir(dir);
  const completed: WorkItemFileData[] = [];
  const failed: WorkItemFileData[] = [];
  const pending: WorkItemFileData[] = [];
  for (const file of files) {
    if (!file.startsWith(def.idPrefix) || !file.endsWith(".md")) continue;
    try {
      const item = await readWorkItemFile(join(dir, file));
      if (item.status === "completed" || item.status === "duplicate") completed.push(item);
      else if (item.status === "failed" || item.status === "rejected") failed.push(item);
      else pending.push(item);
    } catch {
      // Skip unreadable files.
    }
  }
  return { completed, failed, pending };
}

// ── PR feedback collection (ports run-improver.sh) ──────────────────
// Used by the retrospective stage hook to aggregate user feedback across
// merged + rejected AI PRs. Returns the formatted markdown block; empty string
// on fetch failure (best-effort).

/** Format merged-PR user feedback into a markdown block. */
/**
 * Hard cap on how many merged/rejected AI PRs retrospective iterates per
 * run. Each PR costs two GitHub API calls (issue comments + review
 * comments); Step-17-hotfix sizes this to keep a weekly retrospective
 * under ~40 API calls even on high-volume repos. Stories older than the
 * slice fall off the retrospective brief but remain visible in the UI.
 */
const RETROSPECTIVE_PR_SLICE = 10;

export async function collectMergedPRFeedback(
  vcs: Pick<import("@operator/core").VCSPlatform, "getCodeReviews" | "getComments" | "getReviewComments">,
  commentMarker: string,
): Promise<string> {
  let closedPRs: CodeReview[];
  try {
    closedPRs = await vcs.getCodeReviews({ state: "closed" });
  } catch {
    return "No merged AI PRs this week";
  }
  const merged = closedPRs
    .filter((pr) => pr.merged && pr.branch.startsWith("ai/"))
    .slice(0, RETROSPECTIVE_PR_SLICE);
  if (merged.length === 0) return "No merged AI PRs this week";
  return formatPRFeedback(vcs, merged, commentMarker, "merged");
}

/** Format rejected-PR user feedback into a markdown block. */
export async function collectRejectedPRFeedback(
  vcs: Pick<import("@operator/core").VCSPlatform, "getCodeReviews" | "getComments" | "getReviewComments">,
  commentMarker: string,
): Promise<string> {
  let closedPRs: CodeReview[];
  try {
    closedPRs = await vcs.getCodeReviews({ state: "closed" });
  } catch {
    return "No rejected AI PRs this week";
  }
  const rejected = closedPRs
    .filter((pr) => !pr.merged && pr.branch.startsWith("ai/"))
    .slice(0, RETROSPECTIVE_PR_SLICE);
  if (rejected.length === 0) return "No rejected AI PRs this week";
  return formatPRFeedback(vcs, rejected, commentMarker, "rejected");
}

async function formatPRFeedback(
  vcs: Pick<import("@operator/core").VCSPlatform, "getComments" | "getReviewComments">,
  prs: CodeReview[],
  commentMarker: string,
  kind: "merged" | "rejected",
): Promise<string> {
  const lines: string[] = [];
  for (const pr of prs) {
    lines.push(kind === "rejected" ? `### PR #${pr.id} (REJECTED): ${pr.title}` : `### PR #${pr.id}: ${pr.title}`);
    lines.push(`Branch: \`${pr.branch}\``);
    lines.push("");

    const comments = await vcs.getComments(pr.id);
    const userComments = comments.filter((c) => !c.body.includes(commentMarker));
    if (userComments.length > 0) {
      lines.push(kind === "rejected" ? "**Feedback:**" : "**Comments:**");
      for (const c of userComments) lines.push(`- @${c.author}: ${c.body}`);
      lines.push("");
    }

    const reviewComments = await vcs.getReviewComments(pr.id);
    const userReviewComments = reviewComments.filter((c) => !c.body.includes(commentMarker));
    if (userReviewComments.length > 0) {
      lines.push("**Inline code feedback:**");
      for (const c of userReviewComments) lines.push(`- ${c.path ?? "unknown"}: ${c.body}`);
      lines.push("");
    }

    lines.push("---");
    lines.push("");
  }
  return lines.join("\n");
}

// ── Internal helpers ─────────────────────────────────────────────────

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/**
 * Infer the kind string from a work-item ID.
 *
 * Preferred path (when a registry is supplied): match the longest `idPrefix`
 * across all registered kinds — `F`/`T`/`R` today, any future kind tomorrow.
 * Fallback (no registry — parseWorkItemContent called during tests without
 * a live engine): use the legacy F/T/R prefix heuristic so pre-migration
 * files keep round-tripping.
 */
function inferKindFromId(id: string, registry?: KindRegistry): WorkItemKind {
  if (registry) {
    let bestMatch: { kind: WorkItemKind; prefixLen: number } | null = null;
    for (const def of registry.all) {
      if (id.startsWith(def.idPrefix) && (bestMatch === null || def.idPrefix.length > bestMatch.prefixLen)) {
        bestMatch = { kind: def.name, prefixLen: def.idPrefix.length };
      }
    }
    if (bestMatch) return bestMatch.kind;
  }
  if (id.startsWith("F")) return "finding";
  if (id.startsWith("T")) return "task";
  return "request";
}

function parsePriority(val: string | undefined): Priority {
  if (!val) return 5 as Priority;
  const n = parseInt(val, 10);
  if (n >= 1 && n <= 8) return n as Priority;
  return 5 as Priority;
}

function parseFrontmatterFields(block: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const match = line.match(/^(\w[\w_]*):\s*(.*)$/);
    if (match) {
      result[match[1]] = match[2].replace(/^["']|["']$/g, "").trim();
    }
  }
  return result;
}

function buildFrontmatter(item: WorkItemFileData): string {
  // Kind-agnostic frontmatter writer. Every work item — finding, task,
  // request, or future kind — gets the same field set. Per-kind
  // behaviour (terminal statuses, parent linkage rules, branch prefix)
  // lives in the kind registry, not here.
  const lines: string[] = [];
  lines.push(`id: ${item.id}`);
  lines.push(`title: "${item.title}"`);
  lines.push(`kind: ${item.kind}`);
  if (item.source) lines.push(`source: "${item.source}"`);
  if (item.parentId) lines.push(`parent_id: "${item.parentId}"`);
  lines.push(`priority: ${item.priority}`);
  lines.push(`status: ${item.status}`);
  lines.push(`created_at: "${item.createdAt}"`);
  if (item.startedAt) lines.push(`started_at: "${item.startedAt}"`);
  if (item.completedAt) lines.push(`completed_at: "${item.completedAt}"`);
  if (item.failedAt) lines.push(`failed_at: "${item.failedAt}"`);
  if (item.rejectedAt) lines.push(`rejected_at: "${item.rejectedAt}"`);
  if (item.dependsOn && item.dependsOn.length > 0) {
    lines.push(`depends_on: ${item.dependsOn.join(",")}`);
  }
  if (item.previousPrs) lines.push(`previous_prs: ${item.previousPrs}`);
  if (item.issueNumber) lines.push(`issue_number: ${item.issueNumber}`);
  if (item.path) lines.push(`path: "${item.path}"`);
  return lines.join("\n") + "\n";
}

function statusTimestampField(status: WorkItemStatus): string | null {
  switch (status) {
    case "completed": return "completed_at";
    case "duplicate": return "completed_at";
    case "failed": return "failed_at";
    case "rejected": return "rejected_at";
    case "in-progress": return "started_at";
    default: return null;
  }
}

/**
 * Replace a frontmatter field value in content.
 * Only replaces within the first `---` block.
 */
function replaceFrontmatterField(content: string, field: string, value: string): string {
  const regex = new RegExp(`^(${field}:)\\s*.*$`, "m");
  const parts = content.split(/^---\s*$/m);
  if (parts.length < 3) return content;

  const updated = parts[1].replace(regex, `$1 ${value}`);
  if (updated === parts[1]) return content; // field not found, no change
  parts[1] = updated;
  return parts.join("---");
}

/**
 * Upsert a frontmatter field: update if exists, insert after related field if not.
 */
function upsertFrontmatterField(content: string, field: string, value: string): string {
  const parts = content.split(/^---\s*$/m);
  if (parts.length < 3) return content;

  const regex = new RegExp(`^${field}:\\s*.*$`, "m");
  if (regex.test(parts[1])) {
    // Update existing
    parts[1] = parts[1].replace(regex, `${field}: ${value}`);
  } else {
    // Insert after status or started_at or created_at (whichever comes last)
    const insertAfter = ["started_at", "created_at", "status"];
    let inserted = false;
    for (const anchor of insertAfter) {
      const anchorRegex = new RegExp(`^(${anchor}:.*$)`, "m");
      if (anchorRegex.test(parts[1])) {
        parts[1] = parts[1].replace(anchorRegex, `$1\n${field}: ${value}`);
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      parts[1] = parts[1].trimEnd() + `\n${field}: ${value}\n`;
    }
  }
  return parts.join("---");
}
