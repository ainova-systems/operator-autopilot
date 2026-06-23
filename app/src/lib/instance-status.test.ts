import { describe, it, expect } from "vitest";
import type { InstanceEntry } from "@operator/core";
import {
  HEARTBEAT_STALE_AFTER_MS,
  classifyInstance,
} from "./instance-status";

function make(partial: Partial<InstanceEntry>): InstanceEntry {
  return {
    id: "i",
    hostname: "h",
    pid: 1,
    version: "v",
    mode: "daemon",
    startedAt: "2026-04-29T08:00:00.000Z",
    lastHeartbeatAt: "2026-04-29T08:00:00.000Z",
    ...partial,
  };
}

describe("classifyInstance", () => {
  const t0 = Date.parse("2026-04-29T08:00:00.000Z");

  it("returns stopped when stoppedAt is set", () => {
    const e = make({ stoppedAt: "2026-04-29T08:01:00.000Z", stopReason: "graceful" });
    expect(classifyInstance(e, t0 + 30_000)).toBe("stopped");
  });

  it("returns running when heartbeat is fresh", () => {
    const e = make({ lastHeartbeatAt: "2026-04-29T08:00:00.000Z" });
    expect(classifyInstance(e, t0 + 5_000)).toBe("running");
    expect(classifyInstance(e, t0 + HEARTBEAT_STALE_AFTER_MS)).toBe("running");
  });

  it("returns offline once heartbeat staleness passes the threshold", () => {
    const e = make({ lastHeartbeatAt: "2026-04-29T08:00:00.000Z" });
    expect(classifyInstance(e, t0 + HEARTBEAT_STALE_AFTER_MS + 1)).toBe("offline");
  });

  it("returns offline when lastHeartbeatAt is unparseable", () => {
    const e = make({ lastHeartbeatAt: "not-a-date" });
    expect(classifyInstance(e, t0)).toBe("offline");
  });
});
