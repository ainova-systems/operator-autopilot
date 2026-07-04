---
path: "*"
---

# Retrospective Quality-Log Rules

The weekly retrospective is the operator's durable learning loop. Its output is
a quality log: what failure classes recurred, what the analyzers missed, and
what they wrongly reported. Apply these rules when producing retrospective
findings for this repository.

## Curate analyzer prompts from rejections

- For every finding whose PR was closed without merge (rejected / false
  positive), extract the durable lesson and propose an edit to the "Known
  false-positive patterns" (or "Reporting rules") section of the analyzer that
  produced it. The bounded KNOWN_ISSUES dedup window forgets; analyzer prompts
  are the durable memory — rejections that never reach a prompt WILL recur.
- Name the analyzer file explicitly in the proposal and quote the exact
  pattern to suppress, phrased generically (no one-off file paths unless the
  suppression is genuinely file-specific).

## Close the incident-class loop

- For every bug fixed in the period (fix-type commits on master), check that
  some analyzer under `.operator/analyst/` detects the CLASS of that bug, not
  just the instance. If none does, propose the analyzer addition as a finding.
- For every WARN/ERROR pattern that appeared in execution logs more than once
  (fallbacks, synthesized outputs, expected-404 noise, reaped orphans),
  propose either a fix finding or an explicit suppression decision — repeated
  unexplained warnings are an unowned defect.

## Track recurring failure classes

- Compare against previous retrospectives in `.operator/data/retrospectives/`:
  a failure class appearing in two consecutive periods gets priority escalated
  one level and must reference the earlier retrospective by file name.
- Track the pipeline's own health metrics visible in execution history: agent
  retry rates, verdict distribution, review-loop round counts per PR, time
  from finding creation to merge. Flag sustained regressions.

## Output discipline

- One retrospective file per period in `.operator/data/retrospectives/`;
  proposals to change analyzer/creator/verifier rules are emitted as findings
  (kind: finding) so they go through the normal PR gate — the retrospective
  never edits rule files directly.
