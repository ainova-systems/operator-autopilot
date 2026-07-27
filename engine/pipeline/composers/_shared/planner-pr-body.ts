import type { WorkItemFileData } from "../../../work-items/work-items.js";

export interface PlannerPrContent {
  readonly title: string;
  readonly body: string;
  readonly commitMessage: string;
}

export interface PlannerPrShape {
  readonly prPrefix: string;
  readonly displayName: string;
  readonly idVarName: string;
}

export interface PlanPrTemplateDeps extends PlannerPrShape {
  readonly templatesDir: string;
  readonly prTemplate: string;
  readonly loadTemplate: (
    templatesDir: string,
    template: string,
    vars: Record<string, string>,
  ) => Promise<string>;
}

export function buildRejectionPlannerPr(
  item: WorkItemFileData,
  itemId: string,
  rejection: { readonly agentRole: string; readonly reason: string },
  shape: PlannerPrShape,
): PlannerPrContent {
  const title = `${shape.prPrefix} ${itemId}: REJECTED — ${item.title}`;
  const body = [
    `## ${shape.displayName} ${itemId}: rejected by ${rejection.agentRole}`,
    "",
    `**Reason**: ${rejection.reason}`,
    "",
    `**What this PR does**: flips \`status: pending → rejected\` on the ${shape.displayName.toLowerCase()} file so the orchestrator stops re-picking this item.`,
    "",
    `**Original ${shape.displayName.toLowerCase()} body**:`,
    "",
    item.body.slice(0, 1500) + (item.body.length > 1500 ? "\n\n[…truncated]" : ""),
    "",
    "---",
    "",
    `**Reviewer action**: merge this PR to propagate the rejection to develop, or close-without-merge if you disagree — the supervisor will handle override on the next cycle.`,
  ].join("\n");
  const commitMessage = `${shape.displayName} ${itemId}: rejected — ${rejection.reason.slice(0, 80)}`;
  return { title, body, commitMessage };
}

export function buildCatchUpPlannerPr(
  item: WorkItemFileData,
  itemId: string,
  childIds: ReadonlyArray<string>,
  shape: PlannerPrShape,
): PlannerPrContent {
  const title = `${shape.prPrefix} ${itemId} (catch-up): ${item.title}`;
  const body = [
    `## ${shape.displayName} ${itemId}: catch-up — planner skipped`,
    "",
    `**What this PR does**: flips \`status: pending → in-progress\` on the ${shape.displayName.toLowerCase()} file only. No new child items were emitted.`,
    "",
    `**Why planner was skipped**: ${childIds.length} child item(s) for this ${shape.displayName.toLowerCase()} already exist on the base branch:`,
    "",
    ...childIds.map((id) => `- \`${id}\``),
    "",
    `**Reviewer action**: safe to merge as-is — this is the idempotency contract bringing the recorded ${shape.displayName.toLowerCase()} status in line with prior planning.`,
  ].join("\n");
  const commitMessage = `${shape.displayName} ${itemId}: catch-up status flip (${childIds.length} child item(s) already exist)`;
  return { title, body, commitMessage };
}

export async function buildPlanPlannerPr(
  item: WorkItemFileData,
  itemId: string,
  deps: PlanPrTemplateDeps,
): Promise<PlannerPrContent> {
  const title = `${deps.prPrefix} ${itemId}: ${item.title}`;
  const body = await deps
    .loadTemplate(deps.templatesDir, deps.prTemplate, {
      FINDING_ID: itemId,
      [deps.idVarName]: itemId,
      TYPE: item.kind,
      PRIORITY: String(item.priority),
      SOURCE: item.source ?? "unknown",
      ASSUMPTION: item.body.slice(0, 500),
    })
    .catch(() => `## ${deps.displayName} ${itemId}\n\nIn progress.`);
  const commitMessage = `${deps.displayName} ${itemId}: planner emitted child item(s)`;
  return { title, body, commitMessage };
}

export function buildPlannerTerminalComment(
  displayName: string,
  itemId: string,
  disposition: "failed" | "cancelled" | "rejected",
  reason: string,
): string {
  switch (disposition) {
    case "failed":
      return `${displayName} **${itemId}** failed: ${reason}. Remove the failed label to retry.`;
    case "cancelled":
      return `${displayName} **${itemId}** cancelled: ${reason}. Closing PR — no retry will be attempted.`;
    case "rejected":
      return `${displayName} **${itemId}** rejected: ${reason}. Closing PR — the retrospective will regenerate a replacement item with updated scope.`;
  }
}
