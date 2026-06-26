import { describe, it, expect } from "vitest";
import type { Comment } from "@operator/core";
import {
  formatFooter,
  parseFooter,
  parseLatestBotFooter,
  emptyAttribution,
  type BotAttribution,
} from "./bot-footer.js";

const MARKER = "<!-- bot:operator -->";

function comment(id: string, body: string, createdAt = "2026-05-02T10:00:00Z"): Comment {
  return {
    id,
    author: "operator-bot",
    authorType: "Bot",
    body,
    createdAt,
  };
}

describe("formatFooter", () => {
  it("emits empty string when attribution carries nothing", () => {
    expect(formatFooter(emptyAttribution())).toBe("");
  });

  it("includes only the fields that are populated", () => {
    const a: BotAttribution = {
      responded: new Set(["c1", "c2"]),
      ciHead: "abc12345",
      ciAttempt: { current: 2, max: 3 },
    };
    const out = formatFooter(a);
    expect(out).toContain("responded: c1,c2");
    expect(out).toContain("ci-head: abc12345");
    expect(out).toContain("ci-attempt: 2/3");
  });

  it("sorts responded ids deterministically", () => {
    const a: BotAttribution = { responded: new Set(["c2", "c1"]) };
    expect(formatFooter(a)).toContain("responded: c1,c2");
  });

  it("omits ci-head and ci-attempt when undefined", () => {
    const a: BotAttribution = { responded: new Set(["c1"]) };
    const out = formatFooter(a);
    expect(out).toContain("responded: c1");
    expect(out).not.toContain("ci-head");
    expect(out).not.toContain("ci-attempt");
    expect(out).not.toContain("ci-rerun");
  });

  it("includes ci-rerun when populated", () => {
    const a: BotAttribution = { responded: new Set(), ciRerun: { current: 1, max: 2 } };
    expect(formatFooter(a)).toContain("ci-rerun: 1/2");
  });
});

describe("parseFooter", () => {
  it("returns empty attribution when no fenced block is present", () => {
    expect(parseFooter("just a plain comment")).toEqual(emptyAttribution());
  });

  it("round-trips with formatFooter", () => {
    const original: BotAttribution = {
      responded: new Set(["c1", "c2", "c3"]),
      ciHead: "deadbeef",
      ciAttempt: { current: 1, max: 5 },
      ciRerun: { current: 2, max: 2 },
    };
    const formatted = formatFooter(original);
    const parsed = parseFooter(formatted);
    expect([...parsed.responded].sort()).toEqual(["c1", "c2", "c3"]);
    expect(parsed.ciHead).toBe("deadbeef");
    expect(parsed.ciAttempt).toEqual({ current: 1, max: 5 });
    expect(parsed.ciRerun).toEqual({ current: 2, max: 2 });
  });

  it("parses ci-rerun and ignores malformed counters", () => {
    expect(parseFooter("<!-- bot:operator/attribution\nci-rerun: 1/2\n-->").ciRerun)
      .toEqual({ current: 1, max: 2 });
    expect(parseFooter("<!-- bot:operator/attribution\nci-rerun: nope\n-->").ciRerun)
      .toBeUndefined();
  });

  it("recovers attribution embedded inside a real comment body", () => {
    const body = "Reviewed feedback.\n\n<!-- bot:operator/attribution\n" +
      "responded: 100,200\nci-head: face1234\nci-attempt: 3/3\n-->";
    const parsed = parseFooter(body);
    expect(parsed.responded.has("100")).toBe(true);
    expect(parsed.responded.has("200")).toBe(true);
    expect(parsed.ciHead).toBe("face1234");
    expect(parsed.ciAttempt).toEqual({ current: 3, max: 3 });
  });

  it("ignores malformed ci-attempt lines", () => {
    const body = "<!-- bot:operator/attribution\nci-attempt: garbage\n-->";
    expect(parseFooter(body).ciAttempt).toBeUndefined();
  });

  it("survives extra whitespace and blank lines", () => {
    const body = "<!-- bot:operator/attribution\n  responded: a\n\n  ci-head:  xyz  \n-->";
    const parsed = parseFooter(body);
    expect(parsed.responded.has("a")).toBe(true);
    expect(parsed.ciHead).toBe("xyz");
  });
});

describe("parseLatestBotFooter", () => {
  it("returns empty when no bot comments exist", () => {
    const comments: Comment[] = [comment("u1", "user note")];
    expect(parseLatestBotFooter(comments, MARKER)).toEqual(emptyAttribution());
  });

  it("returns empty when bot comments lack a footer (legacy comments)", () => {
    const comments: Comment[] = [
      comment("b1", `${MARKER}\n\nApplied review feedback.`),
    ];
    expect(parseLatestBotFooter(comments, MARKER)).toEqual(emptyAttribution());
  });

  it("picks the latest bot comment by createdAt", () => {
    const comments: Comment[] = [
      comment("b1", `${MARKER}\n\nold\n\n<!-- bot:operator/attribution\nci-attempt: 1/3\n-->`,
        "2026-05-01T10:00:00Z"),
      comment("b2", `${MARKER}\n\nnewer\n\n<!-- bot:operator/attribution\nci-attempt: 2/3\n-->`,
        "2026-05-02T10:00:00Z"),
      comment("u1", "user reply", "2026-05-03T10:00:00Z"),
    ];
    const parsed = parseLatestBotFooter(comments, MARKER);
    expect(parsed.ciAttempt).toEqual({ current: 2, max: 3 });
  });

  it("ignores user comments that happen to embed the marker text", () => {
    const comments: Comment[] = [
      // User quoting the marker — not a bot reply (no marker in their actual body).
      comment("u1", "quote: <!-- bot:operator -->", "2026-05-02T10:00:00Z"),
    ];
    // No bot replies → empty.
    const parsed = parseLatestBotFooter(comments, "OPERATOR-XYZ-MARKER");
    expect(parsed).toEqual(emptyAttribution());
  });
});
