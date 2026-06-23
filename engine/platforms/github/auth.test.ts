import { describe, it, expect } from "vitest";
import { Octokit } from "@octokit/rest";
import { createOctokit, parseRepoSlug } from "./auth.js";
import type { Logger } from "../../logging/logger.js";

function stubLogger(): Logger {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop, child: () => stubLogger() };
}

describe("createOctokit", () => {
  it("returns an Octokit instance", () => {
    const client = createOctokit("ghp_test_token");
    expect(client).toBeInstanceOf(Octokit);
  });

  it("accepts an optional logger for structured HTTP logging", () => {
    const client = createOctokit("ghp_test_token", stubLogger());
    expect(client).toBeInstanceOf(Octokit);
  });

  it("routes Octokit log methods through the provided logger", () => {
    const calls: string[] = [];
    const logger: import("../../logging/logger.js").Logger = {
      debug: (msg) => calls.push(`debug:${msg}`),
      info: (msg) => calls.push(`info:${msg}`),
      warn: (msg) => calls.push(`warn:${msg}`),
      error: (msg) => calls.push(`error:${msg}`),
      child: () => logger,
    };
    const client = createOctokit("ghp_test_token", logger);
    // Exercise the log adapter functions Octokit exposes
    client.log.debug("d");
    client.log.info("i");
    client.log.warn("w");
    client.log.error("e");
    // info routes to debug (HTTP noise reduction)
    expect(calls).toEqual(["debug:d", "debug:i", "warn:w", "error:e"]);
  });
});

describe("parseRepoSlug", () => {
  it("parses valid owner/repo slug", () => {
    const result = parseRepoSlug("owner/sample");
    expect(result.owner).toBe("owner");
    expect(result.repo).toBe("sample");
  });

  it("throws on empty string", () => {
    expect(() => parseRepoSlug("")).toThrow("Invalid repo slug");
  });

  it("throws on slug without slash", () => {
    expect(() => parseRepoSlug("no-slash-here")).toThrow("Invalid repo slug");
  });

  it("throws on slug with multiple slashes", () => {
    expect(() => parseRepoSlug("a/b/c")).toThrow("Invalid repo slug");
  });

  it("throws on slug with empty owner", () => {
    expect(() => parseRepoSlug("/repo")).toThrow("Invalid repo slug");
  });

  it("throws on slug with empty repo", () => {
    expect(() => parseRepoSlug("owner/")).toThrow("Invalid repo slug");
  });
});
