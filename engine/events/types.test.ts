import { describe, it, expect } from "vitest";
import * as types from "./types.js";

describe("Event types", () => {
  it("exports lifecycle events", () => {
    expect(types.ENGINE_STARTED).toBe("engine.started");
    expect(types.ENGINE_STOPPED).toBe("engine.stopped");
    expect(types.PROJECT_STARTED).toBe("project.started");
    expect(types.PROJECT_COMPLETED).toBe("project.completed");
  });

  it("exports pipeline events", () => {
    expect(types.PIPELINE_STARTED).toBe("pipeline.started");
    expect(types.PIPELINE_COMPLETED).toBe("pipeline.completed");
    expect(types.PIPELINE_FAILED).toBe("pipeline.failed");
    expect(types.STAGE_STARTED).toBe("stage.started");
    expect(types.STAGE_COMPLETED).toBe("stage.completed");
    expect(types.STAGE_SKIPPED).toBe("stage.skipped");
  });

  it("exports SDLC stage events", () => {
    expect(types.RESEARCH_STARTED).toBe("research.started");
    expect(types.FINDING_CREATED).toBe("finding.created");
    expect(types.TASK_COMPLETED).toBe("task.completed");
    expect(types.DELIVERY_MERGED).toBe("delivery.merged");
    expect(types.FEEDBACK_RECEIVED).toBe("feedback.received");
    expect(types.OBSERVATION_COMPLETED).toBe("observation.completed");
    expect(types.ASSESSMENT_COMPLETED).toBe("assessment.completed");
    expect(types.IMPROVER_COMPLETED).toBe("improver.completed");
  });

  it("exports notification events", () => {
    expect(types.NOTIFICATION_SENT).toBe("notification.sent");
    expect(types.NOTIFICATION_FAILED).toBe("notification.failed");
  });

  it("all event types follow dot notation pattern", () => {
    const values = Object.values(types);
    for (const v of values) {
      expect(v).toMatch(/^[a-z]+\.[a-z]+$/);
    }
  });
});
