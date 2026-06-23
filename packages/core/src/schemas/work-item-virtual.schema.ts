import { z } from "zod";

/**
 * Virtual work-item row schema — `kv:work-items-virtual/{id}`.
 *
 * Mirror of `WorkItemRecord` from the source interface. Used by kinds
 * whose home is the KV store (D-502 virtual outcomes / Phase 5.0 F9):
 * `retrospective-cycle`, `agent-improvement`, future analytics kinds —
 * anything that has no markdown file on develop and never produces a PR
 * keyed by branch.
 *
 * Distinct from `kv:work-items/{id}` (the reconciled-from-file mirror
 * with observability columns) so file-backed and virtual kinds never
 * collide on the same key. The `WorkItemSourceRouter` decides which
 * category a kind reads/writes to by consulting the kind registry's
 * storage mode.
 */
const virtualStatusSchema = z.enum([
  "pending",
  "in-progress",
  "completed",
  "failed",
  "cancelled",
  "rejected",
  "duplicate",
  "reopened",
  "in-review",
  "ready-to-merge",
  "merged",
  "accepted", // T-601 Phase A: non-VCS terminal-success synonym for `merged`.
]);

export const workItemVirtualSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  title: z.string().min(1),
  body: z.string(),
  status: virtualStatusSchema,
  priority: z.number().int().min(1).max(8),
  source: z.string().optional(),
  createdAt: z.string().min(1),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  failedAt: z.string().optional(),
  rejectedAt: z.string().optional(),
  parentId: z.string().optional(),
  dependsOn: z.array(z.string()).optional(),
  previousPrs: z.string().optional(),
  issueNumber: z.number().int().optional(),
  /**
   * Reconciliation reason — persisted alongside `status` whenever the
   * orchestrator routes a `status-update` AOP record. Surface only;
   * never load-bearing for selectors.
   */
  statusReason: z.string().optional(),
  /** Free-form additional fields kept verbatim across read/write. */
  extra: z.record(z.string(), z.string()).optional(),
});

export type WorkItemVirtualEntry = z.infer<typeof workItemVirtualSchema>;
