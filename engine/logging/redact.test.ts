import { describe, it, expect } from "vitest";
import { redactString, redactValue } from "./redact.js";

const REDACTED = "[REDACTED]";

describe("redactString", () => {
  it("redacts GitHub PAT tokens (ghp_)", () => {
    const input = "token is ghp_abcdefghijklmnopqrstuvwxyz123456";
    expect(redactString(input)).toBe(`token is ${REDACTED}`);
  });

  it("redacts GitHub app installation tokens (ghs_)", () => {
    const input = "ghs_abcdefghijklmnopqrstuvwxyz123456 is the token";
    expect(redactString(input)).toBe(`${REDACTED} is the token`);
  });

  it("redacts fine-grained GitHub PATs (github_pat_)", () => {
    const input = "use github_pat_abcdefghijklmnopqrstuvwxyz123456";
    expect(redactString(input)).toBe(`use ${REDACTED}`);
  });

  it("redacts Anthropic API keys (sk-ant-)", () => {
    const input = "using sk-ant-abc123def456ghi789jkl here";
    expect(redactString(input)).toBe(`using ${REDACTED} here`);
  });

  it("redacts cloud-provider keys (af_)", () => {
    const input = "af_abcdefghijklmnopqrstuvwxyz";
    expect(redactString(input)).toBe(REDACTED);
  });

  it("redacts OpenAI/OpenRouter keys (sk-)", () => {
    const input = "sk-proj-abcdefghijklmnopqrstuvwxyz";
    expect(redactString(input)).toBe(REDACTED);
  });

  it("redacts Bearer tokens", () => {
    const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc123';
    expect(redactString(input)).toBe(`Authorization: ${REDACTED}`);
  });

  it("redacts generic key=value patterns", () => {
    const input = 'token=abc123def456ghi789jkl012mno';
    expect(redactString(input)).toBe(REDACTED);
  });

  it("preserves non-secret strings", () => {
    const input = "Normal log message with no secrets";
    expect(redactString(input)).toBe(input);
  });

  it("redacts multiple tokens in one string", () => {
    const input = "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa and af_bbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const result = redactString(input);
    expect(result).toBe(`${REDACTED} and ${REDACTED}`);
  });

  it("handles empty string", () => {
    expect(redactString("")).toBe("");
  });

  it("does not redact identifiers that contain a token prefix as substring", () => {
    // `task-execute-run-...` contains `sk-execute-run-...` as a
    // substring — must NOT match the OpenAI-key pattern because the
    // `sk-` is preceded by an identifier char (`a` in `task`).
    const input = "execution-reconcile: task-execute-run-1777282367956-f65iw1-1777282384450 → timed-out";
    expect(redactString(input)).toBe(input);
  });

  it("redacts a token-prefix at start of string", () => {
    const input = "sk-anthropic_super_long_key_value_xyz123";
    expect(redactString(input)).toBe(REDACTED);
  });

  it("redacts a token-prefix after whitespace", () => {
    const input = "Header: sk-anthropic_super_long_key_value_xyz123";
    expect(redactString(input)).toBe(`Header: ${REDACTED}`);
  });
});

describe("redactValue", () => {
  it("redacts strings", () => {
    expect(redactValue("ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(REDACTED);
  });

  it("returns numbers as-is", () => {
    expect(redactValue(42)).toBe(42);
  });

  it("returns booleans as-is", () => {
    expect(redactValue(true)).toBe(true);
  });

  it("returns null as-is", () => {
    expect(redactValue(null)).toBeNull();
  });

  it("returns undefined as-is", () => {
    expect(redactValue(undefined)).toBeUndefined();
  });

  it("redacts strings inside objects", () => {
    const input = { token: "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", count: 5 };
    const result = redactValue(input) as Record<string, unknown>;
    expect(result["token"]).toBe(REDACTED);
    expect(result["count"]).toBe(5);
  });

  it("redacts strings inside nested objects", () => {
    const input = {
      auth: {
        key: "sk-ant-abc123def456ghi789jkl",
      },
      name: "test",
    };
    const result = redactValue(input) as Record<string, Record<string, unknown>>;
    expect(result["auth"]["key"]).toBe(REDACTED);
    expect(result["name"]).toBe("test");
  });

  it("redacts strings inside arrays", () => {
    const input = ["normal", "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"];
    const result = redactValue(input) as string[];
    expect(result[0]).toBe("normal");
    expect(result[1]).toBe(REDACTED);
  });

  it("handles mixed arrays", () => {
    const input = [1, "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", null, { key: "safe" }];
    const result = redactValue(input) as unknown[];
    expect(result[0]).toBe(1);
    expect(result[1]).toBe(REDACTED);
    expect(result[2]).toBeNull();
    expect(result[3]).toEqual({ key: "safe" });
  });
});
