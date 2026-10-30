# Project boundaries

Status: accepted (owner, 2026-10-30). The decisions it rests on are listed at the end.

The first managed project grew its development workflow inside its own repository: discovery,
the phase skills, the run contract, the code-host calls, the queue reader and the project's own
specifics all sit side by side there. This document draws the line through that code, so that a
second project gets a workflow of its own without copying the first one by hand, and so that the
Operator repository can run its own development the same way.

**Every project's workflow is its own.** Branching, CI, test suites, preview and QA environments,
where work is queued and how the owner signals are different in every repository, so there is no
shared workflow that every project runs. What is shared is a tiny runtime, installable skill packs,
the patterns that worked, and a setup that puts them together for one repository.

## Where things live

| Piece | What it is | Lives in |
|---|---|---|
| **Runtime** | operations, triggers, pools, jobs, waits, delivery; its workflow-agnostic integrations herdr (terminal placement) and Ainoflow (state, guard pools) | this repository, `src/` |
| **Setup prompt** | one prompt that makes a repository a managed project from scratch | this repository |
| **SDLC pattern docs** | documented sample workflows and why each phase decides what it does | this repository, `docs/` |
| **`operator` pack** | phase skills, generic discovery helpers as scripts inside the skill folders, and the forge contract with its contract test | the development packs repository, installed by intelligence sync |
| **Platform packs** | one per platform, each implementing the forge contract: `forge-github` now; `forge-gitlab`, `forge-bitbucket`, `tracker-asana` later | the development packs repository |
| **Project workflow** | `operator.yaml`, the workflow configuration, profile keys, the project's own scripts (QA status, QA feedback) and skills | the managed project's repository |

The runtime stays tiny and knows no process. It gains a core feature only when a workflow needs it
and only when the feature is workflow-agnostic: a compare-and-set claim on a subject, and a private
work queue in its state, are the two this design needs.

A project installs only the packs it uses. A project may also copy and adapt the pattern docs and
the pack skills instead of installing them.

## Inventory

Where each piece the first project carries goes.

| Function | Today | Goes to |
|---|---|---|
| Timers, jobs, dedupe, pools, waits, herdr placement, engines, result collection, one tab per subject and operation | runtime | **runtime**, unchanged |
| Claim take and release, stale-claim detection | labels written by skills, read by discovery | **runtime** claim (lease with run id and expiry); the forge projects it as a label |
| The work queue of the Operator project itself | private notes | **runtime** private work queue |
| Phase skills: intake, plan, implement, review, review-verdict, verify, merge, clarify, and the run contract | project, staged as a pack | **`operator` pack** |
| Request keys, slot-of-branch, owner-input cursor, stage-report envelope, verification-steps digest, CI state for a commit, control-checkout fast-forward, claim guard hooks | project discovery script and hooks | **`operator` pack**, as scripts in its skill folders |
| Every code-host call (pull requests, checks, threads, labels, milestones, comments, merge) | `gh` spread over the script and the skills | **forge contract** in the `operator` pack; the GitHub implementation in **`forge-github`** |
| The discovery script that composes the helpers with the project's own readers | project | **project** |
| Queue layout (folders, frontmatter, statuses, quotas), milestone and label names, slots, deciding CI workflows | project | **project** configuration |
| QA deployment status, QA feedback tickets, review result schema | project scripts | **project** |
| Phase routing, QA admission and drafts, conflict route, clarification phase, owner signals, merge gates | project | **project**; an anonymized copy in the **SDLC pattern docs** |
| `dev-deliver-next`, `git-sync-base` | project, staged as a pack | the **core development pack**: not operator-specific |

## The forge contract

Skills are executed literally, so a `gh` call written into a skill ties it to GitHub. Phase skills
and discovery call the platform through one profile key instead, `forge_cli`, which names the
installed platform pack's command. There is no dispatcher: the project points the key at the one
implementation it uses.

```text
<forge_cli> pr list | view <n> | create ... | ready <n>
<forge_cli> checks <sha>
<forge_cli> threads <n> [--resolve <id> --body <text>]
<forge_cli> claim take <n> | release <n>
<forge_cli> factor set <n> --name <f> | clear <n> --name <f>
<forge_cli> comment <n> --body-file <f>
<forge_cli> merge <n> --method <m>
```

Every answer is normalized JSON:

```text
pr      { number, url, title, body, draft, state: open|merged|closed,
          head: { ref, sha }, base: { ref }, mergeable: clean|conflicting|unknown,
          labels, milestone, createdAt, author }
checks  { sha, state: pending|success|failure, runs: [{ name, state, url }] }
threads [{ id, resolved, path, line, comments: [{ author, body, createdAt }] }]
notes   [{ id, author, authorRole: owner|member|other, body, createdAt }]
```

The `operator` pack ships a contract test that every platform pack passes. A subcommand a platform
cannot serve fails with a named capability gap, never an emulation: a factor nobody can check is not
a factor. Each platform's mapping is verified against that platform's documentation when its pack
is built; this document asserts none beyond GitHub, which the first project uses today.

A tracker pack (`tracker-asana`) serves the owner-facing subcommands - claim and factor projection,
comments - for a project whose owner works outside the code host, through its own profile key.

## Runtime state: claim and queue

**Claim.** `take`, `renew` and `release` on a subject, compare-and-set with a run id and an expiry.
The runtime's claim is the truth; a label on the code host is its projection for people.

**Private work queue.** A collection in the project's namespace, for a project whose queue must not
be public. The Operator project's own queue is one (owner decision, 2026-10-30): its items name
findings from other projects' live runs, and this repository is public.

```text
{ id, title, body,                       # body is the spec: problem, expectation, evidence
  priority: critical|high|medium|low,
  status: ready|needs-decision|blocked|taken|done|cancelled,
  source: { kind: owner|project-session, ref },
  createdAt, updatedAt, takenBy?: { run, pr } }
```

Every update is compare-and-set on the item's etag: intake takes an item by moving `ready → taken`
with its run id, and a conflict means another run took it. Clarification takes `needs-decision`
items and returns them `ready` with the answers in the body.

- **Producers:** the owner, and other projects' operator sessions filing a generic finding - the
  defect and the evidence any project would see, no project name - with a key that can only create
  items in this queue.
- **Consumers:** the intake and clarification phases, which check every item for project names
  before writing any public text.

| Public (the repository) | Private (the namespace) |
|---|---|
| pull requests, commits, their reports and review replies | queue items and their evidence |
| this document, the pattern docs, the changelog, releases | findings from live runs of other projects |

A pull request that delivers a queue item links nothing private.

## Terminal port (future)

Placement becomes `terminal`, with one runtime setting `herdr | tmux`; for tmux, an agent's status
comes from Claude Code hooks writing a status file.

## SDLC pattern docs

Sample workflows the setup draws its recommendations from, each stating what it decides, why, and
what a project must supply:

- **Pull request pipeline with independent judges**: intake, plan, implement, review by another
  engine or a fresh session, verify against the running change, owner review, merge; factors fresh
  per head.
- **QA admission and drafts**: a limited number of ready pull requests hold the QA environments;
  drafts get builds, suites and review, and are promoted oldest first.
- **Clarification phase**: an item waiting on an owner decision is planned, its questions asked one
  at a time, and merged once every answer is recorded.
- **Conflict route**: a pull request in a later phase that conflicts with its base returns to
  implementation instead of waiting.
- **Owner signals**: accept, hold, revalidate, reject, cancel and answer, and how each moves a pull
  request.
- **Merge gates**: required checks on the head, fresh factors, no open thread, no unresolved open
  question, no unaccepted manual step.

The first project's pipeline is included as one complete reference, anonymized.

## The setup prompt

One prompt, run in the target repository, from scratch:

1. **Install the runtime** and its service.
2. **Add the packs** to `intelligence.yaml` - `operator` and the platform pack - and run
   intelligence sync.
3. **Research the repository**: branching, CI and which checks decide, test suites, preview or QA
   environments, where work is queued, the code host and the tracker, existing rules and skills.
4. **Interview the owner, one question at a time**: what the research found, two to four options
   and a recommendation from the pattern docs.
5. **Write** `operator.yaml`, the workflow configuration and the profile keys (`forge_cli` among
   them), and the discovery script from the pack's helpers.
6. **Validate**: `operator validate --describe` resolves every operation, the forge contract test
   passes against the chosen platform pack, and a dry run makes the requests the owner expects for
   the repository's current pull requests and queue.

After setup the workflow belongs to the project, which changes it like any other code.

**A change never reaches a task in flight.** A pipeline branch runs the operator skills and rules it
was created with; a change applies to branches started after it and is never pushed into a running
task. The one exception is an unavailable engine, which the manifest swaps for every run.

## Operator for Operator

The Operator repository becomes a managed project of itself.

**Acceptance test:** the setup prompt configures this repository from research and the owner's
answers, with no hand-written workflow code, and the result delivers the first item from the
private queue to a merge-ready pull request.

Expected shape, which the setup confirms or changes with the owner:

- A control checkout on `master` running a daemon from the **released** package, with its own
  manifest, namespace and code host identity.
- Two delivery slots and one clarification slot; the private Ainoflow queue.
- Local verification: typecheck, tests, `test:pack` and a `fixtures/demo` run in the slot; there is
  no deployed preview.
- The existing development profile: protected `master`, squash merge, owner-invoked merge.

Blockers to clear before the daemon takes its first item:

| # | Blocker | Resolution |
|---|---|---|
| B1 | The daemon would run the code under change | it runs the released package; a merged change takes effect at release and restart, an owner step |
| B2 | Tests that start daemons or reach herdr or Ainoflow could touch the live instance | the file driver and a temporary herdr scope; live Ainoflow tests in a namespace of their own |
| B3 | Findings from other projects could carry their names into public pull requests | producers file reduced findings; intake checks names before any public text |
| B4 | Milestones, labels and the code host identity do not exist for this repository yet | the setup creates the vocabulary the owner chose; the identity is manifest configuration |

## Migration order

Each step leaves the first project running.

1. **One forge script in the first project.** Every code-host call collected into one script that
   implements the forge contract, called through `forge_cli`.
2. **Claim and queue in runtime state.**
3. **Publish the `operator` and `forge-github` packs.** The first project installs them in place of
   its staged copies.
4. **Setup prompt and pattern docs.**
5. **Dogfood** on this repository with the private Ainoflow queue: the acceptance test above.
6. **More platform packs, and the terminal port.**

## Decisions

All owner decisions, 2026-10-30. Nothing is open.

1. The runtime stays tiny and keeps its workflow-agnostic integrations, herdr and Ainoflow. It
   gains a core feature only when needed and only when workflow-agnostic: the subject claim and the
   private work queue.
2. Everything SDLC-specific ships as intelligence packs in the development packs repository: the
   `operator` pack and one pack per platform, called through `forge_cli`, with no dispatcher. A
   project installs only what it uses, or copies and adapts.
3. This repository holds the runtime, the setup prompt and the SDLC pattern docs.
4. The terminal port comes later: `terminal` placement with a `herdr | tmux` setting.
5. The Operator project's queue is private, in the runtime's state.
6. Other projects file findings with a create-only key on that queue; intake checks every item for
   project names.
7. A pipeline branch runs the operator skills and rules it was created with; only an unavailable
   engine is swapped, for every run.
