import { access } from "node:fs/promises";
import { join } from "node:path";
import type {
  OperationContext, StateManager, KindRegistry, KVStore,
  WorkItem, WorkItemKind, WorkItemStatus, WorkflowStageEntry,
} from "@operator/core";
import type { Logger } from "../../logging/logger.js";

/**
 * Rejection-learning brief — the durable half of the two-layer dedup model.
 *
 * The analyst dedup window (KNOWN_ISSUES) is deliberately bounded so it never
 * grows forever. Durable knowledge — "this kind of finding is a false positive,
 * stop reporting it" — must therefore move INTO the analyzer prompts. This
 * primitive produces the input the retrospective agent needs to do that: per
 * discovery-analyzer, the findings it produced that were REJECTED (false
 * positive) or marked DUPLICATE, plus the path to that analyzer's prompt file.
 * The retrospective agent then proposes additive edits to those prompts.
 *
 * Config-driven — NOTHING here hardcodes a stage name, kind, or path:
 *   - discovery stages (and their `discoveryDir` + output `kind`) come from
 *     `kv:workflow-stages/*` (rows whose `selector` is `discovery`);
 *   - a finding maps to its analyzer via the AOP `source` convention
 *     (`"{analyzerId}#..."`); the prompt file is `{discoveryDir}/{analyzerId}.md`.
 *
 * Read-only: no KV writes, no git, no agent calls. The retrospective composer
 * appends the returned markdown to the improver's metrics brief.
 */

/** Cap per analyzer so the brief stays bounded regardless of backlog size. */
const MAX_REJECTIONS_PER_ANALYZER = 10;

/** Statuses that signal "the engine's judgment was that this finding was wrong". */
const LEARNABLE_STATUSES: readonly WorkItemStatus[] = ["rejected", "duplicate"];

export interface RejectionLearningDeps {
  readonly state: StateManager;
  readonly kv: KVStore;
  readonly registry: KindRegistry;
  /** Workspace root — analyzer prompt files resolve under it. */
  readonly workspacePath: string;
  readonly log?: Logger;
}

interface DiscoveryTarget {
  readonly discoveryDir: string;
  readonly kind: WorkItemKind;
}

/** Resolve discovery stages → their analyzer dir + output kind, from config. */
async function discoveryTargets(kv: KVStore): Promise<DiscoveryTarget[]> {
  const rows = await kv.list("workflow-stages");
  const targets: DiscoveryTarget[] = [];
  for (const row of rows) {
    const stage = row.value as WorkflowStageEntry;
    if (stage?.selector !== "discovery") continue;
    const kind = stage.outputSink?.kind;
    const discoveryDir = typeof stage.selectorConfig?.["discoveryDir"] === "string"
      ? (stage.selectorConfig["discoveryDir"] as string)
      : ".operator/analyst";
    if (kind) targets.push({ discoveryDir, kind });
  }
  return targets;
}

/** `"{analyzerId}#..."` → `analyzerId`; skips synthetic sources (`duplicate-of:`). */
function analyzerIdOf(source: string | undefined): string | null {
  if (!source) return null;
  const head = source.split("#")[0]?.trim();
  if (!head || head.includes(":")) return null; // skip `duplicate-of:F...` etc.
  return head;
}

/**
 * Build the markdown "Analyzer Rejection Learning" section, or `""` when there
 * is nothing to learn from (no discovery stages, or no rejected/duplicate
 * findings that map to an existing analyzer prompt file).
 */
export async function buildRejectionLearningBrief(
  deps: RejectionLearningDeps,
  ctx: OperationContext,
): Promise<string> {
  const targets = await discoveryTargets(deps.kv);
  if (targets.length === 0) {
    deps.log?.info("rejection-learning: no discovery stages in config, brief empty", {
      scope: "rejection-learning", reason: "no-discovery-stages",
    });
    return "";
  }

  // analyzerId → { dir, rejected items }, in discovery order.
  const byAnalyzer = new Map<string, { dir: string; items: WorkItem[] }>();

  for (const target of targets) {
    const items = await deps.state.listWorkItems(ctx, {
      kind: target.kind, status: [...LEARNABLE_STATUSES],
    });
    for (const item of items) {
      const analyzerId = analyzerIdOf(item.source);
      if (!analyzerId) continue;
      // POSIX-style relative path — this string is shown to the agent and must
      // read the same on every platform; `join` would emit backslashes on win32.
      const relPath = `${target.discoveryDir}/${analyzerId}.md`;
      const exists = await access(join(deps.workspacePath, relPath)).then(() => true, () => false);
      if (!exists) continue; // only learn for analyzers whose prompt we can edit
      const key = relPath;
      const bucket = byAnalyzer.get(key) ?? { dir: target.discoveryDir, items: [] };
      bucket.items.push(item);
      byAnalyzer.set(key, bucket);
    }
  }

  if (byAnalyzer.size === 0) {
    deps.log?.info("rejection-learning: no rejected findings mapped to an analyzer prompt", {
      scope: "rejection-learning", reason: "no-mappable-rejections",
    });
    return "";
  }

  const blocks: string[] = [];
  let totalRejections = 0;
  for (const [relPath, { items }] of byAnalyzer) {
    const recent = [...items]
      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
      .slice(0, MAX_REJECTIONS_PER_ANALYZER);
    totalRejections += recent.length;
    const lines = recent
      .map((i) => `- ${i.id} [${i.status}]: ${i.title}`)
      .join("\n");
    blocks.push(`### Prompt \`${relPath}\` — ${recent.length} rejected/duplicate finding(s)\n${lines}`);
  }

  deps.log?.info(
    `rejection-learning: ${totalRejections} rejection(s) across ${byAnalyzer.size} analyzer prompt(s)`,
    { scope: "rejection-learning", analyzers: byAnalyzer.size, rejections: totalRejections },
  );

  const header = [
    "## Analyzer Rejection Learning",
    "",
    "These analyzer prompts produced findings that were REJECTED (false positive) or",
    "marked DUPLICATE. For each prompt file below: read it, and add or extend a concise",
    '"Known false-positive patterns — do NOT report" section so the recurring mistake is',
    "not produced again. Edit ONLY the listed analyzer prompt files; keep edits additive",
    "(do not delete analyzers or narrow them beyond what these rejections justify). If a",
    "prompt already covers a pattern, leave it unchanged.",
  ].join("\n");

  return [header, ...blocks].join("\n\n");
}
