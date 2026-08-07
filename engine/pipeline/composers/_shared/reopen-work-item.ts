import { readFile, writeFile } from "node:fs/promises";
import type { OperationContext, StateManager } from "@operator/core";
import { syncWorkItemToDb, type WorkItemFileData } from "../../../work-items/work-items.js";

export async function reopenWorkItem(
  filePath: string,
  item: WorkItemFileData,
  prId: number,
  state: StateManager,
  ctx: OperationContext,
): Promise<void> {
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  let content = await readFile(filePath, "utf-8");
  content = content.replace(/^status:\s*.+$/m, "status: reopened");

  if (/^reopened_at:/m.test(content)) {
    content = content.replace(/^reopened_at:\s*.+$/m, `reopened_at: "${timestamp}"`);
  } else {
    content = content.replace(/^(status:\s*.+)$/m, `$1\nreopened_at: "${timestamp}"`);
  }

  const prevPrs = item.previousPrs ? `${item.previousPrs},${prId}` : String(prId);
  if (/^previous_prs:/m.test(content)) {
    content = content.replace(/^previous_prs:\s*.+$/m, `previous_prs: ${prevPrs}`);
  } else {
    content = content.replace(/^(status:\s*.+)$/m, `$1\nprevious_prs: ${prevPrs}`);
  }

  await writeFile(filePath, content, "utf-8");
  await syncWorkItemToDb(state, ctx, {
    ...item, status: "reopened", previousPrs: prevPrs,
  });
}
