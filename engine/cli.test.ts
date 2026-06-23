import { describe, it, expect } from "vitest";
import { parseArgs, printHelp } from "./cli.js";

describe("parseArgs", () => {
  it("parses --once flag", () => {
    const args = parseArgs(["node", "entry.ts", "--once"]);
    expect(args.once).toBe(true);
  });

  it("parses --repo with value", () => {
    const args = parseArgs(["node", "entry.ts", "--repo", "sample"]);
    expect(args.repo).toBe("sample");
  });

  it("parses --force with value", () => {
    const args = parseArgs(["node", "entry.ts", "--force", "research"]);
    expect(args.force).toBe("research");
  });

  it("parses --config with value", () => {
    const args = parseArgs(["node", "entry.ts", "--config", "/custom/config"]);
    expect(args.configDir).toBe("/custom/config");
  });

  it("parses --status flag", () => {
    const args = parseArgs(["node", "entry.ts", "--status"]);
    expect(args.status).toBe(true);
  });

  it("parses --help flag", () => {
    const args = parseArgs(["node", "entry.ts", "--help"]);
    expect(args.help).toBe(true);
  });

  it("parses -h as help", () => {
    const args = parseArgs(["node", "entry.ts", "-h"]);
    expect(args.help).toBe(true);
  });

  it("defaults configDir to ./config", () => {
    const args = parseArgs(["node", "entry.ts"]);
    expect(args.configDir).toBe("./config");
  });

  it("parses --workspace with value", () => {
    const args = parseArgs(["node", "entry.ts", "--workspace", "/path/to/repo"]);
    expect(args.workspace).toBe("/path/to/repo");
  });

  it("defaults workspace to undefined", () => {
    const args = parseArgs(["node", "entry.ts"]);
    expect(args.workspace).toBeUndefined();
  });

  it("parses --dry-run flag", () => {
    const args = parseArgs(["node", "entry.ts", "--dry-run"]);
    expect(args.dryRun).toBe(true);
  });

  it("defaults dryRun to false", () => {
    const args = parseArgs(["node", "entry.ts"]);
    expect(args.dryRun).toBe(false);
  });

  it("parses --fresh-db flag", () => {
    const args = parseArgs(["node", "entry.ts", "--fresh-db"]);
    expect(args.freshDb).toBe(true);
  });

  it("defaults freshDb to false", () => {
    const args = parseArgs(["node", "entry.ts"]);
    expect(args.freshDb).toBe(false);
  });

  it("parses combined workspace + dry-run + force", () => {
    const args = parseArgs(["node", "entry.ts", "--once", "--workspace", "/repo", "--dry-run", "--force", "cleanup"]);
    expect(args.once).toBe(true);
    expect(args.workspace).toBe("/repo");
    expect(args.dryRun).toBe(true);
    expect(args.force).toBe("cleanup");
  });

  it("defaults flags to false", () => {
    const args = parseArgs(["node", "entry.ts"]);
    expect(args.once).toBe(false);
    expect(args.status).toBe(false);
    expect(args.help).toBe(false);
    expect(args.repo).toBeUndefined();
    expect(args.force).toBeUndefined();
    expect(args.workspace).toBeUndefined();
  });

  it("parses combined flags", () => {
    const args = parseArgs(["node", "entry.ts", "--once", "--repo", "sample", "--force", "research"]);
    expect(args.once).toBe(true);
    expect(args.repo).toBe("sample");
    expect(args.force).toBe("research");
  });
});

describe("printHelp", () => {
  it("returns help text with usage examples", () => {
    const help = printHelp();
    expect(help).toContain("Operator V3");
    expect(help).toContain("--once");
    expect(help).toContain("--repo");
    expect(help).toContain("--force");
    expect(help).toContain("research");
  });
});
