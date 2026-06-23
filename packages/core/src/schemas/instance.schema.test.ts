import { describe, it, expect } from "vitest";
import { instanceEntrySchema } from "./instance.schema.js";

describe("instanceEntrySchema", () => {
  const minimal = {
    id: "i-7c3f",
    hostname: "build-01",
    pid: 4242,
    version: "5.0.0",
    mode: "daemon" as const,
    startedAt: "2026-04-29T08:30:00.000Z",
    lastHeartbeatAt: "2026-04-29T08:30:05.000Z",
  };

  it("accepts a minimal running daemon row", () => {
    const parsed = instanceEntrySchema.parse(minimal);
    expect(parsed.id).toBe("i-7c3f");
    expect(parsed.mode).toBe("daemon");
    expect(parsed.stoppedAt).toBeUndefined();
  });

  it("accepts a finalized row with stoppedAt + stopReason", () => {
    const parsed = instanceEntrySchema.parse({
      ...minimal,
      stoppedAt: "2026-04-29T09:00:00.000Z",
      stopReason: "graceful",
      cycleCount: 12,
      lastCycleAt: "2026-04-29T08:59:30.000Z",
    });
    expect(parsed.stopReason).toBe("graceful");
    expect(parsed.cycleCount).toBe(12);
  });

  it("rejects unknown mode values", () => {
    expect(() =>
      instanceEntrySchema.parse({ ...minimal, mode: "loop" }),
    ).toThrow();
  });

  it("rejects unknown stopReason values", () => {
    expect(() =>
      instanceEntrySchema.parse({ ...minimal, stopReason: "killed-by-cat" }),
    ).toThrow();
  });

  it("rejects empty id / hostname", () => {
    expect(() =>
      instanceEntrySchema.parse({ ...minimal, id: "" }),
    ).toThrow();
    expect(() =>
      instanceEntrySchema.parse({ ...minimal, hostname: "" }),
    ).toThrow();
  });

  it("requires non-negative pid", () => {
    expect(() =>
      instanceEntrySchema.parse({ ...minimal, pid: -1 }),
    ).toThrow();
  });
});
