import { describe, it, expect } from "vitest";
import { parseCommand, hasCommand, extractCommands } from "./command-parser.js";

describe("parseCommand", () => {
  it("parses simple command", () => {
    const cmd = parseCommand("/status");
    expect(cmd).not.toBeNull();
    expect(cmd!.command).toBe("status");
    expect(cmd!.args).toEqual([]);
  });

  it("parses command with args", () => {
    const cmd = parseCommand("/research sample");
    expect(cmd!.command).toBe("research");
    expect(cmd!.args).toEqual(["sample"]);
  });

  it("parses command with multiple args", () => {
    const cmd = parseCommand("/retry T20260322-000101 --force");
    expect(cmd!.command).toBe("retry");
    expect(cmd!.args).toEqual(["T20260322-000101", "--force"]);
  });

  it("returns null for non-command text", () => {
    expect(parseCommand("just a comment")).toBeNull();
    expect(parseCommand("")).toBeNull();
  });

  it("returns null for unknown commands", () => {
    expect(parseCommand("/unknown")).toBeNull();
    expect(parseCommand("/deploy")).toBeNull();
  });

  it("is case insensitive", () => {
    const cmd = parseCommand("/STATUS");
    expect(cmd!.command).toBe("status");
  });

  it("handles command embedded in text", () => {
    const cmd = parseCommand("Please /cancel this task");
    expect(cmd!.command).toBe("cancel");
  });

  it("parses /duplicate command", () => {
    const cmd = parseCommand("/duplicate");
    expect(cmd!.command).toBe("duplicate");
  });

  it("parses /help command", () => {
    const cmd = parseCommand("/help");
    expect(cmd!.command).toBe("help");
  });

  it("trims whitespace", () => {
    const cmd = parseCommand("  /pause  ");
    expect(cmd!.command).toBe("pause");
  });
});

describe("hasCommand", () => {
  it("returns true for text with command", () => {
    expect(hasCommand("/status")).toBe(true);
  });

  it("returns false for text without command", () => {
    expect(hasCommand("no command here")).toBe(false);
  });
});

describe("extractCommands", () => {
  it("extracts multiple commands from multiline text", () => {
    const text = "Please review\n/pause\nSome text\n/retry T1\nDone";
    const cmds = extractCommands(text);

    expect(cmds).toHaveLength(2);
    expect(cmds[0].command).toBe("pause");
    expect(cmds[1].command).toBe("retry");
    expect(cmds[1].args).toEqual(["T1"]);
  });

  it("returns empty for text without commands", () => {
    expect(extractCommands("just text\nno commands")).toEqual([]);
  });

  it("handles single-line with command", () => {
    const cmds = extractCommands("/status");
    expect(cmds).toHaveLength(1);
  });
});
