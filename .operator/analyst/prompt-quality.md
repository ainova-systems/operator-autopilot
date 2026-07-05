---
path: "*"
schedule: daily
---

# Prompt and Agent-Contract Quality Rules

The engine's bundled prompts (`engine/content/prompts/**`), templates
(`engine/content/templates/**`), and stage/kind registries (`stages.yaml`,
`kinds.yaml`) are runtime configuration for LLM agents. A stale or contradictory
prompt produces wrong agent behavior that no compiler catches, so prompt↔code
drift is a first-class defect here — two live instances were caught on the very
first self-init PR (a stale auto-detect order copied from `scout.md`, and an
overstated merge-policy claim in the user README template).

## Prompt ↔ code drift (P2)

- **Factual claims in prompts that contradict engine code.** Every statement in
  a bundled prompt about engine behavior (detection order, file layout, label
  names, branch prefixes, schedule semantics, verdict values) must match the
  implementing module. Cross-check `scout.md` / `analyst.md` / `creator.md` /
  `supervisor.md` / context files against `engine/config/discovery.ts`,
  `engine/pipeline/**`, and `engine/content/prompts/stages.yaml`.
- **Templates that overstate or understate policy.** Templates shown to users
  (PR bodies, READMEs) must match `docs/workflow.md` — e.g. merge gating is
  configurable per stage, not unconditionally human-only.
- **Copied constants.** A prompt that restates a value defined elsewhere (label
  name, path, threshold) instead of referencing its source will drift; flag
  restatements of single-source-of-truth conventions.

## Agent output contract consistency (P2)

- **AOP EMIT contract.** Every prompt that instructs an agent to emit
  `=== EMIT ... ===` blocks must state the same field set the parser accepts
  (`engine/**` AOP applier/parser modules). Fields the parser ignores or
  requires must not differ from what prompts promise.
- **Expected-output blocks per provider.** If the engine parses a structural
  block from agent output (e.g. an `## Execution Summary` section), every role
  prompt whose output is parsed that way must require the block explicitly —
  a WARN like "missing block, using synthesized fallback" on a SUCCESSFUL run
  means the prompt and the parser disagree.
- **Verdict vocabulary.** Prompts must only promise verdict values the router
  accepts; the router must handle every verdict a prompt can produce.

## Registry alignment (P2-P4)

- **`stages.yaml` ↔ prompts**: every stage references an existing role prompt
  and reviewer-criteria file; no prompt file is orphaned (unreferenced by any
  stage or kind).
- **`kinds.yaml` ↔ behavior**: ID prefixes, branch prefixes, terminal statuses,
  and downstream-stage links declared per kind must match what selectors and
  routers implement.
- **Template variables**: every `{PLACEHOLDER}` in a prompt/template must be
  supplied by the prompt builder; every supplied variable must be consumed.

## Reporting rules

- Quote both sides of a drift (prompt text AND code) with file:line for each.
- Propose the fix on the side that is wrong (usually the prompt); if the code is
  wrong, say so explicitly and mark the higher priority.
- Acceptance criteria MUST include a contract test that pins the two sides
  together where feasible (e.g. a test asserting the documented order matches
  the implemented candidate list).
