import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EventPayload } from "@operator/core";
import { InMemoryEventBus } from "./bus.js";

function makePayload(overrides?: Partial<EventPayload>): EventPayload {
  return {
    traceId: "trace-1",
    projectId: "proj-1",
    ...overrides,
  };
}

describe("InMemoryEventBus", () => {
  let bus: InMemoryEventBus;

  beforeEach(() => {
    bus = new InMemoryEventBus();
  });

  it("emit with no handlers does not throw", async () => {
    await expect(bus.emit("test.event", makePayload())).resolves.toBeUndefined();
  });

  it("calls registered handler on emit", async () => {
    const handler = vi.fn().mockReturnValue({ action: "continue" });
    bus.on("task.started", handler);
    const payload = makePayload({ data: { taskId: "T001" } });
    await bus.emit("task.started", payload);
    expect(handler).toHaveBeenCalledWith(payload);
  });

  it("does not call handler for different event", async () => {
    const handler = vi.fn().mockReturnValue({ action: "continue" });
    bus.on("task.started", handler);
    await bus.emit("task.completed", makePayload());
    expect(handler).not.toHaveBeenCalled();
  });

  it("calls multiple handlers in registration order", async () => {
    const order: number[] = [];
    bus.on("pipeline.started", async () => {
      order.push(1);
      return { action: "continue" };
    });
    bus.on("pipeline.started", async () => {
      order.push(2);
      return { action: "continue" };
    });
    bus.on("pipeline.started", async () => {
      order.push(3);
      return { action: "continue" };
    });
    await bus.emit("pipeline.started", makePayload());
    expect(order).toEqual([1, 2, 3]);
  });

  describe("handler results", () => {
    it("continue allows next handler to run", async () => {
      const second = vi.fn().mockReturnValue({ action: "continue" });
      bus.on("test", () => ({ action: "continue" }));
      bus.on("test", second);
      await bus.emit("test", makePayload());
      expect(second).toHaveBeenCalled();
    });

    it("skip stops remaining handlers", async () => {
      const skipped = vi.fn().mockReturnValue({ action: "continue" });
      bus.on("test", () => ({ action: "skip", reason: "not relevant" }));
      bus.on("test", skipped);
      await bus.emit("test", makePayload());
      expect(skipped).not.toHaveBeenCalled();
    });

    it("abort throws error with event name and reason", async () => {
      bus.on("test", () => ({ action: "abort", reason: "budget exceeded" }));
      await expect(bus.emit("test", makePayload())).rejects.toThrow(
        'Event "test" aborted: budget exceeded',
      );
    });

    it("abort stops remaining handlers", async () => {
      const afterAbort = vi.fn().mockReturnValue({ action: "continue" });
      bus.on("test", () => ({ action: "abort", reason: "stop" }));
      bus.on("test", afterAbort);
      await expect(bus.emit("test", makePayload())).rejects.toThrow();
      expect(afterAbort).not.toHaveBeenCalled();
    });

    it("transform replaces payload for subsequent handlers", async () => {
      const transformed = makePayload({ data: { modified: true } });
      const second = vi.fn().mockReturnValue({ action: "continue" });
      bus.on("test", () => ({ action: "transform", payload: transformed }));
      bus.on("test", second);
      await bus.emit("test", makePayload());
      expect(second).toHaveBeenCalledWith(transformed);
    });

    it("transform does not affect original payload", async () => {
      const original = makePayload({ data: { value: "original" } });
      bus.on("test", () => ({
        action: "transform",
        payload: makePayload({ data: { value: "modified" } }),
      }));
      bus.on("test", () => ({ action: "continue" }));
      await bus.emit("test", original);
      expect(original.data).toEqual({ value: "original" });
    });
  });

  it("supports async handlers", async () => {
    const order: string[] = [];
    bus.on("test", async () => {
      await new Promise((r) => setTimeout(r, 1));
      order.push("async");
      return { action: "continue" };
    });
    bus.on("test", () => {
      order.push("sync");
      return { action: "continue" };
    });
    await bus.emit("test", makePayload());
    expect(order).toEqual(["async", "sync"]);
  });

  it("supports multiple independent events", async () => {
    const aHandler = vi.fn().mockReturnValue({ action: "continue" });
    const bHandler = vi.fn().mockReturnValue({ action: "continue" });
    bus.on("event.a", aHandler);
    bus.on("event.b", bHandler);
    await bus.emit("event.a", makePayload());
    expect(aHandler).toHaveBeenCalled();
    expect(bHandler).not.toHaveBeenCalled();
  });
});
