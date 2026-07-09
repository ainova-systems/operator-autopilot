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

  it("coerces integers and booleans the way strict YAML would", () => {
    expect(lenientParseBlock(["priority: 3", "recoverable: false", "flag: true", "neg: -2"])).toEqual({
      priority: 3,
      recoverable: false,
      flag: true,
      neg: -2,
    });
  });

  it("treats a key with no value as an empty string", () => {
    expect(lenientParseBlock(["note:"])).toEqual({ note: "" });
  });

  it("ignores lines that are not top-level key/value pairs", () => {
    expect(lenientParseBlock(["  indented: skipped", "prose without a colon", "key: value"])).toEqual({
      key: "value",
    });
  });

  it("returns null when there is no key line to recover", () => {
    expect(lenientParseBlock(["{ unclosed flow", "- just a list item"])).toBeNull();
  });
});

// ── Block scalars ────────────────────────────────────────────────────

describe("lenientParseBlock — block scalars", () => {
  it("keeps newlines for a `|` literal block scalar (clip chomping)", () => {
    const out = lenientParseBlock([
      "title: Fix: reorder args",
      "body: |",
      "  Para one.",
      "",
      "  Para two.",
    ]);
    expect(out).toEqual({
      title: "Fix: reorder args",
      body: "Para one.\n\nPara two.\n",
    });
  });

  it("folds newlines to spaces for a `>` block scalar (differs from `|`)", () => {
    // Regression for the review note: `>` must fold interior newlines to
    // spaces and collapse a blank-line run to a single paragraph break,
    // unlike the literal `|` above.
    const out = lenientParseBlock([
      "summary: >",
      "  line one",
      "  line two",
      "",
      "  next paragraph",
    ]);
    expect(out).toEqual({ summary: "line one line two\nnext paragraph\n" });
  });

  it("honours a chomping indicator on the block-scalar header (`|-`, `>-`)", () => {
    expect(lenientParseBlock(["body: |-", "  only line"])).toEqual({ body: "only line\n" });
    expect(lenientParseBlock(["body: >-", "  a", "  b"])).toEqual({ body: "a b\n" });
  });

  it("dedents by the first content line's indent and stops at the next top-level key", () => {
    const out = lenientParseBlock([
      "body: |",
      "    deeply indented",
      "next: after",
    ]);
    expect(out).toEqual({ body: "deeply indented\n", next: "after" });
  });
});
