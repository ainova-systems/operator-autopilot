# Operator Workflow

**Target behavior document.** Defines the user-facing flow and the internal generic stage model that produces it. MVP hardcodes the stage list in TypeScript; the same engine is expected to later run from a config file without code changes. Pair with `vision.md` (product direction) and `architecture-v5.md` (target engine).

The core claim of this document: **there is one generic stage loop, every feature is an instance of it, and what makes research different from task execution is configuration, not code.**

---

## 1. What the user sees

1. User edits `config/repos.yaml`, adds a repo entry with `enabled: true`. That is the only prerequisite.
2. Next Operator cycle opens an **init PR** on branch `ai/init`. The PR contains a proposed `.operator/` scaffolding, 3-5 analyzer definitions tailored to the stack, and 1-3 seed findings scout noticed during setup.
3. User reviews the init PR, optionally deletes specific files (findings they disagree with, analyzers they don't want), then merges. Merging the init PR is the onboarding moment — one decision, one PR.
4. If user closes the init PR without merging, the next cycle **retries init with a different approach**. Scout reads `previous_prs` metadata and varies the proposal. This continues until the user merges, or sets `enabled: false` in `config/repos.yaml`.
5. After the init PR is merged, normal operation begins. The Operator:
   - Picks up the seed findings as pending work and opens **finding PRs** with task plans (one PR per finding).
   - Runs daily research at the configured UTC hour, producing more findings over time.
   - Produces **task PRs** with code changes once the user accepts a finding's plan.
   - Reviews and amends PRs when the user leaves comments.
   - Runs a weekly retrospective that produces findings about the Operator's own performance (prompt tweaks, analyzer changes).
6. Every human interaction is through a GitHub PR, PR comment, or Issue. There is no separate UI required to use the Operator — but a console/web UI can be attached on top of the same storage to observe and control it.

```
config/repos.yaml: enabled: true
            │
            ▼
        init PR ─── closed ──► scout retries with new approach ─── loops ──►
            │  (or enabled:false stops everything)
           merged
            │
            ▼
  seed findings pending
            │
            ▼
  finding PR ───► merged ───► task PRs ───► merged ───► Operator observes & learns
            │                      ▲
         comments ──► Operator amends
```

---

## 2. The unit of work: WorkItem

A **WorkItem** is the single entity the engine operates on. Findings, tasks, requests, retrospectives, and anything else that needs a queue and a state machine are all WorkItems. They differ only by `kind`.

| Field | Description |
|---|---|
| `id` | `{prefix}{YYYYMMDD}-{NNNN}` — prefix comes from the kind config |
| `kind` | Open string. Default kinds: `finding`, `task`, `request`. User may add more |
| `parentId` | Optional link to parent item. A task's parent is usually a finding. Chains can be deeper |
| `status` | `pending`, `in-progress`, `in-review`, `completed`, `failed`, `rejected`, `duplicate`, `cancelled`, `reopened` |
| `priority` | 1-8 |
| `title`, `body` | Content |
| `branch`, `prNumber` | Git/VCS coordinates of the work item's PR. Always set once persistOutput has run. |
| `source` | Origin: analyzer name, user, parent finding, etc. |
| `createdAt`, `updatedAt` | Timestamps |

The `kind` field determines which prompts, templates, branch prefix, ID prefix, and downstream stages apply. Adding a new kind is a config change, not a code change.

---

## 3. The unit of execution: Stage

A **stage** is one invocation of an LLM agent that produces files in the managed repo's workspace. Every stage outputs through a PR. Every PR has merge conditions (§6). That is the entire model.

There is **one** stage shape. There are no stage types. There is no "stage that runs without an agent" or "stage that does not produce files." If you find yourself wanting one of those, you are looking at one of:

- **A cron task** — pure orchestration code that runs on a schedule and never invokes an LLM. Branch pruning, stale-item archival, sending notifications, importing external work items (Jira polling, CI failure ingestion). Lives in `engine/src/cron/*.ts` and is wired directly into `Engine.runOnce`. **Not a stage.** The word "stage" is reserved for "LLM run → files → PR."
- **A code stage as a separate concept** — does not exist. Either an LLM is involved (it is a stage) or it is not (it is a cron task or it does not exist).

Stages live in `stages.yaml` and are seeded into KV. The list is user-editable. The default chain shipped with the engine is `init → research → finding-plan → task-execute → pr-review → retrospective`, but the user may add, remove, or reorder stages. Adding a stage = one row in `stages.yaml` + one prompt file under `engine/content/prompts/agents/`. No new TypeScript file.

**Do not confuse a stage with `WorkItem.kind`.** They are different things:

- A **stage** is a unit of execution — "run the planner agent against pending findings."
- `WorkItem.kind` is a category of work item (`finding`, `task`, `request`, ...) — open string, defined per project.

A `finding-plan` stage produces work items of kind `task`. A user can define stages that produce work items of any kind they invent.

---

## 4. The `run` stage: eight steps

Every `run` stage — whether it is producing a finding from an analyzer, a task from a finding, a code PR from a task, or a retrospective from outcomes — goes through the same eight steps in the same order. Differences between stages come from configuration and from which adapter is injected at composition time.

```
┌─ 1. acquireLock
│      Idempotency gate: one runner per (repo, stage, scope key).
│      Scope key is per-item for item-scoped stages, per-period for singletons
│      (e.g. 2026W16 for weekly retrospective, 2026-04-13 for daily research).
│
├─ 2. selectInput
│      Pick what to process this run. Four strategies, one step:
│      • per-item:    oldest pending WorkItem of the stage's inputKind
│      • singleton:   fixed scope key derived from cron (current fire window) or "bootstrap"
│      • discovery:   iterate analyzer definition files under the stage's directory
│      • pr-feedback: pick one open AI PR with fresh human comments
│      maxActive cap enforced here — never more than N items in flight per stage.
│
├─ 3. initWorkspace
│      Ensure a clean workspace on the correct branch.
│      If a remote branch for the scope key already exists, check it out
│      (fast-forward safe); otherwise create from base. Never force-push.
│      Never overwrite divergent history. Always reset to base on exit.
│
├─ 4. buildContext
│      Assemble everything the agent needs to see:
│        • the WorkItem body and metadata
│        • per-item execution history (previous attempts, reviewer verdicts,
│          human comments from prior PRs, summaries from prior runs)
│        • related items (siblings under same parent, similar completed items)
│        • state vars (KNOWN_ISSUES, PENDING_TASKS, RECENTLY_FIXED, HISTORICAL_PATTERNS)
│        • repo conventions + stage-scoped rules
│      This step feeds BOTH the action agent AND the reviewer agent within the
│      same execution — they see the same context.
│
├─ 5. buildPrompt
│      Compose the layered system + user prompts. Stage name is the routing key:
│      prompts are resolved through PromptSource topic lookups based on the
│      stage's agent role (§9). No file in the engine contains prompt text.
│
├─ 6. invokeAgent
│      Spawn the configured CLI provider. Inside this single step:
│        a. run the agent
│        b. run verify command if configured (build, tests)
│        c. run reviewer agent with the diff + context + criteria
│        d. parse the reviewer verdict
│        e. if verdict = retry → loop (same process, same workspace) with
│           feedback in user prompt. Up to maxRetries attempts.
│        f. if verdict is terminal → break out of the loop and surface the result.
│      The reviewer also writes a compact `## Execution Summary` section alongside
│      the verdict; that summary is stored as the item's execution history entry
│      for the next run to see (step 4 above).
│      The 5-verdict vocabulary is in §8.
│
├─ 7. persistOutput
│      Always FileOutputAdapter — every stage commits to git.
│        a) git add -A
│        b) git commit with the stage-supplied message format
│        c) git push (fast-forward only, never force)
│        d) upsert PR via VCS (create if missing, update body if present)
│        e) apply label transitions for the new state
│        f) IF the stage's merge conditions are satisfied (§6),
│           request native VCS auto-merge so the PR lands when CI passes
│      One code path for every stage. Merge conditions decide whether
│      the PR sits open or auto-closes itself in seconds.
│
└─ 8. routeVerdict
       Translate the verdict into persistent state changes and visibility:
        • update the WorkItem status in the KV store
        • apply the matching PR label transition (`ai:processing`, `ai:failed`, etc.)
        • fire notification events: always on terminal failure, optionally on
          success, depending on per-stage and per-channel config.
```

Every step is **idempotent** and **resumable**. A crash between any two steps leaves state the next cycle can continue from. Per-step events are journaled to the execution log before irreversible actions, so the UI/timeline can render what happened and recovery can reconcile on restart.

---

## 5. Stage configuration

Everything a stage needs to vary is config. In MVP the list is seeded from `agents/workflow/stages.yaml` into the KV store; the engine only reads from KV. Post-MVP users can edit through the UI and changes live only in the KV store — no engine change.

| Config field | Meaning |
|---|---|
| `name` | Unique stage identifier. Routes prompts, events, lock keys |
| `agent` | Agent role (references `config/agents.yaml` — e.g. `analyst`, `planner`, `creator`, `improver`, `scout`) |
| `inputKind` | WorkItem kind to process. When set, stage is item-scoped |
| `inputSource` | Alternative to `inputKind` for discovery stages: path to directory of analyzer definition files |
| `outputKind` | Kind to produce from agent output. When unset, stage produces code or in-place updates |
| `merge` | `gated` \| `auto` \| object with explicit conditions (§6) |
| `branchScope` | `per-item` \| `singleton:{period}` \| `none` |
| `branchPrefix` | Path prefix for branches (e.g. `ai/findings`, `ai/tasks`, `ai/init`) |
| `prTemplate` | Template name from `templates/` for the PR body (file-mode only) |
| `maxActive` | Max concurrent items (item-scoped stages only). Default 2 |
| `schedule` | Cron expression or special keyword (`on-demand`, `on-new-item`) |
| `review` | Enable reviewer agent in step 6 (default: true) |
| `enabled` | Default true |

Examples of what this looks like for MVP stages are in §10.

---

## 6. Merge conditions

Every stage produces a PR. There is no "no PR" mode — that would split the engine into two storage models. Instead, stages differ in their **merge conditions**: how many gates must clear before the bot merges the PR.

| Field | Meaning |
|---|---|
| `merge.requireHuman` | If true, the PR sits open until a human merges. Default true for code-touching stages. |
| `merge.requireCIGreen` | If true, the bot will not auto-merge until all CI checks are green. Implied true when `requireHuman: false`. |
| `merge.requireReviewerApproval` | If true, the bot will not auto-merge until the reviewer agent emitted `approved`. Implied true when `requireHuman: false`. |
| `merge.maxDiffLines` | Optional. If set and exceeded, downgrade to `requireHuman: true` regardless of other conditions. |
| `merge.allowedPaths` | Optional. If set and the diff touches files outside the list, downgrade to `requireHuman: true`. |

Two common combinations have shorthand names:

- **`merge: gated`** — alias for `{ requireHuman: true }`. The default. PR opens, waits for a human to merge. Used for anything humans want to look at.
- **`merge: auto`** — alias for `{ requireHuman: false, requireCIGreen: true, requireReviewerApproval: true }`. PR opens, the bot requests native VCS auto-merge so the PR lands within seconds when CI goes green and the reviewer agent approved. Used for things humans do not want to merge by hand but still want to be able to inspect later in git history.

### 6.1 What `auto` means in practice

An auto-merge stage runs every step of the loop identically to a gated stage:

```
1-6. acquireLock → selectInput → initWorkspace → buildContext → buildPrompt → invokeAgent
   (zero difference from gated stages)

7. persistOutput
   FileOutputAdapter:
     a) git add -A, git commit, git push (fast-forward only, never force)
     b) prManager.upsertPR(branch, title, body)
     c) prManager.applyLabels([ai:processing])
     d) IF merge conditions for this stage are satisfied right now →
        prManager.enableAutoMerge(prNumber)   // GitHub native auto-merge

8. routeVerdict
   → kv.put("work-items/{id}", { status: "in-review" if gated, "auto-merging" if auto })
   → kv.put("executions/{id}", ExecutionEntry)
```

In auto mode the human still **sees** the PR if they want to. It just disappears from their queue within seconds because the platform's native auto-merge fires when CI passes. The artifact exists in git history. The audit trail is intact.

### 6.2 Trust progression

MVP defaults every stage to `merge: gated` because it is the safest onboarding. Operator users progressively relax gates per-stage through stage config as they build trust:

```
Week 1:  all stages merge: gated
Week 4:  retrospective → merge: auto
         analyzer-audit → merge: auto
Week 12: research → merge: auto       (findings still in git, no manual merge)
         finding-plan → merge: auto    (if rejection rate stayed under 5%)
         task-execute → merge: gated  (code always gated — invariant, §15)
```

This is not a roadmap — it is what the configuration allows. The user chooses when each stage earns more autonomy.

### 6.3 Why no virtual mode

Earlier drafts had a third mode that wrote only to the KV store with no git artifact. It was removed because it created three problems at once:

1. **Two storage models.** Some stage outputs in git, some in KV. Sync drift between the two becomes a lifecycle bug class.
2. **Agent contract pollution.** Agents are file editors. A virtual stage means inventing a different output channel for the same agent — KV writes through an injected helper, or stdout JSON parsing. Both options are messier than "agent writes a file like always, the bot maybe merges it instantly."
3. **Lost audit trail.** Git history is the most natural log of the bot's work. Removing some stages from git history makes "what did the operator do last week" a database query instead of `git log`.

If a stage is "trivial enough to skip review," that is `merge: auto`, not "skip git." If a job is "pure orchestration without an LLM," that is a **cron task** in `engine/src/cron/`, not a stage. The word "stage" is reserved for "LLM run → files → PR."

---

## 7. Verdicts

Every `run` stage that uses an agent emits exactly one of five verdicts from the reviewer agent inside step 6. No stage invents its own.

| Verdict | Emitted when | Handling |
|---|---|---|
| `approved` | Work is correct, diff matches intent | Break retry loop → persistOutput runs. PR opens. If `merge: gated`, item → `in-review`, human reviews. If `merge: auto`, the bot enables native auto-merge so the PR lands when CI passes. |
| `retry` | LLM-level mistake, recoverable within the same execution | Stay in invokeAgent retry loop. Feedback is inlined into the next attempt's user prompt. Up to `maxRetries` attempts per execution. **Never surfaces to the pipeline** — pure in-process loop. |
| `failed` | Unrecoverable within attempt budget | Break retry loop, surface terminal-failed. PR stays open with `ai:failed` label for human inspection. Notification fires if any channel is configured. |
| `cancelled` | The work should not have run at all (out of scope, bad precondition) | Break retry loop, surface terminal-cancelled. Close PR, add `ai:cancelled` label. Notification fires. |
| `rejected` | The work item itself is wrong (scope mismatch, bad framing) | Break retry loop, surface terminal-rejected. Close PR, add `ai:rejected` label. Parent finding may be flagged for re-planning by the rejection cascade (§13). Notification fires. |

Reviewer prompts live under `agents/reviewer/{stageName}.md` — one file per stage. They contain the criteria for what "approved" means in that stage. Stage code never hardcodes thresholds.

---

## 8. Execution history and context

Step 4 (`buildContext`) must assemble **per-item execution history** before step 5 builds the prompt. History is queried from the KV store under category `execution-events/{workItemId}/*` and contains:

| History element | Source |
|---|---|
| WorkItem body + current metadata | `work-items/{id}` |
| All prior runs of any stage on this item | `executions/*` filtered by `workItemId` |
| Reviewer verdict + execution summary per run | `execution-events/{executionId}/{seq}` |
| Human comments on the resulting PR (file mode) | pulled from VCS at cycle start, cached in KV |
| Rejection history for the parent chain | `execution-events/*` for parent items |
| Related items (siblings, similar completed) | KV query over `work-items/*` |

Both the **action agent** and the **reviewer agent** see this context in the same form. The reviewer sees what the action agent saw, plus the action agent's diff. That is how the reviewer can evaluate "does this diff actually address the previous human feedback."

### 8.1 Summaries are written by the reviewer

To keep context budgets bounded, each `run` stage ends with the reviewer writing a compact `## Execution Summary` block alongside its `## Verdict` block. Format:

```
## Verdict: RETRY
## Feedback
The agent missed the constraint about Y. Retry with an explicit mention.

## Execution Summary
Attempt 2/3 — added null check in user.ts but still fails test
auth.spec.ts:42. Root cause: session token validation bypass. Next
attempt should focus on token refresh path, not null handling.
```

`parseReviewVerdict` extracts both blocks. The summary is stored in `execution-events/{executionId}/{seq}` with the verdict. Next time this item is processed by any stage, the summary shows up in `buildContext` so the next agent starts from where the last one left off. This is the most important mechanism for avoiding "repeats the same mistake on every retry across cycles."

No extra LLM call is used to generate summaries. The reviewer already has all context — it writes the summary as part of its existing job.

---

## 9. Dynamic prompts — how stage name drives everything

The engine never hardcodes a prompt. The stage name and the agent role resolve a layered prompt chain at runtime through the `PromptSource` interface (see `architecture-v5.md`).

```
Layer                                  Source                                        Purpose
────────────────────────────────────── ───────────────────────────────────────────── ────────────────────────
1  Global context                      .claude/rules/ or equivalent                  Project conventions
                                         (auto-picked up by CLI agent)
2  Bundled base                        prompts/context/base                          Operator-wide baseline
                                         (KV entry, seeded from agents/context/base.md)
3  Project context                     .operator/context/*.md                        Per-repo context
4  Role rules                          .operator/{role}/*.md                         Per-repo role rules
5  Agent instructions                  prompts/{role}                                Shipped base instructions
                                         (KV entry, seeded from agents/{role}.md)
                                      + .operator/agents/{role}.md (append)          Per-repo override
6  Reviewer criteria (if review=true)  prompts/reviewer/{stageName}                  Stage-specific review rules
                                         (KV entry, seeded from agents/reviewer/{stage}.md)
                                      + .operator/agents/reviewer/{stage}.md         Per-repo reviewer tweaks
7  State + history variables           DB-rendered into templates                    Known issues, pending tasks,
                                                                                        per-item execution history
```

Adding per-stage guidance is editing or creating a markdown under the matching name. In MVP this is a file in the repo that seeds a KV entry. Post-MVP a user can edit through the UI and the change lives only in the KV store — no repo change needed, but a version-mismatch warning surfaces on the next Operator version update (see §11.3).

---

## 10. MVP stage list — all as instances of the same loop

These are the stages the MVP engine ships. All instances of one stage shape with different config. Cleanup is **not** a stage — it is a cron task in `engine/src/cron/cleanup.ts` called at the end of each `Engine.runOnce` cycle.

| Stage name | agent | inputKind | selector | outputKind | merge | branchScope | maxActive | schedule | review |
|---|---|---|---|---|---|---|---|---|---|
| `init` | scout | — | shipped bootstrap analyzer | finding | gated | `singleton` | 1 | on-start | false |
| `research` | analyst | — | discovery (`.operator/stages/research/*.md`) | finding | gated | `singleton` | 1 | `0 8 * * *` | false |
| `finding-plan` | planner | finding | per-item | task | gated | `per-item` | 2 | `*/5 * * * *` | true |
| `task-execute` | creator | task | per-item | — (produces code) | gated | `per-item` | 2 | `*/5 * * * *` | true |
| `pr-review` | creator | — | pr-feedback | — (amends code) | gated | `pr` | — | `*/5 * * * *` | true |
| `retrospective` | improver | — | singleton | finding | gated | `singleton` | 1 | `0 9 * * 1` | true |

Observations:

- `init`, `research`, and `retrospective` all produce **findings**. They are not separate stage types — they are the same loop with different `agent` and `schedule`. The old v4 `improver` concept evaporates into `retrospective`.
- **MVP defaults every stage to `merge: gated`.** Auto-merge is configurable per-stage but no MVP stage ships with it on. Users opt in per-stage as they build trust (§6.2).
- `finding-plan` and `task-execute` use `per-item` branch scope with `maxActive=2`. The cap is the only concurrency knob.
- `pr-review` has scope `pr` (one PR per run). `selector: pr-feedback` returns the next AI PR with fresh human comments.
- `init`'s selector is a shipped bootstrap analyzer that lives in `engine/content/prompts/`, not in the managed repo (which does not exist yet). It proposes the contents of `.operator/` plus seed findings in one init PR. The stage has `enabled: always` until `.operator/project.yaml` exists on the merged base branch.

Adding a new stage in MVP = one row in `engine/content/prompts/stages.yaml` + one prompt file under `engine/content/prompts/agents/`. No new TypeScript file. Every stage is config.

---

## 11. Storage — three layers, one KV interface

The Operator has three distinct content categories. Each has a different source of truth.

### 11.1 Work item content (files are truth)

Findings, tasks, retrospective reports, code changes. These live as `.md` or source files inside the managed repo under `.operator/data/` or the normal project directories. Humans review them through PR diffs. Frontmatter carries full lifecycle (`status`, `priority`, `branch`, `pr`, `parentId`) so the KV work-items cache can be rebuilt by re-scanning the repo.

Rule: if an item lives here, `git clone` is enough to reconstruct it. DB loss is recoverable.

### 11.2 Runtime configuration (KV is truth, seeded from repo)

Prompts, PR templates, agent role config, analyzer definitions, stage list. These live in the KV store. The Operator repo ships baseline files (`agents/*.md`, `templates/*.md`, `config/agents.yaml`, etc.) that are **imported** into the KV store on first launch. Once imported, the KV entries are the runtime source of truth — a user can modify them through the UI and the change persists across Operator version updates.

Reseed policy: **never auto-reseed on version upgrade**. If the shipped files move ahead of what the KV store contains, Operator logs a warning and the UI shows "prompts are N versions behind baseline, reseed available." User explicitly triggers `--reseed {category}` when they want to pull updates. No silent overwrites.

Rule: if you change prompts through the UI, they survive Operator upgrades. If you want shipped updates, you ask for them.

### 11.3 Execution state (KV only, derived)

Schedule timestamps, execution history, outcomes, locks, recovery queue, notification log. No source-of-truth outside the KV store. On DB loss, this content is gone — but it is all derivable from replaying persistent inputs on the next cycle, so the Operator resumes clean.

### 11.4 The KV interface

Every category uses the same interface:

```typescript
interface KVStore {
  get(category: string, key: string): Promise<unknown | null>;
  put(category: string, key: string, value: unknown, opts?: { ttlMs?: number }): Promise<void>;
  delete(category: string, key: string): Promise<void>;
  list(category: string, filter?: {
    keyPrefix?: string;
    where?: Record<string, unknown>;    // JSON field match
    orderBy?: string;
    limit?: number;
  }): Promise<Array<{ key: string; value: unknown }>>;
  atomicAcquire(category: string, key: string, ttlMs: number): Promise<LockHandle | null>;
}
```

Category layout used by the engine:

```
work-items/{id}                          WorkItem state (layer 7.1 cache)
executions/{executionId}                 execution metadata (stage, agent, times, cost)
execution-events/{executionId}/{seq}     per-step events + reviewer summary
execution-logs/{executionId}             attached log blob
schedule/{repoId}/{stageName}            last-run timestamp
known-items/{repoId}/{sourceKey}         dedup records
outcomes/{workItemId}                    post-delivery observations
locks/{lockKey}                          idempotency
notifications/{id}                       sent notification log
recovery/{id}                            interrupted-run queue

prompts/{topic}                          layer 5-6 prompts, seeded from repo
templates/{name}                         PR body templates, seeded from repo
agent-roles/{roleName}                   agent configuration, seeded from config/agents.yaml
analyzers/{stageName}/{analyzerId}       analyzer definitions, seeded from .operator/stages/
workflow-stages/{stageName}              stage configuration (MVP: seeded from engine code)
```

Implementations: `SQLiteKVStore` (default, one table `kv(category, key, json, updated_at, ttl)` with JSON indexes), `CloudKVStore` (symmetric with Cloud Storage API), any future backend. Swap at composition root via `CLOUD_API_KEY` or config.

### 11.5 Why this matters for UI

A console or web UI for Operator does not need to know anything about the domain model. It browses categories, lists entries, renders JSON. Filters on JSON fields give "show me all failed executions today" for free. Attached log blobs come from `execution-logs/*`. The UI is a thin viewer on top of one standard interface — it does not duplicate domain rules.

---

## 12. Sample walkthrough — new project to first merged code

Concrete trace of one project going through the full first cycle. All timestamps are illustrative, not part of the model.

```
Day 1 10:00  User edits config/repos.yaml: adds repo X with enabled: true
Day 1 10:05  Cycle 1 runs. runProject(X) → finds no .operator/project.yaml
             → init stage eligible → `run` with bootstrap analyzer starts.
             acquireLock → selectInput(bootstrap.md) → initWorkspace creates
             ai/init branch from develop → buildContext (no history yet) →
             buildPrompt (scout role + bootstrap template) → invokeAgent →
             scout proposes .operator/ + 4 analyzers + 2 seed findings →
             reviewer approves → persistOutput commits + pushes + creates PR #1
             with body explaining what merge means → routeVerdict sets
             init-stage KV entry to "in-review" + fires notification.
             Cycle 1 ends with one open init PR.

Day 1 11:30  User reads PR #1 body, deletes one seed finding F2 they disagree
             with (drops the file from the PR in GitHub UI), merges.

Day 1 11:35  Cycle 2 runs. syncFilesToState sees 4 analyzers + 1 finding (F1)
             in the merged develop branch, upserts them into work-items/*
             with status=pending. init stage is now skipped (project.yaml
             exists). finding-plan stage triggers — maxActive=2, currently 0
             in-flight, 1 pending finding to pick. run loop:
             acquireLock(finding-plan, F1) → selectInput → initWorkspace
             creates ai/findings/F1 → buildContext pulls F1 body + empty
             history → buildPrompt planner role → invokeAgent → planner
             writes 3 task files into .operator/data/tasks/ → reviewer
             approves → persistOutput commits + pushes + creates PR #2
             (merge=gated) → routeVerdict sets F1 in-review + label
             ai:processing → tasks stored as work-items with status=pending.

Day 1 14:00  User reviews PR #2, likes the 3-task plan, merges.

Day 1 14:05  Cycle 3 runs. finding-plan skips (no pending findings under cap).
             task-execute triggers. maxActive=2, 0 in-flight, 3 pending
             tasks. Picks T1 (highest priority). run loop:
             acquireLock(task-execute, T1) → selectInput → initWorkspace
             ai/tasks/T1 → buildContext includes T1 body + parent F1 summary
             + prior sibling task history (none yet) → buildPrompt creator
             → invokeAgent runs creator, verify runs project build, reviewer
             checks diff against task spec → approved → persistOutput commits
             code + pushes + creates PR #3 → routeVerdict: T1 in-review,
             PR label ai:processing. Same cycle also starts T2 in parallel.

Day 1 14:10  PR #3 fires CI, CI passes.
Day 1 14:15  Cycle 4: finding-plan still nothing. task-execute still has T2
             in-flight (from 14:05), T3 waiting. pr-review runs, no unread
             human comments anywhere, no action.
             .
             .
Day 1 18:30  User reviews PR #3, leaves comment "nit: rename variable foo → bar".
             Does not merge yet.

Day 1 18:35  Cycle 5: pr-review picks up PR #3 because it has an unread human
             comment. run loop: acquireLock(pr-review, PR#3) →
             selectInput (PR#3) → initWorkspace checks out ai/tasks/T1
             (existing branch) → buildContext includes T1 body + prior
             execution summary + the unread comment → buildPrompt creator
             with "respond to this feedback" prompt → invokeAgent amends
             code → reviewer approved → persistOutput commits amendment +
             pushes → routeVerdict: PR comment marker posted "addressed
             feedback", label stays processing.

Day 1 18:45  User re-reads PR #3, merges. Task T1 now committed to develop.

Day 2 08:00  Cycle N: research stage triggers (daily schedule, 08:00 UTC).
             Iterates 4 analyzer files in .operator/stages/research/.
             Each analyzer run adds a few findings in
             ai/research/2026-04-14 branch. persistOutput commits all
             new findings in one PR per day. One new research PR opens.

Day 8 09:00  Cycle M: retrospective stage triggers (weekly, Monday 09:00).
             merge=gated by default. Runs improver prompt over last week's
             outcomes, produces 2 finding files
             .operator/data/findings/F20260421-0001.md and -0002.md:
             "update creator prompt to warn about null handling" and
             "remove dead-code analyzer, too many false positives".
             persistOutput commits them on ai/retrospective/2026W17,
             opens PR #N. User reviews, merges. Next cycle, finding-plan
             picks them up like any other findings; planner produces
             task PRs that propose actual file edits to the prompt /
             analyzer files. User reviews and merges. Prompts and
             analyzers update through the normal pipeline — same eight
             steps every time.
```

Two properties from this walkthrough that are non-obvious:

1. **Retrospective produces real, reviewable proposals** — not an "improver PR" as a dump. Its findings go through the same planner/creator pipeline as security findings. User reviews them with the same mental model.
2. **Every stage ran the same eight steps** — bootstrap, research, finding-plan, task-execute, pr-review, retrospective — all `run` stage instances. The engine never ran a specialized code path.

---

## 13. Human interactions — the four things users can do

Every Operator PR is a decision point. Four actions, each with a well-defined engine response.

### 13.1 Merge the PR (accept)

Signals approval. Next cycle:

1. `syncFilesToState` sees the merged changes, updates the work item status.
2. If the item has child stages (a finding with pending tasks), those become eligible on their normal schedule under the normal cap.
3. `finding → completed` only when **all** child tasks are terminal (completed/cancelled/rejected) — not when the finding PR itself is merged.
4. Post-delivery observation kicks in: `observe` stage (if configured) samples CI / health checks at T+5m, T+1h, T+24h.
5. Outcome is stored in `outcomes/{workItemId}` and enters the weekly retrospective input.

### 13.2 Close the PR without merging (reject)

Triggers the rejection pipeline on the next cycle:

```
/duplicate command in PR comments  → status: duplicate, no further action
/cancel    command in PR comments  → status: cancelled, no further action
unread human comments present      → run diagnoser agent:
                                       classify cause: poor-implementation |
                                       approach-wrong | out-of-scope |
                                       not-reproducible
                                     if redo/rethink and reopens < 2:
                                       status: reopened, attempt++, picked
                                       up next cycle for another try
                                     else:
                                       create ai:manual GitHub Issue with
                                       full history, hand off to human
no human comments                  → auto-retry up to retry limit, then
                                     ai:manual
```

Reopens cap: 2. Past that, the Operator stops autonomously and files an `ai:manual` issue so the human does not have to repeat themselves.

### 13.3 Comment on the PR

Any unread human comment on an open `ai/*` PR triggers the `pr-review` stage next cycle. That stage is just another `run` instance — creator amends the branch, same eight steps, same reviewer verdict, same mode rules.

Attempt cap per PR: `initial_commits + N` (default N=5). On cap, PR gets `ai:failed`, warning comment, stop processing until human intervenes.

### 13.4 Ignore the PR

Nothing happens. The PR sits in `in-review` indefinitely. The Operator never merges its own PRs unless the stage's `merge: auto` conditions are met (CI green + reviewer agent approved), and even then via native VCS auto-merge — the bot itself never issues a merge call directly.

---

## 14. Rejection cascade

A human can reject an **entire finding** before any tasks are implemented. The system must respond by cleaning up downstream work, not leaving zombies:

```
human closes finding PR without merge
        │
        ▼
rejection pipeline (§13.2) runs
        │
        ▼
finding status: rejected
        │
        ├── all pending tasks under this finding: auto-cancelled
        ├── any task PRs that are in-progress: diagnoser decides per-task
        │   whether to stop or reopen based on how close they are
        └── retrospective input: analyzer that produced this finding
             gets a negative signal on next weekly run
```

The retrospective reads rejection counts per analyzer and per finding template and produces findings like "analyzer security-cve is generating 80% false positives, propose removing it." That proposal goes through the normal pipeline and lands as a file change in `.operator/stages/research/`. The analyzer gets removed (or rewritten) through a merged PR — closing the learning loop via normal review.

---

## 15. Invariants — rules that never bend

These properties must hold regardless of which stage is running, which mode it is in, or what an agent returns. Violations are bugs and must be caught by tests, not by documentation:

1. **No force-push.** `persistOutput` is always fast-forward-safe. If the remote branch has diverged, the stage surfaces a clear error — it never tries to rewrite history. This is the exact rule the non-fast-forward incident violated.
2. **One lock per scope.** Two runs of the same stage on the same scope key cannot race. `acquireLock` is the single primitive enforcing this, backed by `IdempotencyGuard`.
3. **Every irreversible action is journaled.** PR creation, label change, commit-push, KV write — the execution log records intent as a `execution-events/` entry before the effect, so recovery on restart can reconcile.
4. **Idempotent by default.** Running a stage twice in a row against the same inputs produces the same state. No double-PRs, no duplicate commits, no label drift.
5. **Bounded retries at both levels.** `maxRetries` inside `invokeAgent` (default 3) and reopens at `rejection-pipeline` level (default 2). Unbounded loops are a bug.
6. **Human commands are authoritative.** `/cancel` or `/duplicate` always wins over any agent verdict. A human merge always marks the item completed, even if the reviewer had emitted `retry`. A human setting `enabled: false` always stops the Operator for that repo.
7. **Prompts are data.** No file in `engine/` contains prompt text. Prompts resolve through `PromptSource` / KV.
8. **Stages never call primitives they do not own.** No `WorkspaceGit`, `PRManager`, `VCSPlatform`, or `runAgent` direct calls from within a `run` stage implementation. Everything goes through the eight-step loop primitives. Enforced by ESLint `no-restricted-imports`, not doc prose.
9. **`task-execute` is always `merge: gated` in MVP.** Code changes always go through human review in MVP. Post-MVP users may opt into `merge: auto` per-repo, but stages whose output is executable code should never auto-merge by default.
10. **Work item content is rebuildable from git.** DB loss never loses work item content. Only execution state (history, schedule, locks) is unrecoverable, and only in the sense that the Operator restarts from zero history.
11. **Every artifact lives in git.** No virtual stages, no KV-only work items. If the engine produced it, it is in git history. The KV store is a derived index for selectors and UI — wipe it and rebuild from git, no loss.
12. **No dead code in the repository.** Every file and every exported symbol under `engine/`, `packages/*/src/`, and `app/src/` must be reachable from the composition root (`engine/entry.ts`) or from a test. Unused code blocks migration because "implemented but not connected" is indistinguishable from "broken." Enforced by `ts-prune` or equivalent in CI.

---

## 16. What MVP hardcodes, what comes later

**MVP (this rebuild):**

- Stage list is seeded from `agents/workflow/stages.yaml` into `workflow-stages/*` KV entries on first launch.
- Kind list is a TypeScript constant seeded into `work-item-kinds/*` KV entries.
- Storage is a single `SQLiteKVStore` implementation.
- Two CLI agent providers (Claude Code for analysis/review roles; Cursor Agent / Composer for the code-writing roles), both behind the one universal CLI wrapper.
- One VCS platform (GitHub via Octokit).
- Notifications optional, only GitHub PR comments are always-on.
- No web UI — console UI planned as a separate target that reads the KV store directly.

**Out of MVP, same engine:**

- Stage list and kind list move to `config/workflow.yaml` or `.md` per-stage files in `.operator/stages/`. Engine reads from KV unchanged; only the seed source changes.
- Alternative KV backends (`CloudKVStore`, `PostgresKVStore`) implemented, swapped at composition root.
- Alternative agent providers (OpenCode, Kiro, etc.) added to `config/agents.yaml`.
- Alternative VCS platforms (GitLab, Bitbucket) satisfying the same interface.
- Web UI reading the same KV through a Control Plane HTTP API.
- Slack / Telegram notification channels as shipped npm extensions.
- Vector search via Cloud Memory for the learning loop (rule-based risk stays as default).

The rule: **hardcoding where data lives is allowed in MVP. Hardcoding how data is processed is not.** The engine must already be able to execute the full list from a KV-backed config source — the MVP seed is just a convenience so users do not need to author yaml before first run.

---

## 17. One-sentence summary

**The Operator runs one eight-step loop against a configurable list of stages; every finding, task, research pass, pr-review cycle, and retrospective is an instance of that loop; every stage produces a PR with merge conditions (`gated` for human review or `auto` for bot merge when CI passes); there is no virtual or KV-only stage — git is the single source of truth for every artifact the Operator produces; humans interact through normal GitHub PRs; no part of the loop is reimplemented per stage.**
