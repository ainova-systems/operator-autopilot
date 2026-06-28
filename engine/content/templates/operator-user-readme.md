# AI Operator

Automated AI engineering system. The **operator core is domain-agnostic** — it only orchestrates the pipeline (scheduling, branching, PR lifecycle, retries, labels). All domain-specific knowledge (coding standards, review criteria, architecture rules) lives in this `.operator/` directory as phase-specific rules.

## How It Works

The operator runs on a schedule (every few minutes) and performs these actions:

1. **Branch cleanup** — deletes `ai/*` branches whose PRs are merged or closed
2. **PR review** — responds to comments and CI on open `ai/*` PRs, applies requested changes
3. **Research** — runs analyzers to scan the codebase and writes new findings (`status: pending`) into a research PR. Findings enter the queue once that PR is merged.
4. **Finding planning** — picks the highest-priority pending finding, validates it, generates tasks, and opens a PR. Tasks enter the queue once that PR is merged.
5. **Task execution** — picks the highest-priority pending task, implements the change, and opens a PR for review.
6. **Retrospective** (weekly) — learns from merged/rejected PR feedback and tunes agent prompts and analyzer rules.

All changes go through PRs. **Nothing is merged without human approval** — each stage advances only after a human merges the previous stage's PR.

## Work items live FLAT — status is frontmatter, not a folder

> **Every work item is a single `.md` file directly inside its kind directory** (`.operator/data/findings/`, `.operator/data/tasks/`, …). The file's `status:` frontmatter field is its lifecycle state. **The directory is NOT the status.**
>
> Do **NOT** create status subdirectories such as `pending/`, `todo/`, `completed/`, or `reopened/`, and do **NOT** move files between folders to change their state. The engine reads each data directory **non-recursively**, so any file nested in a subdirectory is invisible to it and will be silently dropped from the queue. To change a work item's state, change its `status:` field (the operator does this for you).

## Quick Start

### 1. Project Config

`project.yaml` — the engine reads only `context` and `scripts` from it:

```yaml
name: YourProject          # optional, descriptive only
context: CLAUDE.md         # global context file loaded for all agents

scripts:
  init: npm ci                              # run once after clone (install toolchains)
  verify: npm run lint && npm run build     # the post-change gate, run after every agent change
```

- `context` — global context file loaded for all agents (auto-detected if omitted: `AGENTS.md` → `CLAUDE.md` → `.cursorrules` → `OPERATOR.md`)
- `scripts.init` — run before agent execution (install dependencies)
- `scripts.verify` — run after agent changes (build/lint/test gate)

> Pipeline features (which stages run), active-item limits, and schedules are configured **in the operator instance**, not in `project.yaml`.

### 2. Phase Rule Folders

The operator core provides generic agent templates. **Domain-specific knowledge lives here** in phase-specific rule folders. During execution, the operator discovers matching rules based on the `path` frontmatter and injects them into agent prompts.

**Frontmatter fields (same for all folders):**
- `path` (optional): glob pattern for file filtering (default: `*`)
- `schedule` (optional, analysts only): `daily`, `weekly`, `weekly:N` (N=1-7, Mon-Sun), `on-demand`
- `enabled` (optional): `true`/`false` (default: `true`)

**Folder purposes:**
- `context/` — loaded for ALL agents, path-filtered by affected files. General project knowledge.
- `analyst/` — each file = one independent analyzer run during research
- `creator/` — rules for task execution (creator agent). Path-matched to the task's target files.
- `verifier/` — rules for PR review. Path-matched to the changed files in the PR.
- `planner/` — rules for finding validation and task generation. Path-matched to the finding's target.
- `improver/` — rules for the weekly retrospective agent.

**Example: verifier rule for backend code**

```markdown
---
path: "Source/Backend/**"
---

# Backend Review Rules

- All commands must go through CommandProcessor
- Repositories for all data access, no direct DB queries
- Named exports only, no default exports
```

**How rule discovery works:**
1. The pipeline detects the target path (e.g. the changed files in a PR, or a task's affected files).
2. It selects every rule in the relevant phase folder whose `path` glob overlaps that target, skipping `enabled: false`.
3. The matching rule bodies are merged into the agent's prompt for that run.
4. If no rules match, the agent falls back to its generic behavior.

### 3. That's It

The operator handles everything else: scheduling, branch management, PR creation, retries, label management, and work-item status tracking.

## Directory Structure

```
.operator/
├── project.yaml                    # Project config (engine reads `context` + `scripts`)
├── context/                        # Context files (loaded for ALL agents, path-filtered)
│   ├── project.md                  # Project overview, always loaded (path: "*")
│   ├── frontend.md                 # path: Source/Frontend/**
│   └── backend.md                  # path: Source/Backend/**
├── analyst/                        # Each file = one analyzer run during research
│   ├── code-quality.md
│   ├── security.md
│   └── consistency.md
├── creator/                        # Task-execution rules (path-filtered)
├── verifier/                       # PR-review rules (path-filtered)
├── planner/                        # Finding-validation / task-generation rules (path-filtered)
├── improver/                       # Retrospective (optimization) rules
├── data/                           # Work items — FLAT per kind; status lives in frontmatter
│   ├── findings/                   # F{YYYYMMDD}-{id}.md
│   ├── tasks/                      # T{YYYYMMDD}-{id}.md
│   ├── requests/                   # R{YYYYMMDD}-{id}.md
│   └── retrospectives/             # W{YYYYMMDD}.md
└── README.md
```

There are no per-status or per-date subdirectories — see the callout above.

## Task Lifecycle

A task is one file at `.operator/data/tasks/{ID}.md`; only its `status:` field changes:

```
status: pending
  ↓  task-select picks it, creates branch ai/tasks/{ID}, opens a draft PR + ai:pending
status: in-progress            (branch existence indicates active work)
  ↓  task-execute runs the creator agent (with retries)
  ├── SUCCESS → PR marked ready + ai:in-review → review cycle open
  │           → AI verifies PR clean → ai:ready-to-merge → human merges → status: completed
  └── FAILURE → PR stays draft + ai:failed → see Troubleshooting below
```

### PR Labels

- `ai:pending` — task selected, awaiting execution
- `ai:processing` — execution in progress OR PR review in progress
- `ai:in-review` — changes applied, review loop open (CI / human comments re-enter pr-review)
- `ai:ready-to-merge` — AI verified the PR without changes; human merge is the remaining step
- `ai:failed` — execution failed after retries

### Rejection Flow

When a user closes a task or finding PR without merging:
1. A later research run detects the closed PR.
2. The diagnoser evaluates it and recommends an action:
   - **Reopen** (`poor-implementation`, `approach-wrong`): the item's `status:` is set to `reopened` for a retry (max 2 reopens).
   - **Reject** (`false-positive`, `too-complex`, `scope-wrong`, etc.): the item's `status:` is set to `rejected`.
3. Reopened items are automatically selected for a new attempt.
4. After 2 failed reopens, items are force-rejected.

## Work Item File Format

```yaml
---
id: "T20260122-0001"
title: "Fix permission check in document handler"
kind: task
priority: 1
status: pending
created_at: "2026-01-22T08:00:00Z"
source: "F20260122-0001"      # the finding this task came from (optional)
---

# Fix permission check in document handler

## Problem
Description of the issue found by the analyzer.

## Solution
Steps the creator agent should follow.

## Affected Files
- Source/Backend/path/to/handler.cs

## Acceptance Criteria
- Build passes
- Existing tests pass
```

IDs follow `{PREFIX}{YYYYMMDD}-{ID}` (F=finding, T=task, R=request, W=retrospective). Priority: 1 (highest) to 8 (lowest); selectors pick the lowest number first. The orchestrator owns every frontmatter field — agents never edit `status:` directly.

## Customization

**Add domain rules** — create `.md` files in phase folders (`creator/`, `verifier/`, `planner/`, `improver/`). Use the `path` frontmatter to scope rules to specific file patterns.

**Add shared context** — edit or add files in `context/`. These are loaded for ALL agents, path-filtered by affected files. Changes take effect after merge to the base branch.

**Control analyzer schedule** — use `schedule` in analyzer frontmatter:
```yaml
---
schedule: weekly:2    # Run on Tuesday (1=Mon, 7=Sun)
---
```
Schedule options: `daily` (every research run), `weekly` (on retrospective day), `weekly:N` (specific day), `on-demand` (manual only).

**Disable specific analysis** — set `enabled: false` in analyzer frontmatter:
```yaml
---
enabled: false
---
```

**Change the verify command** — update `scripts.verify` in `project.yaml`. This runs after every agent execution to validate changes.

**Enable / disable pipeline stages** — pipeline features and active-item limits are managed in the operator instance configuration, not in `project.yaml`.

## Finished Work Items

Finished work items stay in their flat kind directory; their `status:` field records the outcome:

- `completed` — non-PR stage finished successfully
- `merged` — the item's PR was merged (terminal success for finding/task)
- `failed` — execution failed after all retries exhausted
- `rejected` — PR closed without merging (with rejection analysis)
- `duplicate` — superseded by another item

Failed and rejected items carry extra frontmatter (`failed_at` / `rejected_at`) and rejection analysis when applicable.

## Troubleshooting

### Task execution failed (`ai:failed`)
1. Check the PR comments for the failure analysis.
2. Add comments with specific feedback.
3. Remove the `ai:failed` label → PR review will process the comments and retry.

### Task not being selected
- At capacity (the operator instance caps active tasks)
- Branch already exists (a previous attempt is still open)
- The task was previously rejected (PR closed without merge)
- Domain conflict with an in-progress task (same files/folders)

### No new tasks created
- The findings backlog is empty — a research PR must be **merged** before its findings enter the queue.
- All analyzer findings already exist (deduped by the `source:` field).
- The planner creates tasks only from validated findings.

### Duplicate findings
- Dedup is based on the `source:` field in finding frontmatter (e.g. `backend-consistency#FINDING-001`).
- Existing findings in `.operator/data/findings/` are scanned automatically by their `status:`.
