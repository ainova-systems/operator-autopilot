#!/usr/bin/env node
/**
 * ts-prune wrapper that filters known false positives.
 *
 * ts-prune reports an export as unused whenever its only consumer is a test
 * file or a barrel re-export. Our monorepo legitimately has both patterns:
 *   - packages/core/src/index.ts re-exports types consumed across workspaces
 *     which ts-prune cannot trace through @operator/core → engine imports.
 *   - test-helpers/ are only imported from colocated *.test.ts files.
 *   - Zod schemas in packages/core/src/schemas/ are referenced by kvSchemas
 *     registry keys at runtime, which ts-prune does not pick up.
 *
 * This wrapper runs `ts-prune` and treats those known patterns as non-errors.
 * Any orphan outside the ignore list fails CI.
 *
 * Usage: node scripts/check-ts-prune.mjs
 */

import { execSync } from "node:child_process";

// ── Ignore rules — keep tight. Each entry documented with a reason. ──
// File patterns matched against forward-slash-normalised paths.
const IGNORE_FILE_PATTERNS = [
  // Barrel re-exports: ts-prune does not trace consumers across workspaces.
  /^packages\/core\/src\/index\.ts$/,
  /^packages\/core\/src\/interfaces\/index\.ts$/,
  // WorkItemSource interface (Phase 5.0 F2) — types-only contract,
  // implementations land in F9 (VirtualSource) and per-stage migrations.
  /^packages\/core\/src\/interfaces\/work-item-source\.ts$/,
  /^packages\/core\/src\/errors\/index\.ts$/,
  /^packages\/core\/src\/schemas\/index\.ts$/,
  /^packages\/core\/src\/types\/.*\.ts$/,
  /^packages\/core\/src\/status-reconcile\.ts$/,
  /^packages\/adapters\/src\/index\.ts$/,
  /^packages\/adapters\/src\/kvstore-sqlite\/index\.ts$/,
  /^packages\/adapters\/src\/kind-registry\/index\.ts$/,
  // VirtualWorkItemSource (Phase 5.0 F9) — kind-agnostic CRUD for virtual
  // kinds (retrospective-cycle, agent-improvement). Still gated until
  // worker migration adds consumers (S4 retrospective absorbs it).
  // FileBackedWorkItemSource (S1) is consumed by stage-logic/supervisor.ts
  // and was removed from this ignore list.
  /^packages\/adapters\/src\/work-item-source\/index\.ts$/,
  /^packages\/adapters\/src\/work-item-source\/virtual\.ts$/,
  // AgentEventStream barrel — TextBlockEventStream itself is now consumed
  // by entry.ts via supervisor wiring (S1). The barrel index.ts remains
  // gated only because ts-prune cannot trace consumers across workspaces.
  /^packages\/adapters\/src\/agent-event-stream\/index\.ts$/,
  // Test-only helpers: only consumed by colocated test files.
  /^engine\/test-helpers\/.*\.ts$/,
];

// Exact {file:symbol} pairs the monorepo intentionally keeps exported for
// future consumers (UI pages, upcoming stages, adapters). Each entry documented.
// Path:symbol pairs are normalised to forward-slash posix form before lookup.
const IGNORE_EXACT = new Set([
  // `formatAgentOutput` is used by the reviewer output pipeline; consumers
  // land in Step 18 when OpenRouter reformat is re-enabled. Kept reachable.
  "engine/agents/output-formatter.ts:formatAgentOutput",
  // Re-exported public API: extractSections/extractField are part of the
  // agent-output parser surface consumed via the module object in runtime.
  "engine/agents/output-parser.ts:extractSections",
  "engine/agents/output-parser.ts:extractField",
  // Role output format registry — consumed by the runtime formatAgentOutput
  // reformat path at Step 18; kept exported.
  "engine/agents/roles.ts:ROLE_OUTPUT_FORMATS",
  // Public communication adapter surface — external channels plug into these.
  "engine/communication/command-parser.ts:hasCommand",
  "engine/communication/command-parser.ts:extractCommands",
  "engine/communication/channels/telegram.ts:TelegramChannel",
  // Project extension discovery — kept as a stable public API hook.
  "engine/config/discovery.ts:discoverProjectExtensions",
  // Public helper for upcoming stage consumers.
  "engine/delivery/vcs-helpers.ts:countActivePRs",
  // Engine summary is the daemon's status-line builder; consumed at wrap-up.
  "engine/engine/engine.ts:buildSummary",
  // Feedback collector surface — publicly exported for future channels.
  "engine/feedback/collector.ts:DefaultFeedbackCollector",
  "engine/feedback/collector.ts:GitHubCIFeedbackSource",
  // Workspace helpers are part of the infra/workspace public API.
  "engine/infra/workspace.ts:workspaceCheckoutBranch",
  "engine/infra/workspace.ts:workspaceReset",
  "engine/infra/workspace.ts:workspaceSetupEnv",
  // Verification pipeline — hooks into future verify actions. Kept reachable.
  "engine/verification/pipeline.ts:SequentialVerificationPipeline",
  "engine/verification/pipeline.ts:ScriptVerificationCheck",
  // Generic stage runner surface — hook builder + helpers consumed by the
  // generic-stage runner file and by entry.ts when stages switch from
  // hand-written hook closures to config-driven composition.
  "engine/pipeline/generic-stage.ts:buildGenericHooks",
  "engine/pipeline/generic-stage.ts:resolveItemFilePath",
  "engine/pipeline/generic-stage.ts:ItemFrontmatterRef",
  // AOP text-block parser — now consumed by supervisor stage (S1) via
  // TextBlockEventStream wired in entry.ts. `partitionDiagnostics` stays
  // exported for the applier's own use AND the parser's diagnostic split,
  // but ts-prune cannot trace the cross-file use, so kept as exact entry.
  "engine/pipeline/primitives/agent-output-protocol.ts:partitionDiagnostics",
  // PR state cache reader — used by App UI server-side via
  // `kv.list("pr-states")`, which ts-prune cannot trace through workspaces.
  "engine/pipeline/primitives/pr-state-cache.ts:readCachedPRState",
  // Test-only fixture builder: production code now writes work-item files
  // via FileBackedWorkItemSource.create (Phase A S2/S4). Kept exported so
  // tests can scaffold .md files without re-implementing the frontmatter
  // serializer. ~40 colocated test cases depend on it.
  "engine/work-items/work-items.ts:createWorkItemFile",
]);

function normalize(p) {
  // ts-prune emits leading "\" or "/" on the path and uses backslashes on win32.
  return p.replace(/\\/g, "/").replace(/^\/+/, "");
}

function run() {
  let output = "";
  try {
    output = execSync("npx ts-prune --skip \"\\.test\\.ts$\"", {
      cwd: process.cwd(),
      encoding: "utf-8",
    });
  } catch (err) {
    // ts-prune exits non-zero only when --error passed; default mode writes to stdout.
    output = err.stdout?.toString() ?? "";
  }

  const lines = output.split(/\r?\n/).filter((l) => l.trim().length > 0);

  const orphans = [];
  for (const line of lines) {
    // ts-prune marks in-module-only exports with "(used in module)" — those
    // are internal helpers kept exported for test access. Treat as non-orphan.
    if (line.includes("(used in module)")) continue;

    const match = line.match(/^(.+):(\d+) - (.+)$/);
    if (!match) continue;
    const [, rawFilePath, , symbol] = match;
    const filePath = normalize(rawFilePath);

    if (IGNORE_FILE_PATTERNS.some((re) => re.test(filePath))) continue;
    const key = `${filePath}:${symbol.trim()}`;
    if (IGNORE_EXACT.has(key)) continue;

    orphans.push(line);
  }

  if (orphans.length === 0) {
    console.log("ts-prune: 0 unexpected orphans.");
    process.exit(0);
  }

  console.error(`ts-prune: ${orphans.length} unexpected orphan export(s) found:`);
  for (const line of orphans) console.error("  " + line);
  console.error("");
  console.error("If these are intentional public API, add them to IGNORE_EXACT");
  console.error("in scripts/check-ts-prune.mjs with a one-line justification.");
  process.exit(1);
}

run();
