import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import type { OperationContext, KindRegistry, WorkItem, KVStore } from "@operator/core";
import type { Logger } from "../logging/logger.js";
import type { WorkspaceHandle } from "./primitives/workspace-scope.js";
import type { StageDef, StageInput, AgentResult, Verdict } from "./types.js";
import {
  parseAgentOutput,
  type FrontmatterDoc,
  type OutputParserMode,
} from "./primitives/parse-agent-output.js";
import { substituteVars } from "./generic-stage-vars.js";

/**
 * Minimal dependency surface a stage needs when its `inputSource` /
 * `outputSink` drive the runtime instead of hand-written hook closures.
 *
 * All fields the generic hooks reach for directly — reading work-item
 * files, resolving kind directories, writing output documents. The full
 * `runStage` plumbing (`guard`, `workspaceScope`, …) is threaded in by
 * the composition root where {@link runGenericStage} is invoked.
 */
export interface GenericStageContext {
  readonly kindRegistry: KindRegistry;
  readonly workspacePath: string;
  readonly kv?: KVStore;
  readonly log?: Logger;
}

/**
 * Compose the four standard stage hooks from `stageDef.inputSource` and
 * `stageDef.outputSink`. Each returned closure matches the shape
 * `runStage` expects; callers pass the hook bundle straight into its
 * `deps` map alongside `guard`, `workspace`, `persistOutput`, etc.
 *
 * Step 20 scope: covers the `write-item-files` / `code-changes`
 * commit modes needed by finding-plan and task-execute. Paths left for
 * later stages (`iterate`, `preAgentPrimitive`, `structured-report`
 * body writer) throw a clear error at runtime so missing wiring is
 * loud, not silent.
 */
export function buildGenericHooks(
  stageDef: StageDef,
  gctx: GenericStageContext,
): GenericHooks {
  return {
    afterAgent: buildGenericAfterAgent(stageDef, gctx),
  };
}

export interface GenericHooks {
  readonly afterAgent: (
    stageDef: StageDef,
    input: StageInput,
    agentResult: AgentResult,
    workspace: WorkspaceHandle,
    ctx: OperationContext,
  ) => Promise<{ verdictOverride?: Verdict; summaryOverride?: string } | void>;
}

/**
 * After-agent phase: parse the agent stdout per {@link OutputParserMode}
 * and, when the commitMode writes files, materialise each document into
 * the output kind's data directory. For `code-changes` commitMode the
 * runner's persist primitive commits the working-tree diff — this hook
 * only validates the agent returned an expected document count (zero
 * for pure `code-changes`).
 *
 * The hook returns a summary override so the PR body can show
 * "created T-X, T-Y" without the stage owning the output format
 * template itself.
 */
function buildGenericAfterAgent(
  stageDef: StageDef,
  gctx: GenericStageContext,
) {
  const sink = stageDef.outputSink;
  return async (
    _stage: StageDef,
    input: StageInput,
    agentResult: AgentResult,
    _workspace: WorkspaceHandle,
    _ctx: OperationContext,
  ): Promise<{ verdictOverride?: Verdict; summaryOverride?: string } | void> => {
    if (agentResult.verdict !== "approved") return;

    const parsed = parseAgentOutput(
      agentResult.output,
      sink.parser as OutputParserMode,
    );

    if (sink.commitMode === "code-changes") {
      return;
    }

    if (!sink.kind) {
      throw new Error(
        `Stage ${stageDef.name}: outputSink.commitMode=${sink.commitMode} requires outputSink.kind`,
      );
    }
    const dataDir = resolveOutputDataDir(gctx, sink.kind);

    const createdIds: string[] = [];
    for (const doc of parsed.documents) {
      const id = validateAndExtractId(doc, sink.kind);
      const filePath = join(dataDir, `${id}.md`);
      const content = renderDocumentFile(doc);
      await writeFile(filePath, content, "utf-8");
      createdIds.push(id);
      gctx.log?.info(`Stage ${stageDef.name}: wrote ${sink.kind} ${id}`, {
        stage: stageDef.name, kind: sink.kind, itemId: id, scopeKey: input.scopeKey,
      });
    }

    if (createdIds.length === 0 && sink.parser === "single-document") {
      return {
        verdictOverride: "rejected",
        summaryOverride: `Expected exactly 1 ${sink.kind} document, got 0`,
      };
    }

    return {
      summaryOverride: createdIds.length > 0
        ? `Created ${createdIds.length} ${sink.kind}(s): ${createdIds.join(", ")}`
        : `No ${sink.kind} documents emitted`,
    };
  };
}

function resolveOutputDataDir(gctx: GenericStageContext, kind: string): string {
  const dataDir = gctx.kindRegistry.dataDirFor(kind);
  return join(gctx.workspacePath, ".operator", "data", dataDir);
}

function validateAndExtractId(doc: FrontmatterDoc, expectedKind: string): string {
  const id = doc.frontmatter.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`Output document missing frontmatter.id (kind=${expectedKind})`);
  }
  const kind = doc.frontmatter.kind;
  if (kind !== undefined && kind !== expectedKind) {
    throw new Error(
      `Output document kind mismatch: expected '${expectedKind}', got '${kind as string}' (id=${id})`,
    );
  }
  return id;
}

/**
 * Serialise a {@link FrontmatterDoc} to the on-disk `--- yaml --- body`
 * shape. Field order is the insertion order from the agent so prompts
 * can dictate presentation without the runner re-sorting.
 */
function renderDocumentFile(doc: FrontmatterDoc): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(doc.frontmatter)) {
    lines.push(renderFrontmatterLine(key, value));
  }
  return `---\n${lines.join("\n")}\n---\n\n${doc.body}\n`;
}

function renderFrontmatterLine(key: string, value: unknown): string {
  if (value === null || value === undefined) return `${key}:`;
  if (typeof value === "string") return `${key}: ${value}`;
  if (typeof value === "number" || typeof value === "boolean") return `${key}: ${value}`;
  if (Array.isArray(value)) {
    return `${key}:\n${value.map((v) => `  - ${String(v)}`).join("\n")}`;
  }
  // Nested mapping — single-level JSON shorthand; complex cases rare in practice.
  return `${key}: ${JSON.stringify(value)}`;
}

/** Resolve the work-item file on disk for the currently-selected input. */
export function resolveItemFilePath(
  gctx: GenericStageContext,
  inputKind: string,
  itemId: string,
): string {
  const dataDir = gctx.kindRegistry.dataDirFor(inputKind);
  return join(gctx.workspacePath, ".operator", "data", dataDir, `${itemId}.md`);
}

/** Adapter for tests that need to build a {@link WorkItem}-like subset. */
export type ItemFrontmatterRef = Pick<
  WorkItem,
  "id" | "kind" | "title" | "body" | "status" | "priority"
>;

export { substituteVars };
