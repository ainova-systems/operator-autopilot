---
path: "*"
schedule: daily
---

# Staleness and Obsolete-Data Rules

Scope: temporal drift — statements, config, and data that WERE true and silently
stopped being true. Style/naming issues belong to `consistency.md`; agent
prompt/template ↔ code contracts belong to `prompt-quality.md`. This analyzer
owns everything else that ages. A live example of the class: a v5 engine whose
CLI help banner still announced a retired engine generation.

## Retired versions and branding (P2-P4)

- References to retired engine generations (e.g. "V3", "V4") or superseded
  product names in live code, CLI output, help banners, log lines, or comments —
  anywhere outside explicitly historical material (migration lessons, archives).
- User-facing strings announcing a wrong version or name (help text, status
  footer, PR/comment templates). Version strings should be sourced from
  `package.json`, not duplicated as literals.

## Dead configuration (P2-P4)

- Config keys that are parsed and loaded but consumed by no runtime path — or
  consumed only by test helpers. Schema, loader, `defaults.yaml`, and
  `stages.yaml` must agree on what is alive; a key alive only in tests masks
  the dead-code gate.
- Comments in `defaults.yaml` / `.env.local.example` / `deployment/**`
  describing behavior that no longer exists.
- Selector/stage config keys in `stages.yaml` that no selector or composer
  reads anymore.

## Docs describing retired behavior (P2-P4)

- `docs/**` statements contradicted by the current code or stage config
  (schedule models, stage lists, persistence modes, verdict sets, directory
  layouts).
- README / deployment examples invoking commands, flags, npm scripts, or env
  vars that no longer exist — cross-check against `package.json` scripts and
  the actual CLI argument parser.
- Broken internal links or references to files that were moved, deleted, or
  extracted out of the repository.

## Aged operational data (P4-P6)

- `.operator/data/**` items referencing files or code paths that no longer
  exist in the tree.
- Analyzer "known false-positive" suppressions pointing at removed code — a
  suppression that can never match again is noise to future readers.
- `CHANGELOG.md` `[Unreleased]` section drifting from what actually landed.

## Reporting rules

- Prove staleness both ways: read the current code/config to show the claim is
  false or the target is gone — absence of grep hits alone is not proof.
- One finding per staleness cluster (e.g. every retired-version banner in one
  finding), with all occurrences listed.
- Fix proposals must update the single source of truth and all consumers in
  the same change (`intelligence/rules/dev-context-engineering.md`: doc drift
  is a defect fixed in the same change as the code).
- Where feasible, acceptance criteria include a structural pin that prevents
  recurrence (e.g. banner version read from `package.json` instead of a
  literal, a contract test tying a doc'd list to the implementing module).
