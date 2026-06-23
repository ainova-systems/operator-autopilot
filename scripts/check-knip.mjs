#!/usr/bin/env node
/**
 * Knip wrapper — strict dead-code gate across the whole monorepo.
 *
 * Catches what ts-prune misses:
 *   - Unused FILES (not just exports)
 *   - Unused class members / methods
 *   - Unused types / interfaces / enum members
 *   - Unused dependencies in package.json
 *   - Unused devDependencies
 *   - Duplicate exports
 *
 * Covers engine + packages/core + packages/adapters + app uniformly.
 *
 * Justified false-positives go in IGNORE_FILES / IGNORE_SYMBOLS below
 * with a one-line reason. Anything else fails CI.
 *
 * Run: npm run lint:knip
 */

import { execSync } from "node:child_process";

/**
 * File paths the monorepo intentionally keeps even though knip cannot
 * trace consumers. One-line reason per entry.
 */
const IGNORE_FILES = new Set([
  // (none — every UI file under app/src/components has at least one consumer)
]);

/**
 * `file:symbol` pairs intentionally kept exported. Each entry documents why.
 * Path:symbol is normalised to forward-slash before lookup.
 */
const IGNORE_SYMBOLS = new Set([
  // Public agent-output parser surface — consumed via the runtime module
  // object; knip cannot trace string-keyed lookups.
  "engine/agents/output-parser.ts:extractSections",
  "engine/agents/output-parser.ts:extractField",
  // Role output format registry consumed by the reformat path at Step 18.
  "engine/agents/roles.ts:ROLE_OUTPUT_FORMATS",
  // Workspace public helpers — part of the infra/workspace API surface.
  "engine/infra/workspace.ts:workspaceCheckoutBranch",
  "engine/infra/workspace.ts:workspaceReset",
  "engine/infra/workspace.ts:workspaceSetupEnv",
  // PR-state cache reader — App UI server-side via kv.list("pr-states").
  "engine/pipeline/primitives/pr-state-cache.ts:readCachedPRState",
  // Test-only fixture builder; ~40 colocated tests depend on it.
  "engine/work-items/work-items.ts:createWorkItemFile",
  // Public communication adapter surface — external channels plug in here.
  "engine/communication/command-parser.ts:hasCommand",
  "engine/communication/command-parser.ts:extractCommands",
  // Project extension discovery — stable public API hook.
  "engine/config/discovery.ts:discoverProjectExtensions",
  // Public helper for upcoming stage consumers.
  "engine/delivery/vcs-helpers.ts:countActivePRs",
  // Daemon status-line builder — invoked at wrap-up.
  "engine/engine/engine.ts:buildSummary",
  // Feedback collector surface — publicly exported for future channels.
  "engine/feedback/collector.ts:DefaultFeedbackCollector",
  "engine/feedback/collector.ts:GitHubCIFeedbackSource",
  // Verify hooks — future verify-action consumers.
  "engine/verification/pipeline.ts:SequentialVerificationPipeline",
  "engine/verification/pipeline.ts:ScriptVerificationCheck",
  // Telegram channel — alternative notification channel; consumed via
  // dynamic config-driven instantiation.
  "engine/communication/channels/telegram.ts:TelegramChannel",
  // Output formatter — reformat path consumed at Step 18 OpenRouter wiring.
  "engine/agents/output-formatter.ts:formatAgentOutput",
  "engine/agents/output-formatter.ts:callReformatAPI",
  // Heartbeat interval — public config knob even when default suffices.
  "engine/infra/instance-heartbeat.ts:DEFAULT_HEARTBEAT_INTERVAL_MS",
  // Reconciler entry point — invoked from work-items module by name.
  "engine/work-items/work-items.ts:reconcileAndWrite",
  // Generic-stage hook builders — staged for runStage absorption when
  // stage-logic deletion lands.
  "engine/pipeline/generic-stage.ts:buildGenericHooks",
  "engine/pipeline/generic-stage.ts:resolveItemFilePath",
  "engine/pipeline/generic-stage.ts:ItemFrontmatterRef",
  "engine/pipeline/generic-stage.ts:substituteVars",
  // Parser output types kept exported for cross-stage variant consumers.
  "engine/pipeline/primitives/parse-agent-output.ts:FrontmatterDoc",
  "engine/pipeline/primitives/parse-agent-output.ts:OutputParserMode",
  // Agent-output protocol helper consumed inside the applier via re-export.
  "engine/pipeline/primitives/agent-output-protocol.ts:partitionDiagnostics",
  // Agent invocation extras — verdict marker + summary synthesizer kept
  // exported for the Variant B future supervisor flow.
  "engine/pipeline/primitives/agent-invocation.ts:extractVerdictMarker",
  "engine/pipeline/primitives/agent-invocation.ts:extractOrSynthesizeSummary",
  // runStage factory re-exports — convenience for composition-root consumers.
  "engine/pipeline/run-stage.ts:FileWorkspaceScope",
  "engine/pipeline/run-stage.ts:FileOutputAdapter",
  // App UI primitives — used by Next.js page components knip cannot always
  // trace via the App Router file-system convention. shadcn/ui style.
  "app/src/components/shared/form-stack.tsx:FormStack",
  "app/src/components/shared/theme-provider.tsx:useTheme",
  "app/src/components/ui/badge.tsx:badgeVariants",
  "app/src/components/ui/button.tsx:buttonVariants",
  "app/src/components/ui/card.tsx:CardDescription",
  "app/src/components/ui/card.tsx:CardFooter",
  // App audit log schema — consumed at API route boundary.
  "app/src/lib/audit-log.ts:auditLogRowSchema",
  // Zod schemas re-exported through the kvSchemas registry; consumers
  // look them up by category key at runtime, knip cannot trace.
  "packages/core/src/schemas/index.ts:prStateObservationSchema",
  "packages/core/src/schemas/index.ts:checksObservationSchema",
  "packages/core/src/schemas/index.ts:checkRunSchema",
  "packages/core/src/schemas/index.ts:checkAnnotationSchema",
  "packages/core/src/schemas/work-item.schema.ts:prStateObservationSchema",
  "packages/core/src/schemas/work-item.schema.ts:checkAnnotationSchema",
  "packages/core/src/schemas/work-item.schema.ts:checkRunSchema",
  "packages/core/src/schemas/work-item.schema.ts:checksObservationSchema",
  // Workflow-stage component schemas — consumed via Zod inference inside
  // the parent workflowStageSchema; knip flags the individual leaves as
  // unused because the inferred TypeScript types use the parent only.
  "packages/core/src/schemas/workflow-stage.schema.ts:outputParserSchema",
  "packages/core/src/schemas/workflow-stage.schema.ts:commitModeSchema",
  "packages/core/src/schemas/workflow-stage.schema.ts:stageInputSourceSchema",
  "packages/core/src/schemas/workflow-stage.schema.ts:stageOutputSinkSchema",
  // AgentEventSink — interface defined for cross-module typing of the
  // execution-history sink threaded through AgentRuntime.run.
  "engine/agents/runtime.ts:AgentEventSink",
  // AopApplyError — exported for caller-side typed error handling of
  // applier failures.
  "engine/pipeline/primitives/aop-applier.ts:AopApplyError",
  // CachedPrState — exported for downstream UI consumers of pr-states.
  "engine/pipeline/primitives/pr-state-cache.ts:CachedPrState",
  // SingletonScopeKind — exported for selector-config type narrowing in
  // future per-period scope variants.
  "engine/pipeline/primitives/singleton-selector.ts:SingletonScopeKind",
  // ActiveKVResolved — exported for App route handlers that consume the
  // narrowed KV connection record.
  "app/src/lib/require-active-kv.ts:ActiveKVResolved",
]);

function normalize(p) {
  return p.replace(/\\/g, "/").replace(/^\/+/, "");
}

function run() {
  let output = "";
  try {
    output = execSync("npx knip --reporter json", {
      cwd: process.cwd(),
      encoding: "utf-8",
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err) {
    // knip exits non-zero when it finds issues; stdout still carries the report.
    output = err.stdout?.toString() ?? "";
  }

  let report;
  try {
    report = JSON.parse(output);
  } catch (err) {
    console.error("check-knip: failed to parse knip JSON output");
    console.error(err.message);
    console.error("--- raw output (first 2KB) ---");
    console.error(output.slice(0, 2048));
    process.exit(2);
  }

  const violations = [];

  // knip @5+ JSON shape: { issues: { files: [...], exports: { ... } } }
  // Older shapes use a flat object keyed by file. Handle both.
  const issues = Array.isArray(report) ? report : (report.issues ?? report);

  // Files
  const files = Array.isArray(issues)
    ? issues.flatMap((i) => i.files ? [i.files] : []).flat()
    : (issues.files ?? []);
  for (const f of files) {
    const key = normalize(typeof f === "string" ? f : f.name ?? f.path ?? "");
    if (!key) continue;
    if (IGNORE_FILES.has(key)) continue;
    violations.push(`unused file: ${key}`);
  }

  // Symbol-level issues — exports, types, classMembers, enumMembers, etc.
  const symbolCategories = [
    "exports", "types", "classMembers", "enumMembers", "duplicates",
  ];
  if (Array.isArray(issues)) {
    for (const entry of issues) {
      const filePath = normalize(entry.file ?? "");
      for (const cat of symbolCategories) {
        const items = entry[cat] ?? [];
        for (const item of items) {
          const symbol = typeof item === "string" ? item : item.name ?? item.symbol ?? "";
          const key = `${filePath}:${symbol}`;
          if (IGNORE_SYMBOLS.has(key)) continue;
          violations.push(`unused ${cat.replace(/s$/, "")}: ${key}`);
        }
      }
    }
  } else {
    for (const cat of symbolCategories) {
      const bag = issues[cat] ?? {};
      for (const [file, syms] of Object.entries(bag)) {
        for (const symbol of syms) {
          const filePath = normalize(file);
          const symName = typeof symbol === "string" ? symbol : symbol.name ?? symbol.symbol ?? "";
          const key = `${filePath}:${symName}`;
          if (IGNORE_SYMBOLS.has(key)) continue;
          violations.push(`unused ${cat.replace(/s$/, "")}: ${key}`);
        }
      }
    }
  }

  // Unused dependencies + devDependencies — block CI; explicitly listed
  // ignores live in knip.json `ignoreDependencies` (workspace-internal
  // names, dynamic runtime deps).
  const depCategories = ["dependencies", "devDependencies", "optionalPeerDependencies"];
  if (!Array.isArray(issues)) {
    for (const cat of depCategories) {
      const bag = issues[cat] ?? {};
      for (const [pkg, deps] of Object.entries(bag)) {
        for (const dep of deps) {
          const depName = typeof dep === "string" ? dep : dep.name ?? "";
          violations.push(`unused ${cat.replace(/s$/, "")}: ${pkg}/${depName}`);
        }
      }
    }
  }

  if (violations.length === 0) {
    console.log("knip: 0 unexpected dead-code findings.");
    process.exit(0);
  }

  console.error(`knip: ${violations.length} dead-code finding(s):`);
  for (const v of violations) console.error("  " + v);
  console.error("");
  console.error("Each finding is either real dead code (delete the symbol/file)");
  console.error("or a known false positive (add to IGNORE_SYMBOLS / IGNORE_FILES");
  console.error("in scripts/check-knip.mjs with a one-line justification).");
  process.exit(1);
}

run();
