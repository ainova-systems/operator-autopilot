import { describe, it, expect } from "vitest";
import { buildStageHandler, type StageHandlerSharedDeps } from "./stage-handlers.js";
import type { WorkflowStageEntry } from "@operator/core";

function silentLogger() {
  const messages: { level: string; msg: string }[] = [];
  const self = {
    messages,
    debug(msg: string) { messages.push({ level: "debug", msg }); },
    info(msg: string) { messages.push({ level: "info", msg }); },
    warn(msg: string) { messages.push({ level: "warn", msg }); },
    error(msg: string) { messages.push({ level: "error", msg }); },
    child() { return self; },
  };
  return self;
}

function makeStage(composer?: WorkflowStageEntry["composer"]): WorkflowStageEntry {
  return {
    name: "sample-stage",
    agent: "creator",
    selector: "per-item",
    merge: "gated",
    branchScope: "per-item",
    schedule: "",
    enabled: true,
    outputSink: { parser: "single-document", commitMode: "work-item-files" },
    reviewEnabled: false,
    composer,
  };
}

// The dispatch only reads `composer` from the row and `log` for the
// unknown-composer warn path; the per-composer runStage assembly lives
// inside the returned closure (exercised end-to-end by the runStage and
// composer tests), so a minimal deps bundle is enough to pin the routing
// contract here.
function makeShared(log: ReturnType<typeof silentLogger>): StageHandlerSharedDeps {
  return { log } as unknown as StageHandlerSharedDeps;
}

const REGISTERED_COMPOSERS = [
  "aop-planner",
  "verifier-driven-creator",
  "pr-feedback-supervisor",
  "discovery-iteration",
  "weekly-metrics",
  "bootstrap-init",
] as const;

describe("buildStageHandler", () => {
  it("returns undefined for a stage row with no composer", () => {
    const log = silentLogger();
    const handler = buildStageHandler(makeStage(undefined), makeShared(log));
    expect(handler).toBeUndefined();
    expect(log.messages).toHaveLength(0);
  });

  it.each(REGISTERED_COMPOSERS)(
    "returns a runnable handler for the %s composer",
    (composer) => {
      const log = silentLogger();
      const handler = buildStageHandler(makeStage(composer), makeShared(log));
      expect(typeof handler).toBe("function");
      expect(log.messages).toHaveLength(0);
    },
  );

  it("warns and returns undefined for a known-but-unregistered composer", () => {
    const log = silentLogger();
    // `closed-pr-recovery` is a valid schema enum value with no factory in
    // the dispatch map — the row must skip with a warning, not throw, so a
    // future enum addition that forgets its factory is caught here.
    const handler = buildStageHandler(makeStage("closed-pr-recovery"), makeShared(log));
    expect(handler).toBeUndefined();
    const warning = log.messages.find((m) => m.level === "warn");
    expect(warning?.msg).toContain("closed-pr-recovery");
    expect(warning?.msg).toContain("sample-stage");
  });
});
