import { describe, it, expect, vi } from "vitest";
import type { AgentEventParseResult } from "@operator/core";
import { TextBlockEventStream } from "./text-block.js";

describe("TextBlockEventStream", () => {
  it("delegates parse() to the injected parser function", () => {
    const expected: AgentEventParseResult = {
      events: [{ type: "verdict", value: "approved", summary: "ok" }],
      diagnostics: [],
    };
    const parser = vi.fn().mockReturnValue(expected);
    const stream = new TextBlockEventStream(parser);
    const result = stream.parse("=== EMIT verdict ===\nvalue: approved\nsummary: ok\n=== END EMIT ===");
    expect(result).toBe(expected);
    expect(parser).toHaveBeenCalledOnce();
    expect(parser).toHaveBeenCalledWith("=== EMIT verdict ===\nvalue: approved\nsummary: ok\n=== END EMIT ===");
  });

  it("forwards diagnostics from the parser unchanged", () => {
    const result: AgentEventParseResult = {
      events: [],
      diagnostics: [
        { severity: "error", code: "raw-frontmatter-leak", line: 3, message: "leak" },
      ],
    };
    const stream = new TextBlockEventStream(() => result);
    expect(stream.parse("anything").diagnostics).toEqual(result.diagnostics);
  });

  it("is stateless across calls — same input twice produces equal results", () => {
    const stream = new TextBlockEventStream((text) => ({
      events: text === "ping" ? [{ type: "note", message: "pong" }] : [],
      diagnostics: [],
    }));
    const a = stream.parse("ping");
    const b = stream.parse("ping");
    expect(a.events).toEqual(b.events);
  });
});
