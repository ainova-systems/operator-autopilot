import { describe, it, expect, vi } from "vitest";
import type { EventBus } from "@operator/core";
import type { NotificationChannel, NotificationMessage } from "@operator/core";
import { NotificationRouter } from "./router.js";

type EventHandlerFn = (payload: unknown) => void | Promise<void>;

function makeBus(): EventBus & { handlers: Map<string, EventHandlerFn[]> } {
  const handlers = new Map<string, EventHandlerFn[]>();
  return {
    handlers,
    emit: vi.fn().mockResolvedValue(undefined),
    on: vi.fn().mockImplementation((event: string, handler: EventHandlerFn) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
  };
}

function makeChannel(id: string): NotificationChannel {
  return {
    id,
    send: vi.fn().mockResolvedValue(undefined),
    receive: vi.fn().mockResolvedValue([]),
  };
}

describe("NotificationRouter", () => {
  it("dispatches to registered channel", async () => {
    const bus = makeBus();
    const channel = makeChannel("test");
    const router = new NotificationRouter(bus);

    router.register(channel);
    const sent = await router.dispatch("pipeline.completed", {
      traceId: "t1", projectId: "p1", data: { pipeline: "research" },
    });

    expect(sent).toBe(1);
    expect(channel.send).toHaveBeenCalledWith(
      expect.objectContaining({ event: "pipeline.completed", projectId: "p1" }),
      undefined,
    );
  });

  it("filters by event type when specified", async () => {
    const bus = makeBus();
    const channel = makeChannel("filtered");
    const router = new NotificationRouter(bus);

    router.register(channel, ["pipeline.failed"]);

    // Should not dispatch — event doesn't match filter
    const sent1 = await router.dispatch("pipeline.completed", { traceId: "t", projectId: "p" });
    expect(sent1).toBe(0);

    // Should dispatch — event matches
    const sent2 = await router.dispatch("pipeline.failed", { traceId: "t", projectId: "p" });
    expect(sent2).toBe(1);
  });

  it("dispatches to all matching channels", async () => {
    const bus = makeBus();
    const ch1 = makeChannel("ch1");
    const ch2 = makeChannel("ch2");
    const ch3 = makeChannel("ch3");
    const router = new NotificationRouter(bus);

    router.register(ch1); // all events
    router.register(ch2, ["pipeline.completed"]);
    router.register(ch3, ["pipeline.failed"]);

    const sent = await router.dispatch("pipeline.completed", { traceId: "t", projectId: "p" });

    expect(sent).toBe(2); // ch1 (all) + ch2 (matched)
    expect(ch1.send).toHaveBeenCalled();
    expect(ch2.send).toHaveBeenCalled();
    expect(ch3.send).not.toHaveBeenCalled();
  });

  it("handles channel failure gracefully", async () => {
    const bus = makeBus();
    const failing = makeChannel("fail");
    vi.mocked(failing.send).mockRejectedValue(new Error("network"));
    const working = makeChannel("ok");
    const router = new NotificationRouter(bus);

    router.register(failing);
    router.register(working);

    const sent = await router.dispatch("test.event", { traceId: "t", projectId: "p" });

    expect(sent).toBe(1); // only working channel counted
    expect(working.send).toHaveBeenCalled();
  });

  it("subscribes to event bus", () => {
    const bus = makeBus();
    const router = new NotificationRouter(bus);
    router.register(makeChannel("ch"));

    router.subscribe(["pipeline.completed", "pipeline.failed"]);

    expect(bus.on).toHaveBeenCalledWith("pipeline.completed", expect.any(Function));
    expect(bus.on).toHaveBeenCalledWith("pipeline.failed", expect.any(Function));
  });

  it("formats notification message from payload", async () => {
    const bus = makeBus();
    const channel = makeChannel("test");
    const router = new NotificationRouter(bus);
    router.register(channel);

    await router.dispatch("pipeline.failed", {
      traceId: "t", projectId: "proj-1",
      data: { stage: "research", reason: "timeout" },
    });

    const msg = vi.mocked(channel.send).mock.calls[0][0] as NotificationMessage;
    expect(msg.title).toContain("Pipeline failed");
    expect(msg.body).toContain("proj-1");
    expect(msg.severity).toBe("error");
  });

  it("infers severity from event name", async () => {
    const bus = makeBus();
    const channel = makeChannel("test");
    const router = new NotificationRouter(bus);
    router.register(channel);

    await router.dispatch("task.completed", { traceId: "t", projectId: "p" });
    expect((vi.mocked(channel.send).mock.calls[0][0] as NotificationMessage).severity).toBe("info");

    vi.mocked(channel.send).mockClear();
    await router.dispatch("observation.degraded", { traceId: "t", projectId: "p" });
    expect((vi.mocked(channel.send).mock.calls[0][0] as NotificationMessage).severity).toBe("warning");
  });
});
