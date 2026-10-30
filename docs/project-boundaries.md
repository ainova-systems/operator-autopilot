# Project boundaries

Status: accepted (owner, 2026-10-30). The decisions it rests on are listed at the end.

The first managed project grew its development workflow inside its own repository: discovery,
the phase skills, the run contract, the code-host calls, the queue reader and the project's own
specifics all sit side by side there. This document draws the line through that code, so that a
second project gets a workflow of its own without copying the first one by hand, and so that the
Operator repository can run its own development the same way.

**Every project's workflow is its own.** Branching, CI, test suites, preview and QA environments,
where work is queued and how the owner signals are different in every repository, so there is no
shared workflow that every project runs. What is shared is the mechanics a workflow is built from,
the patterns that worked, and the procedure that builds a workflow from both.

## Layers

| # | Layer | What it is | Lives in |
|---|---|---|---|
| 1 | **Runtime** | operations, triggers, pools, jobs, waits, state backend, delivery, herdr placement; knows no process | this repository, `src/` (unchanged boundary) |
| 2 | **Building blocks** | the generic mechanics a workflow calls: ports and adapters, the `operator-flow` wrapper, claims, questions, discovery and contract helpers | this repository, a package the runtime does not import |
| 3 | **SDLC pattern references** | documented sample workflows: what each phase decides, why, and how it was built from the blocks | this repository, documentation beside the blocks |
| 4 | **Setup skill** | researches a repository, interviews its owner, then generates and validates that project's workflow from blocks and patterns | this repository, shipped with the blocks |
| 5 | **Project workflow** | the project's manifest, discovery script, phase skills and adapters - generated once, then owned and changed by the project | the managed project's repository |

The test for any function: **is it a mechanic every workflow needs in the same form?** Then it is a
block. **Is it a decision about how one project works?** Then it belongs to that project's
workflow, and at most an anonymized copy of it becomes a pattern reference.

The runtime's rule stays as written in `intelligence/rules/context.md`: it knows nothing about a
process. The blocks know pull requests, claims and questions, but decide nothing; deciding is the
project's workflow.

## Inventory

Where each piece the first project carries belongs. The first project's workflow stays in its
repository; it is rebuilt on the blocks, and only its generic mechanics move.

| Function | Today | Verdict |
|---|---|---|
| Timers, jobs, dedupe, pools, waits, herdr placement, engines, result collection | runtime | **stays** in the runtime |
| One tab per subject and operation, reused across repeats, closed when the subject ends | runtime branch | **stays** in the runtime (a subject is any key) |
| Discovery script: which operation each pull request waits for, in which slot | project | **stays** in the project as its workflow, rebuilt on the blocks: no direct code-host CLI, state through the `state` port |
| Phase skills: intake, plan, implement, review, review-verdict, verify, merge, clarify | project | **stay** in the project, rebuilt on the blocks: every host call through `operator-flow`; anonymized copies become pattern references |
| Run contract (input, result, claims, questions, markers) | project skill | **splits**: the contract-1 file helpers and the claim and question mechanics become blocks; the project's skill keeps its own rules on top |
| Request keys bounded and deduped, slot-of-branch, owner-input cursor, stage-report envelope, verification-steps digest, CI state for a commit | project discovery script | **move** to the blocks as discovery helpers |
| Stale-claim detection, claim take and release | project discovery script and skills | **move** to the blocks as the CAS claim on the `state` port |
| Question posting, answer detection, resuming the waiting run | project skill and discovery | **move** to the blocks as question/answer mechanics |
| Code-host and tracker calls (list, view, checks, threads, labels, milestones, comments, merge) | `gh` in the script and the skills | **move** to the blocks as the GitHub adapter behind the ports |
| Keeping the control checkout fast-forwarded and reporting a changed manifest | project discovery script | **moves** to the blocks |
| Phase routing rules, ready limit and draft promotion, conflict route, clarification phase, merge gates, owner labels | project | **stay** in the project; each becomes a pattern reference, anonymized |
| Milestone and label names, slots, quotas, deciding CI workflows | project JSON | **stay** in the project as its configuration |
| Queue layout (folders, frontmatter, statuses, quotas) | project discovery script | **splits**: the `queue` port and its `repo-files` provider are blocks; the layout is the project's provider configuration |
| QA deployment status, QA feedback tickets | project scripts | **stay** in the project; the blocks define only the command contracts a phase calls |
| Review result schema | project | **stays** in the project; a copy becomes part of the review pattern reference |
| Session hooks that refuse to end a session still holding a claim | project | **move** to the blocks (generic claim guard); the project wires them |
| `dev-deliver-next`, `git-sync-base` | project, staged as a pack | **move** to the core development pack: they are not operator-specific |
| Live monitoring findings | private notes | **move** to the Operator project's private queue (below) |

## Building blocks

### Ports

A project's workflow talks to the outside world through four ports. It names a provider for each;
its discovery script and phase skills never call a provider's CLI directly.

| Port | Owns | Example providers |
|---|---|---|
| `codeHost` | branches, pull requests, diffs, CI runs, review threads, merge | github, gitlab, bitbucket, azure-devops |
| `tracker` | what the owner sees and signals: phase, outcome, owner decisions, questions | the code host itself (labels, milestones, comments), an issue tracker, ainoflow |
| `state` | the machine's own state: phase per subject, claims, factors per head, cursors, open questions | ainoflow |
| `queue` | work items waiting to be taken: their spec, priority and readiness | repo-files, issues, ainoflow |

**Source of truth.**

- **State is authoritative for machine state.** Claim, phase, factor freshness and question
  bookkeeping live in `state`, where a claim can be a lock: compare-and-set with a run id and an
  expiry, which a label cannot be.
- **The tracker carries owner signals and a projection.** Owner decisions (accept, hold, reject,
  cancel, an answer) are read from the tracker as events and recorded in `state`; the machine's
  phase and outcome are projected back onto the tracker so a person sees them. A projection that
  disagrees with `state` is rewritten, never believed.
- **The code host is authoritative for code and CI.** Head, mergeability, check results and review
  threads are read live; nothing caches them as truth.
- **The queue is authoritative for what work exists.** An item is taken by a compare-and-set on its
  status, so two intake runs never take one item.

With the tracker on the code host this is the first project's behaviour today: labels and
milestones are both the owner's signals and the projection. The split matters as soon as the
tracker is not the code host.

**Normalized pull request** - what a workflow reads, whatever the host:

```text
pr      { id, number, url, title, body, draft, state: open|merged|closed,
          head: { ref, sha }, base: { ref }, mergeable: clean|conflicting|unknown,
          createdAt, author }
checks  { sha, state: pending|success|failure, runs: [{ name, state, url }] }
threads [{ id, resolved, path, line, comments: [{ author, body, createdAt }] }]
reviews [{ author, state: approved|changes|commented|dismissed, body, submittedAt }]
notes   [{ id, author, authorRole: owner|member|other, body, createdAt }]
```

**Capabilities.** An adapter declares which operations it supports; a missing one is reported as a
capability gap at start, never emulated silently, because a factor nobody can check is not a factor.

| Port | Required |
|---|---|
| `codeHost` | list open PRs with head and mergeability; view one; read checks for a SHA; read threads with their resolved flag; comment; create; mark ready; merge with a method |
| `tracker` | read owner signals since a cursor; project phase and outcome; post a question and read its answer |
| `state` | documents with etags and compare-and-set; leases with expiry; counting slots |
| `queue` | list ready items; take one by compare-and-set; update status and body; file a new item |

The GitHub mapping is the one the first project uses today and is the reference adapter. Each other
provider's mapping is written and verified against that host's documentation when its adapter is
built; this document does not assert one.

**Configuration** - the project's ports section:

```yaml
codeHost: { provider: github, repo: <owner>/<repo>, identity: <env file key or config dir> }
tracker:  { provider: codeHost }              # or { provider: asana, project: <id> }, { provider: ainoflow }
state:    { provider: ainoflow, namespace: op-<project> }
queue:    { provider: repo-files, root: <path>, layout: <provider options> }
```

Combinations are free because the ports are independent: Bitbucket with Asana is
`{ codeHost: bitbucket, tracker: asana }`; adding Ainoflow as the owner's surface is
`tracker: ainoflow`, with `state` already there.

### The queue port

The Operator project's own queue is private (owner decision, 2026-10-30): its items name findings
from other projects' live runs, and this repository is public. The port therefore has a private
provider from the start.

| Provider | Item store | Visibility |
|---|---|---|
| `repo-files` | Markdown files with frontmatter in a folder of the repository | as the repository |
| `issues` | the code host's or tracker's issues, with a label marking queue items | as the issue tracker |
| `ainoflow` | a state collection in the project's namespace | private to holders of the namespace key |

Item:

```text
{ id, title, body,                       # body is the spec: problem, expectation, evidence
  priority: critical|high|medium|low,
  status: ready|needs-decision|blocked|taken|done|cancelled,
  source: { kind: owner|project-session|discovery, ref },   # ref never names another project in public text
  createdAt, updatedAt,
  takenBy?: { run, pr } }
```

Every update is compare-and-set on the item's etag. An intake phase takes an item by moving
`ready → taken` with its run id; a conflict means another run took it, and intake picks the next.
A clarification phase takes `needs-decision` items and returns them `ready` with the answers in the
body.

Producers and consumers:

- **The owner** files items directly, through `operator-flow` or the Ainoflow interface.
- **Another project's operator session** files a generic finding about the runtime or the blocks:
  the defect, the evidence reduced to what any project would see, and no project name. It writes
  with a key scoped to creating items in the Operator project's queue collection, nothing else.
- **The project's intake and clarification phases** consume through `operator-flow`; they never read
  the provider directly.

Public and private:

| Public (the repository) | Private (namespace, private tracker) |
|---|---|
| pull requests, commits, their reports and review replies | queue items and their evidence |
| design documents like this one, pattern references, the changelog, releases | findings from live runs of other projects |
| the blocks, the setup skill | owner questions and answers, when the tracker is private |

A pull request that delivers a queue item links nothing private: it states the change and how to
confirm it, the way any published artifact does.

### The wrapper CLI

Skills are executed literally, so a provider call written into a skill ties the skill to that
provider. The blocks ship one command every generated phase skill calls instead, with JSON in the
normalized shapes above:

```text
operator-flow pr list | view <n> | ready <n> | merge <n> | comment <n> --body-file <f>
operator-flow checks <sha>
operator-flow threads <n> [--resolve <id> --body <text>]
operator-flow signal read [--since <cursor>] | project <n> --phase <p> [--outcome <o>]
operator-flow claim take <subject> | release <subject>
operator-flow factor record <subject> --name <f> --head <sha> --report <url>
operator-flow question ask <subject> --key <k> --body-file <f> | answers <subject>
operator-flow queue list [--status ready] | take <id> | update <id> ... | file --title ... --body-file <f>
```

It reads the project's ports section, and it is the only code that knows a provider's CLI or API.
A project's discovery script imports the same adapters and the discovery helpers as a library.

### Other blocks

- **CAS claim**: take, renew and release a subject's claim on the `state` port, with run id and
  expiry; a claim whose run is gone is detectable, not guessed.
- **Questions and answers**: post a question with a stable key, detect the owner's answer on the
  tracker, resume the run that waits on it through the runtime's trigger.
- **Discovery helpers**: bounded request keys, slot-of-branch, owner-input cursor, stage-report
  envelope parsing, verification-steps digest, CI state for one commit, control-checkout
  fast-forward.
- **Contract helpers**: read the contract-1 input, write a valid result with `next` requests and a
  `wait`.
- **Claim guard**: session hooks that refuse to end a session still holding a claim it took.

## SDLC pattern references

Documented sample workflows a setup run draws from, each stating what it decides, why, which blocks
it uses and what a project must supply. They are references, not code a project runs: a project's
workflow copies and adapts them.

- **Pull request pipeline with independent judges**: intake, plan, implement, review by another
  engine or a fresh session, verify against the running change, owner review, merge; factors fresh
  per head.
- **QA admission and drafts**: a limited number of ready pull requests hold the QA environments;
  drafts get builds, suites and review, and are promoted oldest first.
- **Clarification phase**: an item waiting on an owner decision is planned, its questions asked one
  at a time, and merged once every answer is recorded.
- **Conflict route**: a pull request in a later phase that conflicts with its base returns to
  implementation instead of waiting.
- **Owner signals**: accept, hold, revalidate, reject, cancel and answer, and how each moves a
  pull request.
- **Merge gates**: required checks on the head, fresh factors, no open thread, no unresolved open
  question, no unaccepted manual step.

The first project's pipeline is included as one complete reference, anonymized: its phases, routing
rules and skills with every project path, name and service replaced by its role.

## The setup skill

`operator-setup-workflow` turns a repository into a managed project.

1. **Research the repository.** Branching and protected branches, CI workflows and which checks
   decide, test suites and how they run, preview or QA environments, where work is queued today,
   the code host and the tracker, existing agent rules and skills.
2. **Interview the owner, one question at a time.** Each question states what the research found,
   two to four options and a recommendation drawn from the pattern references: which phases, how
   many slots, who judges, how QA is admitted, which owner signals, which merge gates, which queue
   provider.
3. **Generate the workflow.** The project's `operator.yaml`, its ports section, its discovery script
   built on the discovery helpers, its phase skills calling `operator-flow`, and the adapters only
   it can write (QA status, QA feedback) - each with tests.
4. **Validate.** `operator validate --describe` resolves every operation; the discovery script's
   tests pass; a dry run of the daemon makes the requests the owner expects for the repository's
   current pull requests and queue.

After generation the workflow belongs to the project: it changes it like any other code, and a
newer blocks version is a dependency upgrade.

**A change to a workflow never reaches a task in flight.** A pipeline branch runs the phase skills
and rules it was created with; a change applies to branches started after it. The one exception is
an engine that is unavailable: the manifest swaps it for every run.

## Operator for Operator

The Operator repository becomes a managed project of itself: its own private queue, its own slots,
and a workflow of its own.

**Acceptance test:** the setup skill generates the Operator project's workflow from research of this
repository and the owner's answers, with no hand-written workflow code, and that workflow delivers
the first item from the private queue to a merge-ready pull request.

Expected shape, which the setup run confirms or changes with the owner:

- A control checkout on `master`, separate from development checkouts, running a daemon from the
  **released** package, with its own manifest, namespace and code host identity.
- Two slots for delivery and one for clarification; the queue on the `ainoflow` provider.
- Verification is local: the pull request's declared steps run in the slot against the built
  package and `fixtures/demo` (typecheck, tests, `test:pack`, a demo run); there is no deployed
  preview.
- The existing development profile stays: protected `master`, squash merge, owner-invoked merge, and
  direct pushes for documentation and intelligence paths.

Blockers, each to be cleared before the daemon takes its first item:

| # | Blocker | Resolution |
|---|---|---|
| B1 | The daemon would run the code under change | the daemon runs the released package; a merged change takes effect at release and restart, which is a deliberate owner step |
| B2 | Tests that start daemons or reach herdr or Ainoflow could touch the live instance | tests use the file driver and a temporary herdr scope; live Ainoflow tests use a namespace of their own, never the operator project's |
| B3 | Findings filed from other projects could carry their names into public pull requests | producers file reduced findings; intake re-checks against the project-name rule before any public text is written |
| B4 | Milestones, labels and the code host identity do not exist for this repository yet | the setup skill creates the tracker vocabulary the owner chose; the identity is the manifest's configuration, never the user's default |

## Migration order

Each step leaves the first project running unchanged.

1. **State into Ainoflow.** The CAS claim and per-head factors on the `state` port; the tracker
   becomes a projection. Exit: the first project's discovery reads claims and factors from `state`,
   and its labels still match.
2. **Blocks package.** Ports, the GitHub adapter, the `repo-files`, `issues` and `ainoflow` queue
   providers, `operator-flow`, questions, discovery and contract helpers, the claim guard - extracted
   from the first project's mechanics, with tests. Exit: the package is released and the runtime
   does not import it.
3. **Rebuild the first project's workflow on the blocks.** Its discovery script and phase skills
   stay in its repository and keep their decisions; their host calls go through `operator-flow` and
   the helpers. Exit: no skill or script of that workflow names a provider CLI, and its pipeline
   behaves as before.
4. **Pattern references.** The sample workflows above, the first project's pipeline among them,
   anonymized. Exit: each names the blocks it uses and what a project supplies.
5. **Setup skill.** Research, interview, generate, validate. Exit: it regenerates a workflow
   equivalent to the first project's from that repository and recorded answers, as a dry run.
6. **Dogfood.** Clear B1-B4, run the setup skill on this repository, start the daemon on the private
   queue. Exit: the acceptance test above.
7. **More providers.** Each new code host or tracker is an adapter with its capability declaration
   and tests; workflows change only their ports section.

## Decisions

All owner decisions, 2026-10-30. Nothing is open.

1. Blocks, pattern references and the setup skill live in this repository, as a package separate
   from the runtime.
2. The wrapper CLI is TypeScript in that package, built and tested like the runtime.
3. The Operator project's queue is private: the `ainoflow` provider in its own namespace.
4. Other projects file findings with a key that can only create items in that queue; intake checks
   every item for project names before any public text is written.
5. A pipeline branch runs the phase skills and rules it was created with (see *The setup skill*).
