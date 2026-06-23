# AI Operator

Automated AI engineering system. The **operator core is domain-agnostic** — it only orchestrates the pipeline (scheduling, branching, PR lifecycle, retries, labels). All domain-specific knowledge (coding standards, review criteria, architecture rules) lives in this `.operator/` directory as phase-specific rules.

## How It Works

The operator runs on a schedule (every 5 minutes) and performs these actions:

1. **Branch cleanup** - deletes `ai/*` branches where PRs are merged or closed
2. **PR review** - responds to comments on open `ai/*` PRs, applies requested changes
3. **Finding selection** - picks highest-priority finding from `pending/`, creates draft PR with deep analysis
4. **Finding execution** - runs planner agent on pending finding PRs (validates findings, generates tasks)
5. **Task selection** - picks highest-priority task from `todo/`, creates draft PR with `ai:pending` label
6. **Task execution** - runs creator agent on pending task PRs (up to 3 retries)
7. **Daily research** (once per day at 08:00 UTC):
   - Runs analyzers to scan codebase
   - Processes rejected PRs (reopens or rejects tasks/findings)
   - Each analyzer outputs 0-1 finding directly (deduped against existing findings)
8. **Weekly optimization** (Monday) - reviews task stats, patterns, suggests improvements

All changes go through PRs. Nothing is merged without human approval.

## Quick Start

### 1. Project Config

`project.yaml` - project preferences:

```yaml
name: YourProject
repository: org/repo
language: English
context: CLAUDE.md

scripts:
  init: npm ci
  verify: npm run lint && npm run build

features:
  analysts: true
  improver: true
```

- `context` - global context file loaded for all agents (auto-detected if omitted: `AGENTS.md` → `CLAUDE.md` → `.cursorrules` → `OPERATOR.md`)
- `scripts.init` - run before agent execution (install deps)
- `scripts.verify` - run after agent changes (build/lint check)
- `features` - toggle research pipeline components

### 2. Phase Rule Folders

The operator core provides generic agent templates. **Domain-specific knowledge lives here** in phase-specific rule folders. During execution, the operator dynamically discovers matching rules based on the `path` frontmatter and injects them into agent prompts.

**Frontmatter fields (same for all folders):**
- `path` (optional): glob pattern for file filtering (default: `*`)
- `schedule` (optional, analysts only): `daily`, `weekly`, `weekly:N` (N=1-7, Mon-Sun), `on-demand`
- `enabled` (optional): `true`/`false` (default: `true`)

**Folder purposes:**
- `context/` - loaded for ALL agents, path-filtered by affected files. General project knowledge.
- `analyst/` - each file = one independent analyzer run during daily research
- `creator/` - rules for task execution (creator agent). Path-matched to task's target files.
- `verifier/` - rules for PR review. Path-matched to changed files in the PR.
- `planner/` - rules for finding verification and task generation. Path-matched to finding's target.
- `improver/` - rules for weekly optimization agent.

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

**How discovery works:**
1. Pipeline worker detects target path (e.g. changed files in PR)
2. Calls `discover_matching_rules("verifier", "Source/Backend/**")`
3. Finds all rules where `path` overlaps with target, skips `enabled: false`
4. Merges matching rule bodies into agent prompt via `--rules-from verifier`
5. If no rules found, falls back to generic agent behavior

### 3. That's It

The operator handles everything else: scheduling, branch management, PR creation, retries, label management, findings tracking.

## Directory Structure

```
.operator/
├── project.yaml                    # Project config
├── context/                        # Context files (loaded for ALL agents)
│   ├── project.md                  # Project overview, always loaded
│   ├── frontend.md                 # path: Source/Frontend/**
│   └── backend.md                  # path: Source/Backend/**
├── analyst/                        # Each file = one analyzer run
│   ├── code-quality.md             # Code quality rules
│   ├── security.md                 # Security audit rules
│   └── consistency.md              # Consistency checks
├── creator/                        # Execution rules (path-filtered)
├── verifier/                       # Review rules (path-filtered)
├── planner/                        # Planning rules (path-filtered)
├── improver/                       # Optimization rules
├── data/
│   ├── tasks/
│   │   ├── todo/                   # Pending tasks (status: pending, in-progress, or reopened)
│   │   └── completed/              # All finished tasks (status: completed, failed, or rejected)
│   │       └── {YYYY}/{YYYY-MM}/   # Organized by date
│   ├── findings/
│   │   ├── pending/                 # New findings (status: pending or reopened)
│   │   └── completed/               # All finished findings (status: completed or rejected)
│   │       └── {YYYY}/{YYYY-MM}/   # Organized by date
│   └── retrospectives/             # Weekly optimization reports
└── README.md
```

## Task Lifecycle

```
todo/ (status: pending)
  ↓  task-select picks task, creates branch ai/tasks/{ID}, draft PR + ai:pending
todo/ (status: in-progress)  - branch existence indicates active work
  ↓  task-execute runs creator agent (3 retries)
  ├── SUCCESS → PR marked ready + ai:in-review → review cycle open
  │           → AI verifies PR clean → ai:ready-to-merge → human merges → completed/
  └── FAILURE → PR stays draft + ai:failed → see Troubleshooting below
```

### PR Labels

- `ai:pending` - task selected, awaiting execution
- `ai:processing` - execution in progress OR PR review in progress
- `ai:in-review` - changes applied, review loop open (CI / human comments re-enter pr-review)
- `ai:ready-to-merge` - AI verified PR without changes; human merge is the remaining step
- `ai:failed` - execution failed after retries

### Rejection Flow

When a user closes a task or finding PR without merging:
1. Next daily research run detects closed PR
2. Diagnoser evaluates and recommends action:
   - **Reopen** (`poor-implementation`, `approach-wrong`): task/finding stays in `todo/`/`pending/` with `status: reopened` for retry (max 2 reopens)
   - **Reject** (`false-positive`, `too-complex`, `scope-wrong`, etc.): moved to `completed/` with `status: rejected`
3. Reopened items are automatically selected for a new attempt
4. After 2 failed reopens, items are force-rejected

## Task File Format

```yaml
---
id: "T20260122-001"
title: "Fix permission check in document handler"
priority: 1
complexity: low
status: pending
created_at: "2026-01-22T08:00:00Z"
sources:
  - "data/findings/pending/F20260122-001.md"
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

Task IDs follow format `T{YYYYMMDD}-{NNN}` (date of creation + sequence number).

Priority: 1 (highest) to 5 (lowest). Task-select picks lowest number first.

## Customization

**Add domain rules** - create `.md` files in phase folders (`creator/`, `verifier/`, `planner/`, `improver/`). Use `path` frontmatter to scope rules to specific file patterns.

**Add shared context** - edit or add files in `context/`. These are loaded for ALL agents, path-filtered by affected files. Changes take effect after merge to develop.

**Control analyzer schedule** - use `schedule` in analyzer frontmatter:
```yaml
---
schedule: weekly:2    # Run on Tuesday (1=Mon, 7=Sun)
---
```
Schedule options: `daily` (every research run), `weekly` (on improver day), `weekly:N` (specific day), `on-demand` (manual only).

**Disable specific analysis** - set `enabled: false` in analyzer frontmatter:
```yaml
---
enabled: false
---
```

**Disable pipeline components** - in `project.yaml`:
```yaml
features:
  analysts: false
  improver: false
```

**Change verify commands** - update `scripts.verify` in `project.yaml`. This runs after every agent execution to validate changes.

## Completed Tasks

`data/tasks/completed/` contains all finished tasks organized in `{YYYY}/{YYYY-MM}/` directories.

**Task statuses:**
- `completed` — successfully implemented and merged
- `failed` — execution failed after all retries exhausted
- `rejected` — PR closed by verifier without merging (with rejection analysis)

Failed and rejected tasks include additional fields (`failed_at`/`rejected_at` timestamps) and rejection analysis when applicable.

## Troubleshooting

### Task execution failed (`ai:failed`)
1. Check PR comments for failure analysis
2. Add comments with specific feedback
3. Remove `ai:failed` label → PR review will process comments and retry

### Task not being selected
- At capacity (check `maxActiveTasks` in operator config, default: 2)
- Branch already exists (previous attempt still open)
- Task was previously rejected (closed PR without merge)
- Domain conflict with in-progress task (same files/folders)

### No new tasks created
- All findings from analyzers already exist in `findings/pending/` or `findings/completed/` (dedup by source key)
- Planner creates tasks only from validated findings (dedup by source)

### Duplicate findings
- Dedup is based on `source:` field in finding frontmatter (e.g., `backend-consistency#FINDING-001`)
- Existing findings in `findings/pending/` and `findings/completed/` are scanned automatically
