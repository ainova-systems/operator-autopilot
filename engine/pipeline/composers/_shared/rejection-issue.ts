import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ConventionsConfig, TrackerPlatform, WorkItemKind } from "@operator/core";
import { errorMessage } from "@operator/core";
import type { TemplateSource } from "../../../agents/kv-template-source.js";
import type { Logger } from "../../../logging/logger.js";
import type { WorkItemFileData } from "../../../work-items/work-items.js";

export interface RejectionIssueDeps {
  readonly tracker?: TrackerPlatform;
  readonly conventions: ConventionsConfig;
  readonly templates?: TemplateSource;
  readonly templatesDir: string;
  readonly log?: Logger;
}

/**
 * Load the `rejected-issue-body.md` template with placeholder substitution.
 * Prefers the KV template source when wired (Step 15 runtime path); falls
 * back to the filesystem read against `templatesDir` only for test harnesses
 * that stub templates on disk without a KV instance.
 */
export async function loadRejectedIssueTemplate(
  deps: RejectionIssueDeps,
  vars: Record<string, string>,
): Promise<string> {
  if (deps.templates) {
    return deps.templates.load("rejected-issue-body.md", vars);
  }
  deps.log?.warn("rejection: TemplateSource missing, falling back to filesystem read", {
    scope: "rejection", templatesDir: deps.templatesDir,
  });
  const templatePath = join(deps.templatesDir, "rejected-issue-body.md");
  let body = await readFile(templatePath, "utf-8");
  for (const [key, value] of Object.entries(vars)) {
    body = body.replaceAll(`{${key}}`, value);
  }
  return body;
}

export async function createRejectionIssue(
  deps: RejectionIssueDeps,
  item: WorkItemFileData,
  kind: WorkItemKind,
  prId: number,
  recommendation: string,
  prevCount: number,
): Promise<void> {
  if (!deps.tracker) return;
  try {
    const prLinks = item.previousPrs
      ? item.previousPrs.split(",").map((n) => `- #${n.trim()}`).join("\n") + `\n- #${prId}`
      : `- #${prId}`;

    const template = await loadRejectedIssueTemplate(deps, {
      ITEM_TYPE: kind,
      ITEM_TITLE: item.title,
      ITEM_ID: item.id,
      PRIORITY: String(item.priority),
      RECOMMENDATION: recommendation,
      ATTEMPT_COUNT: String(prevCount + 1),
      ITEM_BODY: item.body,
      REJECTION_REPORT: `Rejected after ${prevCount + 1} attempt(s)`,
      PR_LINKS: prLinks,
    });

    const manualLabel = deps.conventions.labels.manual || "ai:manual";
    if (deps.tracker.createWorkItem) {
      await deps.tracker.createWorkItem({
        title: `[${manualLabel}] ${kind} ${item.id}: ${item.title}`,
        body: template,
        labels: [manualLabel],
      });
    }
  } catch (err) {
    deps.log?.error(`rejection: manual-issue creation failed for ${item.id}`, {
      scope: "rejection", itemId: item.id, error: errorMessage(err),
    });
  }
}
