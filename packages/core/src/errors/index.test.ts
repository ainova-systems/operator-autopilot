import { describe, it, expect } from "vitest";
import {
  OperatorError,
  AgentError,
  ConfigError,
  PlatformError,
  WorkspaceError,
  errorMessage,
} from "./index.js";

describe("OperatorError", () => {
  it("stores code and message", () => {
    const err = new OperatorError("ERR_GENERIC", "something broke");
    expect(err.code).toBe("ERR_GENERIC");
    expect(err.message).toBe("something broke");
    expect(err.name).toBe("OperatorError");
  });

  it("is instanceof Error", () => {
    const err = new OperatorError("ERR_TEST", "test");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(OperatorError);
  });

  it("supports cause via ErrorOptions", () => {
    const cause = new Error("root cause");
    const err = new OperatorError("ERR_WRAP", "wrapped", { cause });
    expect(err.cause).toBe(cause);
  });
});

describe("AgentError", () => {
  it("inherits from OperatorError", () => {
    const err = new AgentError("AGENT_TIMEOUT", "agent timed out");
    expect(err).toBeInstanceOf(OperatorError);
    expect(err).toBeInstanceOf(AgentError);
    expect(err.name).toBe("AgentError");
    expect(err.code).toBe("AGENT_TIMEOUT");
  });

  it("supports cause", () => {
    const cause = new Error("spawn failed");
    const err = new AgentError("AGENT_SPAWN", "cannot spawn", { cause });
    expect(err.cause).toBe(cause);
  });
});

describe("ConfigError", () => {
  it("inherits from OperatorError", () => {
    const err = new ConfigError("CONFIG_INVALID", "bad yaml");
    expect(err).toBeInstanceOf(OperatorError);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.name).toBe("ConfigError");
    expect(err.code).toBe("CONFIG_INVALID");
  });
});

describe("PlatformError", () => {
  it("inherits from OperatorError", () => {
    const err = new PlatformError("PLATFORM_AUTH", "auth failed");
    expect(err).toBeInstanceOf(OperatorError);
    expect(err).toBeInstanceOf(PlatformError);
    expect(err.name).toBe("PlatformError");
    expect(err.code).toBe("PLATFORM_AUTH");
  });
});

describe("WorkspaceError", () => {
  it("inherits from OperatorError", () => {
    const err = new WorkspaceError("WS_CLONE_FAILED", "clone failed");
    expect(err).toBeInstanceOf(OperatorError);
    expect(err).toBeInstanceOf(WorkspaceError);
    expect(err.name).toBe("WorkspaceError");
    expect(err.code).toBe("WS_CLONE_FAILED");
  });

  it("supports cause", () => {
    const cause = new Error("git error");
    const err = new WorkspaceError("WS_FETCH", "fetch failed", { cause });
    expect(err.cause).toBe(cause);
  });
});

describe("errorMessage", () => {
  it("extracts message from Error instances", () => {
    expect(errorMessage(new Error("test error"))).toBe("test error");
  });

  it("stringifies non-Error values", () => {
    expect(errorMessage("string error")).toBe("string error");
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(null)).toBe("null");
    expect(errorMessage(undefined)).toBe("undefined");
  });
});
