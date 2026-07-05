---
path: "*"
schedule: daily
---

# Test Strategy Rules

Verification gates are what make AI-paced change safe in this repository. The
suite's job is to pin contracts so refactors trip loudly. Audit test quality —
not just presence — across `engine/**`, `packages/**`, `app/src/lib/**`.

## Regression discipline (P2)

- **A bug-fix commit without a failing-first regression test.** Scan recent fix
  commits (past tense "Fixed/Stopped/Prevented/Honored..." subjects): each must
  add or extend a test whose name describes the bug scenario. Flag fixes whose
  only test change is incidental.
- **Contract changes without cross-boundary pin tests.** Schema renames,
  path-prefix shifts, frontmatter additions, KV category changes — each needs a
  test exercising the contract from the CONSUMER side, not just the producer
  (the historical double-prefix regression survived review precisely because
  the caller contract had no end-to-end pin).

## Coverage quality (P2-P4)

- **Primitives below 95%** (`engine/pipeline/primitives/**`) or touched files
  below 90% — check the coverage report, list the uncovered branches that
  matter (error paths, terminal-status branches, reconciliation joins).
- **Error paths untested.** Every typed error a module can throw should be
  provoked by at least one test; catch-and-continue WARN branches need a test
  proving the cycle survives.
- **Orphans**: implementation files without a colocated `*.test.ts` (outside
  the documented exceptions) and test files whose subject module was deleted.

## Test hygiene (P4)

- **`vi.fn()` where a fake belongs.** Interface boundaries should use fake
  implementations (`TestKVStore`, `TestVCSPlatform`, ...) so tests assert
  behavior, not call shapes. Flag mock-heavy tests that would survive a real
  behavioral break.
- **Mocked `fs`.** Filesystem tests use real temp dirs via `fs.mkdtemp` —
  mocking `fs` is forbidden.
- **Fixture realism.** Fixtures must mirror real shapes (CRLF variants where
  parsers accept both, paginated response envelopes, KV rows with legacy
  keys). Generic placeholder names only (`sample`, `owner/<repo-id>`) — never
  real customer/sandbox project names.
- **Time and randomness pinned.** Tests must not depend on wall-clock timing
  or unseeded randomness; flaky-by-construction tests are defects.

## Reporting rules

- Point at the specific untested contract, not "coverage is low" in general.
- Priority follows blast radius: untested terminal-status or push-path logic
  is P2; cosmetic hygiene is P4-P6.
- Acceptance criteria list the exact test cases to add, named for the scenario
  they pin.
