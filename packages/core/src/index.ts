/**
 * @operator/core — shared contracts for the Operator engine.
 *
 * Zero runtime code except:
 *   - error class constructors (packages/core/src/errors)
 *   - Zod schemas (packages/core/src/schemas) — pure data validation
 *
 * No imports from @operator/adapters, @operator/engine, or @operator/app.
 * Consumers: @operator/engine, @operator/adapters, @operator/app.
 */

// ── Types ────────────────────────────────────────────────────────────
export type * from "./types/agent.js";
export type * from "./types/communication.js";
export type * from "./types/config.js";
export type * from "./types/context.js";
export type * from "./types/domain.js";
export type * from "./types/event.js";
export type * from "./types/feedback.js";
export type * from "./types/infra.js";
export type * from "./types/pipeline.js";
export type * from "./types/platform.js";
export type * from "./types/prompt-source.js";
export type * from "./types/state.js";
export type * from "./types/store.js";
export type * from "./types/verification.js";
export type * from "./types/agent-event-stream.js";

// ── Runtime interfaces ───────────────────────────────────────────────
export type * from "./interfaces/index.js";

// ── Errors ───────────────────────────────────────────────────────────
export {
  OperatorError,
  AgentError,
  ConfigError,
  PlatformError,
  WorkspaceError,
  WorkItemSourceError,
  errorMessage,
} from "./errors/index.js";
export type { AgentFailurePhase } from "./errors/index.js";

// ── KV schemas ───────────────────────────────────────────────────────
export {
  kvSchemas,
  metadataSchema,
  promptSchema,
  templateSchema,
  agentRoleSchema,
  workflowStageSchema,
  mergeShorthandSchema,
  mergeConditionsSchema,
  workItemKindSchema,
  analyzerSchema,
  verifierCriteriaSchema,
  engineDefaultsSchema,
  agentProviderSchema,
  lifecycleConfigSchema,
  repoSchema,
  repoFeaturesSchema,
  repoLimitsSchema,
  repoVcsSchema,
  workItemEntrySchema,
  statusSourcesSchema,
  developFileObservationSchema,
  featureBranchFileObservationSchema,
  prLabelObservationSchema,
  executionVerdictObservationSchema,
  executionEntrySchema,
  executionEventSchema,
  executionLogSchema,
  instanceEntrySchema,
  instanceModeSchema,
  instanceStopReasonSchema,
  prStateCacheSchema,
  workspaceInitSchema,
  workItemVirtualSchema,
  agentEventSchema,
  emitChildItemSchema,
  emitStatusUpdateSchema,
  emitBodyUpdateSchema,
  emitNoteSchema,
  emitErrorSchema,
  emitRecoverySchema,
  emitVerdictSchema,
  AGENT_EVENT_TYPES,
} from "./schemas/index.js";
export type {
  KVCategory,
  KVMetadata,
  PromptEntry,
  TemplateEntry,
  AgentRoleEntry,
  WorkflowStageEntry,
  WorkItemKindEntry,
  KindDefinition,
  AnalyzerEntry,
  VerifierCriteriaEntry,
  EngineDefaultsEntry,
  AgentProviderEntry,
  LifecycleConfigEntry,
  RepoEntry,
  WorkItemEntry,
  StatusSources,
  DevelopFileObservation,
  FeatureBranchFileObservation,
  PrLabelObservation,
  ExecutionVerdictObservation,
  PrStateObservation,
  ChecksObservation,
  ExecutionEntry,
  ExecutionEventEntry,
  ExecutionLogEntry,
  InstanceEntry,
  InstanceMode,
  InstanceStopReason,
  PrStateCacheEntry,
  WorkspaceInitEntry,
  WorkItemVirtualEntry,
  AgentEvent,
  AgentEventType,
  EmitChildItem,
  EmitStatusUpdate,
  EmitBodyUpdate,
  EmitNote,
  EmitError,
  EmitRecovery,
  EmitVerdict,
} from "./schemas/index.js";

// ── Status reconciliation (Step 14) ──────────────────────────────────
export {
  reconcileEffectiveStatus,
  computeDrift,
  type ReconcileInput,
  type ReconcileResult,
  type DriftResult,
} from "./status-reconcile.js";
