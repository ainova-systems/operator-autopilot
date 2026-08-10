import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOKEN_ENV_VAR,
  REPO_FEATURE_KEYS,
  buildRepoEntry,
  isValidRepoId,
  parseRepoSlug,
  suggestRepoId,
  type RepoDraftInput,
} from "./repo-draft.js";

function draft(overrides: Partial<RepoDraftInput> = {}): RepoDraftInput {
  return {
    repoId: "sample",
    slug: "owner/sample",
    branch: "develop",
    tokenEnvVar: DEFAULT_TOKEN_ENV_VAR,
    enabledFeatures: ["prReview", "findingSelect"],
    ...overrides,
  };
}

describe("parseRepoSlug", () => {
  it("accepts a bare owner/name", () => {
    expect(parseRepoSlug("owner/sample")).toEqual({
      owner: "owner",
      name: "sample",
      slug: "owner/sample",
    });
  });

  it("accepts a browser URL", () => {
    expect(parseRepoSlug("https://github.com/owner/sample")?.slug).toBe("owner/sample");
  });

  it("accepts a clone URL with the .git suffix", () => {
    expect(parseRepoSlug("https://github.com/owner/sample.git")?.slug).toBe("owner/sample");
  });

  it("accepts an SSH remote", () => {
    expect(parseRepoSlug("git@github.com:owner/sample.git")?.slug).toBe("owner/sample");
  });

  it("tolerates surrounding whitespace and trailing slashes", () => {
    expect(parseRepoSlug("  https://github.com/owner/sample/  ")?.slug).toBe("owner/sample");
  });

  it("rejects a bare name with no owner", () => {
    expect(parseRepoSlug("sample")).toBeNull();
  });

  it("rejects a path with extra segments", () => {
    expect(parseRepoSlug("owner/sample/tree/main")).toBeNull();
  });

  it("rejects characters GitHub does not allow in a slug", () => {
    expect(parseRepoSlug("owner/sam ple")).toBeNull();
  });

  it("rejects an empty string", () => {
    expect(parseRepoSlug("   ")).toBeNull();
  });
});

describe("suggestRepoId", () => {
  it("derives the id from the repository name", () => {
    expect(suggestRepoId("owner/Sample-Service")).toBe("sample-service");
  });

  it("collapses punctuation into single dashes", () => {
    expect(suggestRepoId("owner/My.Repo_v2")).toBe("my-repo-v2");
  });

  it("trims leading and trailing dashes", () => {
    expect(suggestRepoId("owner/-edge-")).toBe("edge");
  });

  it("falls back to the raw input when the slug does not parse", () => {
    expect(suggestRepoId("Not A Slug")).toBe("not-a-slug");
  });
});

describe("isValidRepoId", () => {
  it("accepts letters, digits, dash, and underscore", () => {
    expect(isValidRepoId("repo_1-a")).toBe(true);
  });

  it("rejects a leading dash", () => {
    expect(isValidRepoId("-repo")).toBe(false);
  });

  it("rejects an empty id", () => {
    expect(isValidRepoId("")).toBe(false);
  });
});

describe("buildRepoEntry", () => {
  it("produces a schema-valid row from the wizard answers", () => {
    const result = buildRepoEntry(draft());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.repoId).toBe("sample");
    expect(result.value.vcs).toEqual({
      platform: "github",
      repo: "owner/sample",
      branch: "develop",
      tokenEnvVar: DEFAULT_TOKEN_ENV_VAR,
    });
    expect(result.value.limits).toEqual({ maxActiveTasks: 2, maxActiveFindings: 2 });
    expect(result.value.debug).toBe(false);
  });

  it("writes every known feature key, enabled or not", () => {
    const result = buildRepoEntry(draft());
    if (!result.ok) throw new Error("expected a valid draft");
    const features = result.value.features ?? {};
    expect(Object.keys(features).sort()).toEqual([...REPO_FEATURE_KEYS].sort());
    expect(features.prReview).toBe(true);
    expect(features.taskExecute).toBe(false);
  });

  it("normalises a pasted URL down to owner/name", () => {
    const result = buildRepoEntry(draft({ slug: "https://github.com/owner/sample.git" }));
    if (!result.ok) throw new Error("expected a valid draft");
    expect(result.value.vcs.repo).toBe("owner/sample");
  });

  it("honors explicit limits and the debug flag", () => {
    const result = buildRepoEntry(
      draft({ maxActiveTasks: 1, maxActiveFindings: 5, debug: true }),
    );
    if (!result.ok) throw new Error("expected a valid draft");
    expect(result.value.limits).toEqual({ maxActiveTasks: 1, maxActiveFindings: 5 });
    expect(result.value.debug).toBe(true);
  });

  it("trims the id and branch before validating", () => {
    const result = buildRepoEntry(draft({ repoId: "  sample  ", branch: "  main  " }));
    if (!result.ok) throw new Error("expected a valid draft");
    expect(result.repoId).toBe("sample");
    expect(result.value.vcs.branch).toBe("main");
  });

  it("rejects an invalid repo id", () => {
    const result = buildRepoEntry(draft({ repoId: "-bad" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain("Repo id");
  });

  it("rejects an unparsable repository", () => {
    const result = buildRepoEntry(draft({ slug: "not-a-slug" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.includes("owner/name"))).toBe(true);
  });

  it("reports every missing field at once instead of one per attempt", () => {
    const result = buildRepoEntry(draft({ repoId: "", slug: "", branch: "", tokenEnvVar: "" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(4);
  });

  it("surfaces schema issues for a value the wizard cannot pre-validate", () => {
    const result = buildRepoEntry(draft({ maxActiveTasks: 0 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain("limits.maxActiveTasks");
  });
});
