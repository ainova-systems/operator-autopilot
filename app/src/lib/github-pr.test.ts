import { describe, it, expect } from "vitest";
import {
  buildPrUrl,
  buildRepoSlugMap,
  deriveScore,
  workItemPrState,
  workItemStatus,
} from "./github-pr";

describe("buildPrUrl", () => {
  it("composes a github.com PR URL when both inputs are present", () => {
    expect(buildPrUrl("owner/sample", 42)).toBe("https://github.com/owner/sample/pull/42");
  });

  it("returns null when slug is missing", () => {
    expect(buildPrUrl(undefined, 42)).toBeNull();
  });

  it("returns null when prNumber is missing", () => {
    expect(buildPrUrl("owner/sample", undefined)).toBeNull();
  });
});

describe("buildRepoSlugMap", () => {
  it("indexes only rows with a string vcs.repo", () => {
    const map = buildRepoSlugMap([
      { key: "sample", value: { vcs: { repo: "owner/sample" } } },
      { key: "broken", value: { vcs: { repo: "" } } },
      { key: "missing", value: {} },
      { key: "null", value: null },
    ]);
    expect(map.get("sample")).toBe("owner/sample");
    expect(map.has("broken")).toBe(false);
    expect(map.has("missing")).toBe(false);
    expect(map.has("null")).toBe(false);
  });
});

describe("workItemPrState", () => {
  it("reads value from statusSources.prState.value", () => {
    expect(workItemPrState({ statusSources: { prState: { value: "merged" } } })).toBe("merged");
  });

  it("returns null when missing", () => {
    expect(workItemPrState({})).toBeNull();
    expect(workItemPrState(null)).toBeNull();
  });
});

describe("workItemStatus", () => {
  it("returns the status field when set", () => {
    expect(workItemStatus({ status: "in-review" })).toBe("in-review");
  });

  it("returns null for empty / missing / non-object", () => {
    expect(workItemStatus({ status: "" })).toBeNull();
    expect(workItemStatus({})).toBeNull();
    expect(workItemStatus(null)).toBeNull();
  });
});

describe("deriveScore", () => {
  it("maps successful terminal statuses to 1", () => {
    expect(deriveScore("merged")).toBe(1);
    expect(deriveScore("completed")).toBe(1);
  });

  it("maps failure terminal statuses to 0", () => {
    for (const s of ["failed", "rejected", "cancelled", "duplicate"]) {
      expect(deriveScore(s)).toBe(0);
    }
  });

  it("returns null for in-flight or unknown statuses", () => {
    for (const s of ["pending", "in-progress", "in-review", "ready-to-merge", "reopened", "weird", null, undefined, ""]) {
      expect(deriveScore(s as string | null | undefined)).toBeNull();
    }
  });
});
