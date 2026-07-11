import { describe, it, expect } from "vitest";
import { buildSupervisorTask } from "./supervisor-task.js";

describe("buildSupervisorTask", () => {
  it("includes PR coordinates and feedback", () => {
    const task = buildSupervisorTask("task", "ai/tasks/T-0001", "user comment here", "");
    expect(task).toContain("ai/tasks/T-0001");
    expect(task).toContain("user comment here");
    expect(task).toContain("fix-in-place");
    expect(task).toContain("cancel");
    expect(task).toContain("retry-as-new");
  });

  it("includes CI context file path when supplied", () => {
    const task = buildSupervisorTask("task", "ai/tasks/T-0001", "fb", "", "/tmp/ci.md");
    expect(task).toContain("/tmp/ci.md");
    expect(task).toContain("CI Pipeline Context");
  });

  it("includes thread file path when supplied", () => {
    const task = buildSupervisorTask("task", "ai/tasks/T-0001", "fb", "/tmp/thread.md");
    expect(task).toContain("/tmp/thread.md");
    expect(task).toContain("Discussion History");
  });
});
