# Project Name Hygiene

> **No real customer or managed project is named anywhere in this repository.** The runtime is a
> product that runs for many projects; a project's manifest, scripts and skills live in that
> project's own repository.

This rule applies to source files (`src/`), tests, comments, fixtures (`fixtures/`), documentation,
intelligence content (`intelligence/**`), CI workflows (`.github/**`), and scripts (`scripts/`,
`deploy/`).

## FORBIDDEN

- **🚨 Naming a real customer or managed project** in code, comments, tests, fixtures, docs,
  intelligence files, CI workflows, scripts, env-var names, secret names, file or directory names -
  in any case variant.
- **🚨 Project-specific vocabulary in `src/`**: a project's labels, milestones, branch prefixes,
  skill names or workspace names. The runtime reads them from a manifest; it never hard-codes them.
- **Attributing observations to a real project** in comments ("seen on <customer> …"). Keep the
  technical content, drop the attribution.
- **Project-name-prefixed env vars or files** (`<NAME>_TOKEN`, `migrate-<customer>.mjs`). Use the
  role the value plays (`AINOFLOW_API_KEY`, `OPERATOR_MANIFEST`).

## REQUIRED

- **Generic placeholders** in tests, fixtures and examples: project `demo`, subjects like `item-1`
  or `pr-7`, workspaces like `slot-a`, `d1`, paths under a temporary directory.
- **`<project>` placeholder** in docs and help text (`operator@<project>.service`).

## Why

Customer names in a generic runtime leak deployment specifics into a product meant for many
projects, and create churn the day the managed project changes. A project binds itself to the
runtime through its own manifest.
