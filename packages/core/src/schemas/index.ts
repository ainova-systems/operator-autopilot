/**
 * KV schema registry.
 *
 * Single source of truth for every KV category the engine reads and the
 * app writes. Both seed validation (Step 5 `seed.ts`) and UI write
 * validation (Step 16 `/api/kv/*` routes) consume these schemas.
 *
 * Adding a new category = add a new `*.schema.ts` file and one entry in
 * `kvSchemas` below. Runtime code reaches into `kvSchemas[category]`
 * rather than hardcoding any validation logic.
 */

import type { ZodTypeAny } from "zod";

export { metadataSchema, type KVMetadata } from "./_metadata.schema.js";
export { promptSchema, type PromptEntry } from "./prompt.schema.js";
export { templateSchema, type TemplateEntry } from "./template.schema.js";
export { agentRoleSchema, type AgentRoleEntry } from "./agent-role.schema.js";
export {
  workflowStageSchema,
  mergeShorthandSchema,
  mergeConditionsSchema,
  type WorkflowStageEntry,
} from "./workflow-stage.schema.js";
export {
  workItemKindSchema,
  type WorkItemKindEntry,
  type KindDefinition,
} from "./work-item-kind.schema.js";
export { analyzerSchema, type AnalyzerEntry } from "./analyzer.schema.js";
export { verifierCriteriaSchema, type VerifierCriteriaEntry } from "./verifier-criteria.schema.js";
export {
  engineDefaultsSchema,
  agentProviderSchema,
  lifecycleConfigSchema,
  type EngineDefaultsEntry,
  type AgentProviderEntry,
  type LifecycleConfigEntry,
} from "./engine-defaults.schema.js";
export {
  repoSchema,
  repoFeaturesSchema,
  repoLimitsSchema,
  repoVcsSchema,
  type RepoEntry,
} from "./repo.schema.js";
export {
  workItemEntrySchema,
  statusSourcesSchema,
  developFileObservationSchema,
  featureBranchFileObservationSchema,
  prLabelObservationSchema,
  executionVerdictObservationSchema,
  prStateObservationSchema,
  checksObservationSchema,
  checkRunSchema,
  checkAnnotationSchema,
  type WorkItemEntry,
  type StatusSources,
  type DevelopFileObservation,
  type FeatureBranchFileObservation,
  type PrLabelObservation,
  type ExecutionVerdictObservation,
  type PrStateObservation,
  type ChecksObservation,
} from "./work-item.schema.js";
export {
  executionEntrySchema,
  executionEventSchema,
  executionLogSchema,
  type ExecutionEntry,
  type ExecutionEventEntry,
  type ExecutionLogEntry,
} from "./execution.schema.js";
export {
  instanceEntrySchema,
  instanceModeSchema,
  instanceStopReasonSchema,
  type InstanceEntry,
  type InstanceMode,
  type InstanceStopReason,
} from "./instance.schema.js";
export {
  prStateCacheSchema,
  type PrStateCacheEntry,
} from "./pr-state-cache.schema.js";
export {
  workspaceInitSchema,
  type WorkspaceInitEntry,
} from "./workspace-init.schema.js";
export {
  workItemVirtualSchema,
  type WorkItemVirtualEntry,
} from "./work-item-virtual.schema.js";
export {
  agentEventSchema,
  emitChildItemSchema,
  emitStatusUpdateSchema,
  emitBodyUpdateSchema,
  emitNoteSchema,
  emitCommentReplySchema,
  emitErrorSchema,
  emitRecoverySchema,
  emitVerdictSchema,
  AGENT_EVENT_TYPES,
  type AgentEvent,
  type AgentEventType,
  type EmitChildItem,
  type EmitStatusUpdate,
  type EmitBodyUpdate,
  type EmitNote,
  type EmitCommentReply,
  type EmitError,
  type EmitRecovery,
  type EmitVerdict,
} from "./agent-event.schema.js";

import { promptSchema } from "./prompt.schema.js";
import { templateSchema } from "./template.schema.js";
import { agentRoleSchema } from "./agent-role.schema.js";
import { workflowStageSchema } from "./workflow-stage.schema.js";
import { workItemKindSchema } from "./work-item-kind.schema.js";
import { analyzerSchema } from "./analyzer.schema.js";
import { verifierCriteriaSchema } from "./verifier-criteria.schema.js";
import { engineDefaultsSchema, agentProviderSchema } from "./engine-defaults.schema.js";
import { repoSchema } from "./repo.schema.js";
import { workItemEntrySchema } from "./work-item.schema.js";
import {
  executionEntrySchema,
  executionEventSchema,
  executionLogSchema,
} from "./execution.schema.js";
import { instanceEntrySchema } from "./instance.schema.js";
import { prStateCacheSchema } from "./pr-state-cache.schema.js";
import { workspaceInitSchema } from "./workspace-init.schema.js";
import { workItemVirtualSchema } from "./work-item-virtual.schema.js";

/**
 * KV category name → Zod schema. Used by seed.ts and UI write validation.
 * Add new categories here when extending the engine.
 */
export const kvSchemas = {
  prompts: promptSchema,
  templates: templateSchema,
  "agent-roles": agentRoleSchema,
  "workflow-stages": workflowStageSchema,
  "work-item-kinds": workItemKindSchema,
  analyzers: analyzerSchema,
  "verifier-criteria": verifierCriteriaSchema,
  "engine-defaults": engineDefaultsSchema,
  "agent-providers": agentProviderSchema,
  repos: repoSchema,
  "work-items": workItemEntrySchema,
  executions: executionEntrySchema,
  "execution-events": executionEventSchema,
  "execution-logs": executionLogSchema,
  instances: instanceEntrySchema,
  "pr-states": prStateCacheSchema,
  "workspace-init": workspaceInitSchema,
  "work-items-virtual": workItemVirtualSchema,
} as const satisfies Record<string, ZodTypeAny>;

export type KVCategory = keyof typeof kvSchemas;
