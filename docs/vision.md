# Operator Vision

**Product direction document.** Describes what the Operator is for, who uses it, why it exists, and the non-negotiable product-level constraints that shape everything downstream.

Pair with `workflow.md` (user-facing flow + generic stage model) and `architecture-v5.md` (target engine).

---

## 1. What the Operator is

A **closed-loop SDLC engine** that autonomously discovers issues in a codebase, plans fixes, implements them, verifies the result, delivers the change, observes what happens after delivery, and feeds what it learns back into discovery.

It is not an IDE assistant. It is not a single-shot "code from prompt" tool. It is a long-running orchestrator that manages a repository the way a dedicated junior engineer would — with humans as reviewers, not typists.

```
DISCOVER ──► PLAN ──► IMPLEMENT ──► VERIFY ──► DELIVER ──► OBSERVE ──► LEARN
    ▲                                                                    │
    └────────────────────────────────────────────────────────────────────┘
```

Every step in this loop is automated. Humans appear only at review surfaces (PRs, issues, Slack) and decide **what to accept**. The Operator decides **what to attempt**.

---

## 2. The moat

What makes this project worth building, against Cursor / Copilot / Devin / v0 / every other coding AI:

1. **Autonomous discovery.** Most AI tools wait for a human to say "fix X." The Operator runs analyzers on a schedule and finds things nobody asked about. Research is the most differentiating capability.
2. **Post-delivery observation.** Most AI tools stop at "PR opened." The Operator watches what happens after merge: CI results, error rates, custom feedback signals. Broken changes feed back into the risk model.
3. **Learning from outcomes.** Similar past changes inform risk assessment for new changes. Over weeks the Operator gets better at guessing which PRs need human review and which can auto-merge.
4. **Self-development.** The Operator manages its own repository with the same loop. No special "self-modify" APIs. If the loop cannot run on its own source, it is broken.

The moat is the closed loop, not the agent. Agent CLIs will keep improving from external vendors — that is leverage, not threat. The long-term value compounds in the **feedback and memory**, not in prompt engineering.

---

## 3. Who uses it

Two audiences, same interface.

### 3.1 Individual maintainers and small teams (OSS and internal)

- Run Operator against 1–5 repos on a VM, container, or CI runner.
- Zero external services: SQLite, local files, one API key for the agent provider.
- First value in under 30 minutes from `git clone`: find real issues in the first research run, produce draft PRs with finding lists, let the human triage.
- Hands-off target: one maintainer handles 3× the repos they can today.

### 3.2 Organizations with many repos

- Central deployment (Kubernetes or equivalent), optional Cloud backend for distributed locks, rate limiting, and vector-search memory.
- Web UI for observability, PR backlog triage, per-repo configuration.
- Per-tenant prompt and policy overrides via the same `PromptSource` interface — no forked code.
- SLA-level claims on cost control and rate-limit safety.

The same engine serves both. There is one binary, one code path, and one configuration format; scale-up is adding backends behind the existing interfaces.

---

## 4. Why PRs are the primary interface

Most human interactions with the Operator happen through a Pull Request, a PR comment, or an Issue. This is deliberate:

- PRs are auditable. Every change has a diff, a review thread, a merge commit. The audit trail is free.
- PRs are already part of every developer's workflow. There is no new tool to learn.
- PRs are version-controlled. Disputes are resolved by looking at history, not by asking "what did the bot mean here."
- PRs are the narrowest possible API between human and machine. Reducing the surface reduces the failure modes.

**Every stage produces a PR.** There is no "no PR" mode. `workflow.md` defines two merge conditions per stage:

- **`merge: gated`** — the PR opens and waits for a human to click merge. Default for everything humans want to review: research findings, finding plans, task code.
- **`merge: auto`** — the PR opens and the bot enables native auto-merge so the PR lands within seconds when CI passes and the reviewer agent has approved. The artifact still exists in git history; the human just doesn't have to click. Used for low-risk content where the audit trail matters but the review is mechanical.

**There is no third mode.** Earlier drafts had a "virtual" mode that wrote only to the KV store with no git artifact. It was removed: it split the engine into two storage models, broke the agent's "files are my output" contract, and lost the git history that makes "what did the operator do last week" a `git log` instead of a database query. If a stage is trivial enough to skip review, that is `merge: auto`, not "skip git." If a job is pure orchestration without an LLM, that is a **cron task** in `engine/src/cron/`, not a stage.

Failure visibility comes from three channels, all optional:

1. **Local stdout / pino logs** — always on. When Operator runs interactively or in CI, failures print to the terminal with full context.
2. **Console / web UI** — reads the KV store directly and renders the full state, including terminal failures and their execution summaries. Planned as a separate target; the engine works without it.
3. **External notification channels** (Slack, Telegram, Email, webhook) — optional extensions. When configured, terminal failures fire events to them.

The core must always guarantee that a failure is visible somewhere — stdout at minimum, the failed PR with `ai:failed` label always. This is non-negotiable: the 2026-04-13 class of silent failure must not recur.

---

## 5. The four product tenets

### 5.1 Orchestrator, not agent

The Operator never reimplements agent tool execution — no custom Read, Edit, or Bash loop. It composes prompts, spawns an external agent CLI, waits for output, and routes the result. Agent capabilities come from the agent vendor. This is permanent: it is how the Operator stays agent-agnostic and rides the improvement curve of every CLI that follows.

### 5.2 Generic over specific

Every feature of the Operator — finding, task, research, PR review, retrospective — is **one instance of a generic stage pattern.** No feature has its own code path. Adding a new kind of work is adding configuration, not writing a new stage file. The generic model is documented in `workflow.md`.

### 5.3 Local-first, cloud-optional

Zero-dependency mode must always work. `git clone → npm start → working Operator against a repo` with nothing but an agent API key. Cloud services (Cloud, Postgres, distributed locks, vector search) are additive. The day adding cloud becomes mandatory is the day OSS adoption dies.

### 5.4 Three layers of state, three sources of truth

The Operator keeps state in three distinct categories, and each has a different source of truth:

| Layer | Source of truth | Recovery path |
|---|---|---|
| **Work item content** — findings, tasks, retrospective reports, code changes | git (files in the managed repo) | `git clone` rebuilds the KV cache |
| **Runtime configuration** — prompts, PR templates, agent role config, analyzer definitions, stage list | KV store, seeded from repo files on first launch | `--reseed {category}` pulls shipped defaults back from the repo, explicit only |
| **Execution state** — history, outcomes, schedule timestamps, locks, recovery queue | KV store only | not recoverable, but all downstream stages restart clean from persistent inputs |

The repo is still the source of truth for **work that a human needs to review**. User-facing content lives in files and flows through PRs. But runtime configuration (prompts the user has tuned through the UI, custom templates, analyzer definitions) lives in the KV store, so user changes persist across Operator version upgrades without being silently overwritten. Execution state is pure derived cache — losing it is always recoverable by re-running.

This replaces the simpler "files are truth, DB is cache" framing from earlier drafts. The simpler rule was wrong: it conflated work-item content (where files are truth) with runtime config (where DB is truth). The three-layer model is load-bearing for the DB-first UI vision — users editing prompts in the UI should not have their edits disappear every time the Operator ships a new shipped baseline.

---

## 6. The SDLC loop in detail

### 6.1 DISCOVER

Analyzers run on a schedule. Each analyzer is a markdown file under `.operator/stages/research/` describing what to look for. The analyst agent reads the analyzer definition, scans the repo, and writes finding markdown files. Findings land in a research PR that humans can review before any implementation happens.

### 6.2 PLAN

The planner agent reads each accepted finding and writes one or more task markdown files — a task is a concrete, bounded piece of work. The task list appears as its own PR (or as part of the finding PR in simpler modes) so humans can reject a bad plan before any code is written.

### 6.3 IMPLEMENT

The creator agent picks up an accepted task, creates a branch, edits files, runs builds and tests locally, commits, pushes, opens a code-change PR. This is the step every other AI tool starts and stops at.

### 6.4 VERIFY

Before the PR is marked ready, pre-delivery checks run: build, tests, optional reviewer agent pass. Failures are either fixed in the same attempt or surface as `ai:failed` for human inspection.

### 6.5 DELIVER

Delivery strategy decides whether the PR is auto-merged, auto-requested for human review, or held for explicit approval. Strategy depends on change risk: path patterns, similarity to past broken changes, size, affected systems. Low-risk changes (docs, comments, test fixtures) can auto-merge. High-risk changes (migrations, infra, security-sensitive code) always wait for a human.

### 6.6 OBSERVE

After merge, the Operator watches the change. CI runs, error tracking, custom health checks: all run at configured intervals (T+5min, T+1h, T+24h). The results form an **outcome record** attached to the change.

### 6.7 LEARN

The weekly improver reviews outcomes, merged and rejected PRs, human comments, and produces a retrospective. The retrospective drives prompt updates, analyzer refinements, and risk-model adjustments. Over time the Operator's autonomous decisions become less reliant on hardcoded rules and more on learned patterns.

---

## 7. Scope boundaries

The Operator **is**:

- A repository-scoped SDLC automation engine.
- A scheduler and orchestrator for external agent CLIs.
- A state machine over WorkItems.
- A GitHub-native (initially) PR/Issue client with pluggable VCS.
- A local, single-binary daemon that optionally upgrades to a distributed deployment.

The Operator **is not**:

- A code-intelligence product. Agent CLIs do the reading and editing.
- A CI/CD replacement. It triggers CI via normal git operations and observes results.
- A project management tool. It writes issues when asked; it does not replace Jira or Linear.
- A chat interface. Slack/Telegram channels are notification surfaces with narrow command vocabulary, not conversational UIs.
- A multi-repo dashboard unless the optional Control Plane UI is deployed. The core is per-repo.

These boundaries are load-bearing. Every feature proposal gets checked against them.

---

## 8. The three-tier extensibility model

```
CORE               Shipped in the repo. Minimal set that makes a working loop.
                   No per-vendor assumptions beyond "GitHub is the default VCS."

INTEGRATED         npm packages: @operator/platform-gitlab, @operator/feedback-sentry,
EXTENSIONS         @operator/channel-slack, @operator/tracker-jira. Satisfy the same
                   interfaces as core. Swap at composition root.

PROJECT            Files under .operator/ in each managed repo. Hot-discovered every
EXTENSIONS         cycle. Zero restart needed. Adding a rule is a commit to the
                   managed repo, not a redeploy of the Operator.
```

The rule: **anything that might need per-repo or per-tenant override is an extension point, not a core switch.** Feature flags and per-repo conditionals in core code are the failure mode we are explicitly avoiding.

---

## 9. Non-goals for MVP

Explicit list of things the first working rebuild does **not** need to have. Tracked here so priorities don't drift.

- Multi-tenant hosted web UI. A local console/web UI that reads the KV store directly is a parallel target that can ship after MVP; the engine must not depend on it.
- Vector-search memory. `OutcomeMemory` interface stays in place with a no-op implementation; rule-based risk is enough for MVP.
- Distributed locks. `SQLiteKVStore` atomic acquire is enough for single-node. `CloudKVStore` plug-in covers distributed locking when configured.
- Postgres backend. SQLite is enough; `PostgresKVStore` lands later as a third implementation of the same interface.
- External notification channels (Slack, Telegram, Email, webhook) as **shipped** extensions. The engine includes the channel interface, the notification router, GitHub PR comments as the always-on channel, and local stdout as the fallback. Shipped Slack / Telegram packages come post-MVP.
- Multiple agent providers. One CLI (Claude Code) is enough for MVP; the `AgentProvider` interface and the universal CLI wrapper keep a second provider a pure config entry — already exercised, since the code-writing roles now run on Cursor (Composer) while analysis/review stays on Claude. A broad provider matrix is still deferred.
- GitLab / Bitbucket / Jira. GitHub is enough; the `VCSPlatform` interface stays for future plug-ins.
- `merge: auto` as a **default** for any shipped stage. The engine supports auto-merge from day one (users can opt in per-stage), but MVP ships every stage with `merge: gated` for safest onboarding.
- Post-merge observation beyond CI status. Sentry / Datadog / custom health checks ride on top of the `FeedbackSource` interface later.

Each of these has a clean interface already described in `architecture-v5.md`. MVP ships the local or no-op implementation behind each interface and leaves the interface in place.

---

## 10. Product-level invariants (never break these)

1. **Zero external services to run the MVP.** Agent API key + SQLite + local filesystem is enough. Adding cloud services is optional upgrade, never prerequisite.
2. **First value in under 30 minutes.** From `git clone` to a merged init PR with real proposals against a real repo.
3. **One line to disable autonomous behavior per repo.** `enabled: false` in `config/repos.yaml` always stops the Operator for that repo, even mid-init, even when `.operator/` does not yet exist.
4. **Work item content is rebuildable from git.** Findings, tasks, code — losing the KV store is always recoverable by re-scanning the repo. User-edited runtime configuration (prompts, templates) persists in the KV store and is never silently overwritten by an Operator upgrade.
5. **Every agent invocation has a bounded budget.** Time, token count, retry count. No unbounded loops. Reopens capped per work item. Review attempts capped per PR.
6. **Every PR has a human off-switch.** A `/cancel` comment or closing the PR always wins over any agent decision. A human merge always marks the item completed even if the reviewer had emitted `retry`.
7. **Every artifact lives in git.** No virtual stages, no KV-only work items. The KV store is a derived index for selectors and UI — wipe it and rebuild from git, nothing is lost.
8. **No proprietary lock-in.** The Operator must run on a plain VM or plain Docker or plain Kubernetes. Proprietary sandboxes are an optional quick-start profile, never a hard requirement.
9. **No force-push, ever.** Every commit-and-push sequence is fast-forward-safe. Non-negotiable after the 2026-04-13 non-fast-forward incident.

---

## 11. Success metrics

For MVP, the Operator is successful if, on the Operator's own repo:

- A daily research run produces at least one genuinely useful finding per week on average.
- Task execution completes with passing CI on more than half of attempts without human intervention.
- Human reviewers accept more than half of the task PRs without requiring revisions.
- No stage run leaves the workspace in a broken state that requires manual git cleanup.
- No runaway cost: daily budget stays within a configured ceiling.

For production, additional metrics:

- Mean human time per accepted task PR (target: minutes, not hours).
- Percentage of post-merge outcomes observed as healthy (target: ≥90%).
- Weekly retrospective drives at least one prompt or analyzer improvement that demonstrably reduces rejection rate in the following week.

None of these are in the MVP scope as enforced gates; they are directional goals to point architecture decisions at.

---

## 12. What we intentionally refuse

Three product directions that are explicitly refused in this rebuild, because they create paths back to the failure mode that produced the v4 mess:

1. **"Let's just add a case for X."** No. Every new kind of work is a new `Stage` config entry plus a prompt file. If the request is "add another switch case," the answer is either "reshape it into a stage" or "no."
2. **"Let's special-case this for the big client."** No per-tenant code branches. Extension points are prompt layers and configuration. If something cannot be expressed as an extension, we redesign the extension point.
3. **"Let's hardcode it for now, we'll generalize later."** The failure of the v4 migration is the exact failure mode of this phrase. The MVP is allowed to hardcode **where data lives** (a TypeScript array of stage definitions) but never **how data is processed**. The generic engine runs from the hardcoded list unchanged the day we move the list into a file.

---

## 13. One-sentence summary

**The Operator is a local-first, git-native, closed-loop SDLC engine that uses external AI agents to autonomously discover, plan, implement, deliver, observe, and learn from changes to a codebase — every stage produces a PR, every PR has merge conditions (human review or auto-merge when CI passes), runtime configuration lives in a generic KV store seeded from the repo and editable through the UI, and no part of the loop is tied to a single vendor or hardcoded work type.**
