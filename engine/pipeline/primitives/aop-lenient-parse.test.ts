import { describe, it, expect } from "vitest";
import { lenientParseBlock } from "./aop-lenient-parse.js";

// ── Flat key/value recovery ──────────────────────────────────────────

describe("lenientParseBlock — flat scalars", () => {
  it("preserves a colon-space inside a value instead of splitting it", () => {
    const out = lenientParseBlock([
      "thread: 3539510600",
      "disposition: fixed",
      "note: Reordered arguments: fmi is now passed positionally.",
    ]);
    expect(out).toEqual({
      thread: 3539510600,
      disposition: "fixed",
      note: "Reordered arguments: fmi is now passed positionally.",
    });
  });

  it("strips a single pair of matching surrounding quotes", () => {
    expect(lenientParseBlock(['note: "Fixed: added guard"'])).toEqual({ note: "Fixed: added guard" });
    expect(lenientParseBlock(["note: 'single: quoted'"])).toEqual({ note: "single: quoted" });
  });

  it("leaves an unmatched or single quote untouched", () => {
    expect(lenientParseBlock(['note: "half quoted'])).toEqual({ note: '"half quoted' });
    expect(lenientParseBlock(["note: x"])).toEqual({ note: "x" });
  });

  it("coerces bare integers and booleans the way strict YAML would", () => {
    expect(lenientParseBlock(["priority: 3", "recoverable: false", "flag: true", "neg: -2"])).toEqual({
      priority: 3,
      recoverable: false,
      flag: true,
      neg: -2,
    });
  });

  it("keeps a QUOTED scalar a string — quoting is what declares the type", () => {
    // Strict YAML: `flag: "true"` is the string "true", `title: "123"` the
    // string "123". Coercing after stripping the quotes would discard exactly
    // the signal that told YAML these are strings.
    expect(lenientParseBlock(['flag: "true"', 'title: "123"', "bare: 123"])).toEqual({
      flag: "true",
      title: "123",
      bare: 123,
    });
  });

  it("treats a bare `key:` with no value as null, matching strict YAML", () => {
    expect(lenientParseBlock(["note:"])).toEqual({ note: null });
    expect(lenientParseBlock(['note: ""'])).toEqual({ note: "" });
  });
});

// ── Wrapped plain scalars (continuation folding) ──────────────────────

describe("lenientParseBlock — wrapped plain scalars", () => {
  it("folds a wrapped continuation line into the preceding scalar instead of truncating it", () => {
    // Regression: the long notes that carry a colon-space are exactly the ones
    // a model wraps. Dropping the continuation produced a silently truncated
    // reply that still satisfied `note: z.string().min(1)`, so the supervisor
    // posted half an answer and marked the review thread handled.
    expect(lenientParseBlock(["note: fixed the bug: renamed arg", "  now it compiles"])).toEqual({
      note: "fixed the bug: renamed arg now it compiles",
    });
  });

  it("folds several continuation lines and stops at the next top-level key", () => {
    expect(
      lenientParseBlock([
        "note: Reordered arguments: fmi",
        "  is now passed",
        "  positionally.",
        "disposition: fixed",
      ]),
    ).toEqual({ note: "Reordered arguments: fmi is now passed positionally.", disposition: "fixed" });
  });

  it("ends a plain scalar at a blank line rather than folding across it", () => {
    expect(lenientParseBlock(["note: first: value", "", "disposition: fixed"])).toEqual({
      note: "first: value",
      disposition: "fixed",
    });
  });

  it("adopts a continuation as the value when the key had none", () => {
    expect(lenientParseBlock(["note:", "  wrapped onto the next line"])).toEqual({
      note: "wrapped onto the next line",
    });
  });

  it("refuses (returns null) when a stray line has no scalar to continue", () => {
    // Never mask malformation: with nothing to attach to, the caller must
    // report the original yaml-parse-error.
    expect(lenientParseBlock(["{ unclosed flow", "- just a list item"])).toBeNull();
    expect(lenientParseBlock(["  leading indented junk", "key: value"])).toBeNull();
  });

  it("returns null for an empty or all-blank body", () => {
    expect(lenientParseBlock([])).toBeNull();
    expect(lenientParseBlock(["", "   "])).toBeNull();
  });
});

// ── Block scalars ────────────────────────────────────────────────────

describe("lenientParseBlock — block scalars", () => {
  it("keeps newlines for a `|` literal block scalar (clip chomping)", () => {
    const out = lenientParseBlock(["title: Fix: reorder args", "body: |", "  Para one.", "", "  Para two."]);
    expect(out).toEqual({ title: "Fix: reorder args", body: "Para one.\n\nPara two.\n" });
  });

  it("folds newlines to spaces for a `>` block scalar (differs from `|`)", () => {
    const out = lenientParseBlock(["summary: >", "  line one", "  line two", "", "  next paragraph"]);
    expect(out).toEqual({ summary: "line one line two\nnext paragraph\n" });
  });

  it("honours strip chomping (`|-` / `>-`) by dropping the trailing newline", () => {
    // Strict YAML ground truth: `a: |-\n  only line` -> "only line";
    //                           `a: >-\n  a\n  b`    -> "a b".
    expect(lenientParseBlock(["body: |-", "  only line"])).toEqual({ body: "only line" });
    expect(lenientParseBlock(["body: >-", "  a", "  b"])).toEqual({ body: "a b" });
  });

  it("honours keep chomping (`|+`) by preserving trailing blank lines", () => {
    expect(lenientParseBlock(["body: |+", "  only line", "", ""])).toEqual({ body: "only line\n\n\n" });
  });

  it("clips to exactly one trailing newline when no chomping indicator is given", () => {
    expect(lenientParseBlock(["body: |", "  only line", "", ""])).toEqual({ body: "only line\n" });
  });

  it("dedents by the first content line's indent and stops at the next top-level key", () => {
    expect(lenientParseBlock(["body: |", "    deeply indented", "next: after"])).toEqual({
      body: "deeply indented\n",
      next: "after",
    });
  });
});
