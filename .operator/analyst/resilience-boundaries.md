---
path: "*"
schedule: daily
---

# Boundary Resilience Rules

The operator consumes hostile input at every boundary: LLM agent output, YAML
config, markdown frontmatter, GitHub API responses, and host shells on multiple
platforms. Past incidents in this repository include CRLF frontmatter breaking
parsing, POSIX-only subshell chains failing on `cmd.exe`, and strict schemas
crashing boot on legacy KV rows. Check the actual parsing/validation code —
`packages/adapters/src/**`, `engine/infra/**`, `engine/agents/**`,
`engine/platforms/**`.

## Parsing robustness (P1-P2)

- **Frontmatter / YAML tolerance.** Work-item and rule-file parsers must accept
  CRLF and LF, quoted and unquoted scalar values, and BOM prefixes. Any parser
  keyed on `\n`-only splits or exact-match `---` lines is a defect.
- **Agent output parsing** must be wrapped in try/catch producing a typed
  `AgentError` with the raw output preserved in the execution log. A parse
  failure must never crash the cycle or silently discard the run.
- **GitHub API edge cases**: every list call paginates (`.paginate()`); an
  expected 404 (existence probe before create) must not surface as an
  ERROR-level log line; response shapes validated before member access.

## Schema strictness policy (P1)

- **KV-persisted schemas stay lenient.** Zod schemas validating rows that
  outlive deployments (`repos/*`, feature flags, UI-owned config) must strip
  unknown keys, never `.strict()` — a legacy key must not be able to crash
  boot. Strictness belongs at write-time boundaries, not read-time.
- **Validation at the boundary only.** External data is Zod-validated once at
  entry; internal code trusts validated types (no defensive re-checks that
  mask contract gaps).

## Bounded self-healing, never silent recovery (P1)

- Every recovery path (expired lock reap, orphan reconciliation, stale-state
  reset) must be bounded by TTL/attempt budget AND logged with what was
  recovered and why. `catch {}` or a recovery that swallows the original error
  is a defect regardless of how convenient it is.

## Cross-platform execution (P2)

- **Any command string executed on the operator host** (project `init`/`verify`
  scripts, spawned CLIs, generated scripts) must be shell-portable: no POSIX
  `(cd …)` subshell chains, no `$VAR` expansion assumptions, no `/dev/null`.
  Prefer tool-native directory flags (`npm --prefix`, `dotnet build <path>`).
- **Paths**: never build paths with hardcoded `/` or `\` string concatenation
  in host-facing code; use `node:path`. Never resolve config relative to
  `process.cwd()` — use the module root or injected roots.
- **Line endings**: all repo text files are LF (enforced via `.gitattributes`);
  code that WRITES files must not emit CRLF on Windows hosts.

## Reporting rules

- Reproduce the failure mode concretely in the finding (what input breaks it).
- Prefer one finding per boundary with all fragile sites listed.
- Acceptance criteria MUST include a regression test feeding the hostile input
  (CRLF fixture, unpaginated response fixture, unknown KV key, etc.).
