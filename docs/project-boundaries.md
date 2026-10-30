# Project boundaries

Status: proposed. Owner decisions are listed at the end; everything above them is the design as
recommended.

The first managed project grew the development workflow inside its own repository: discovery,
the phase skills, the run contract, the code-host calls, the queue reader and the project's own
specifics all sit side by side there. This document draws the line through that code, so that a
second project adopts the workflow by configuration, and so that the Operator repository can run
its own development through the same workflow.

## The test

Every function answers one question: **would a second project, on another code host and another
tracker, need exactly this?**

| Answer | Layer | Lives in |
|---|---|---|
| Yes, and it says nothing about pull requests or phases | **Runtime** | `src/` (this package, unchanged boundary) |
| Yes, and it is the development workflow: phases, claims, factors, questions, the queue | **Workflow kit** | this repository, a separate package the runtime never imports |
| No - its paths, documents, services, names or business rules | **Project layer** | the managed project's repository |

The runtime's rule stays as written in `intelligence/rules/context.md`: it knows operations,
triggers, pools, state and delivery, and nothing about a process. The workflow kit is the new
middle layer: it knows the development process, but no project. A project binds itself to both
through configuration - its manifest, its profile values and the small adapters only it can write.

## Inventory

Where each piece the first project carries belongs. "Splits" means the generic decision moves to
the kit and a project-supplied value or adapter stays behind.

| Function | Today | Verdict |
|---|---|---|
| Timers, jobs, dedupe, pools, waits, herdr placement, engines, result collection | runtime | **stays** in the runtime |
| One tab per subject and operation, reused across repeats, closed when the subject ends | runtime branch | **stays** in the runtime (generic: a subject is any key) |
| Run contract (`operator-contract`): input, result, claims, questions, markers | project, staged as a pack | **moves** to the kit |
| Phase skills: intake, plan, implement, review, review-verdict, verify, merge, clarify | project, staged as a pack | **move** to the kit; they already read profile keys only |
| Phase routing: which operation a pull request waits for, its dedupe key, stale claims, the conflict route, owner-input detection, question answers, stage-report envelopes, verification-steps digest, ready-limit and draft promotion, slot-of-branch | project discovery script | **moves** to the kit as a discovery library and a default discovery command |
| CI state from the code host's runs, filtered to the deciding workflows | project discovery script | **splits**: the reduction moves; the deciding workflow names stay as configuration |
| Milestone and label names, slots, ready limit, quotas, question marker | project JSON | **splits**: schema and defaults move; values stay |
| Review result schema | project | **moves** to the kit |
| Keeping the control checkout fast-forwarded and reporting a changed manifest | project discovery script | **moves** to the kit |
| Session hooks that refuse to end a session still holding a claim | project | **moves** to the kit (generic claim guard) |
| `dev-deliver-next`, `git-sync-base` | project, staged as a pack | **move** to the core development pack, not this repository: they are not runtime- or phase-specific |
| Queue reading: folder order, frontmatter fields, statuses, per-folder quotas | project discovery script | **splits**: the `queue` port moves (below); the repository-files layout is the project's provider configuration |
| QA deployment status for a head | project script reading the project's status comment | **stays** in the project, behind the kit's `qa_status` command contract |
| QA feedback tickets: list and move them | project script calling the project's application API | **stays** in the project, behind the kit's `qa_feedback` and `qa_feedback_status` command contracts |
| Judge engine choice for review and verification | project skill plus manifest | **splits**: the choice is manifest configuration; the delegation skill is the kit's when generic |
| Implementation skill, plan skill, merge gates, business priority | project | **stay** in the project (profile keys the kit reads) |
| Prompt overrides carrying a new rule into old slot branches | project manifest | **disappears** once phase skills load from the control checkout (blocker B1) |
| Live monitoring findings | private notes | **move** to the Operator project's private queue (below) |

## Ports

The kit talks to the outside world through four ports. A project names a provider for each; the
phase skills and discovery never call a provider's CLI directly.

| Port | Owns | Example providers |
|---|---|---|
| `codeHost` | branches, pull requests, diffs, CI runs, review threads, merge | github, gitlab, bitbucket, azure-devops |
| `tracker` | what the owner sees and signals: phase, outcome, owner decisions, questions | the code host itself (labels, milestones, comments), an issue tracker, ainoflow |
| `state` | the machine's own state: phase per subject, claims, factors per head, cursors, open questions | ainoflow |
| `queue` | work items waiting to be taken: their spec, priority and readiness | repo-files, issues, ainoflow |

### Source of truth

- **State is authoritative for machine state.** Claim, phase, factor freshness and question
  bookkeeping live in `state`, where a claim can finally be a lock: compare-and-set with a run id
  and an expiry, which a label cannot be.
- **The tracker carries owner signals and a projection.** Owner decisions (accept, hold, reject,
  cancel, an answer) are read from the tracker as events and recorded in `state`; the machine's
  phase and outcome are projected back onto the tracker so a person sees them. A projection that
  disagrees with `state` is rewritten, never believed.
- **The code host is authoritative for code and CI.** Head, mergeability, check results and review
  threads are read live; nothing caches them as truth.
- **The queue is authoritative for what work exists.** An item is taken by a compare-and-set on its
  status, so two intake runs never take one item.

With `tracker: codeHost` on GitHub this is today's behaviour: labels and milestones are both the
owner's signals and the projection. The split matters as soon as the tracker is not the code host.

### Normalized pull request

What the kit reads, whatever the host:

```text
pr      { id, number, url, title, body, draft, state: open|merged|closed,
          head: { ref, sha }, base: { ref }, mergeable: clean|conflicting|unknown,
          createdAt, author }
checks  { sha, state: pending|success|failure, runs: [{ name, state, url }] }
threads [{ id, resolved, path, line, comments: [{ author, body, createdAt }] }]
reviews [{ author, state: approved|changes|commented|dismissed, body, submittedAt }]
notes   [{ id, author, authorRole: owner|member|other, body, createdAt }]
```

### Capabilities the kit needs

The kit needs a fixed set of operations from each port. An adapter declares which it supports; a
missing one is reported as a capability gap at start, never emulated silently, because a factor
nobody can check is not a factor.

| Port | Required | Optional |
|---|---|---|
| `codeHost` | list open PRs with head and mergeability; view one; read checks for a SHA; read threads with their resolved flag; comment; create; mark ready; merge with a method | draft PRs, inline review comments, required-check list |
| `tracker` | read owner signals since a cursor; project phase and outcome; post a question and read its answer | per-item milestones, assignee |
| `state` | documents with etags and compare-and-set; leases with expiry; counting slots | TTL cleanup |
| `queue` | list ready items; take one by compare-and-set; update status and body; file a new item | priorities beyond four levels, attachments |

The GitHub mapping is the one the first project uses today and is the reference adapter. Each other
provider's mapping is written and verified against that host's documentation when its adapter is
built; this document does not assert one.

### Configuration

```yaml
# the kit's section of the project's operator configuration
codeHost: { provider: github, repo: <owner>/<repo>, identity: <env file key or config dir> }
tracker:  { provider: codeHost }              # or { provider: asana, project: <id> }, { provider: ainoflow }
state:    { provider: ainoflow, namespace: op-<project> }
queue:    { provider: repo-files, root: <path>, layout: <provider options> }
names:    { milestones: {...}, labels: {...} }  # tracker vocabulary; defaults from the kit
```

Combinations are free because the ports are independent: Bitbucket with Asana is
`{ codeHost: bitbucket, tracker: asana }`; adding Ainoflow as the owner's surface is
`tracker: ainoflow`, with `state` already there.

## The queue port

The Operator project's own queue is private (owner decision, 2026-10-30): its items name findings
from other projects' live runs, and this repository is public. The port therefore has a private
provider from the start.

| Provider | Item store | Visibility |
|---|---|---|
| `repo-files` | Markdown files with frontmatter in a folder of the repository | as the repository |
| `issues` | the code host's or tracker's issues, with a label marking queue items | as the issue tracker |
| `ainoflow` | a state collection in the project's namespace | private to holders of the namespace key |

### Item

```text
{ id, title, body,                       # body is the spec: problem, expectation, evidence
  priority: critical|high|medium|low,
  status: ready|needs-decision|blocked|taken|done|cancelled,
  source: { kind: owner|project-session|discovery, ref },   # ref never names another project in public text
  createdAt, updatedAt,
  takenBy?: { run, pr } }
```

Every update is compare-and-set on the item's etag. Intake takes an item by moving `ready → taken`
with its run id; a conflict means another run took it, and intake picks the next. Clarification takes
`needs-decision` items and returns them `ready` with the answers in the body.

### Producers and consumers

- **The owner** files items directly, through the wrapper CLI or the Ainoflow interface.
- **Another project's operator session** files a generic finding about the runtime or the kit:
  the defect, the evidence reduced to what any project would see, and no project name. It writes
  with a key scoped to creating items in the Operator project's queue collection, nothing else.
- **`operator-intake` and `operator-clarify`** consume through the wrapper; they never read the
  provider directly.

### Public and private

| Public (the repository) | Private (namespace, private tracker) |
|---|---|
| pull requests, commits, their reports and review replies | queue items and their evidence |
| design documents like this one, the changelog, releases | findings from live runs of other projects |
| the kit's skills and adapters | owner questions and answers, when the tracker is private |

A pull request that delivers a queue item links nothing private: it states the change and how to
confirm it, the way any published artifact does.

## The wrapper CLI

Skills are executed literally, so a provider call written into a skill ties the skill to that
provider. The kit ships one command that every phase skill calls instead, with JSON in the
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

It reads the project's configuration for the providers, and it is the only code that knows a
provider's CLI or API. Discovery uses the same adapters as a library.

## Operator for Operator

The Operator repository becomes a managed project of itself: its own queue, its own slots, and the
same phase skills delivering changes to the runtime and the kit.

Setup:

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
| B1 | A slot session loads phase skills from the pull request's branch, so a rule changed on the integration branch reaches an older branch late, and a pull request changing a phase skill would be judged by its own change | phase skills and the contract load from the kit version installed in the control checkout; a slot's branch never supplies them |
| B2 | The daemon would run the code under change | the daemon runs the released package; a merged change takes effect at release and restart, which is a deliberate owner step |
| B3 | Tests that start daemons or reach herdr or Ainoflow could touch the live instance | tests use the file driver and a temporary herdr scope; live Ainoflow tests use a namespace of their own, never the operator project's |
| B4 | Findings filed from other projects could carry their names into public pull requests | producers file reduced findings; intake re-checks against the project-name rule before any public text is written |
| B5 | Milestones, labels and the code host identity do not exist for this repository yet | the kit's init command creates the tracker vocabulary; the identity is the manifest's configuration, never the user's default |

## Migration order

Each step leaves the first project running unchanged.

1. **State into Ainoflow.** Claims become compare-and-set leases with a run id and expiry; factors
   are recorded per head; the tracker becomes a projection. Exit: the first project's discovery
   reads claims and factors from `state`, and its labels still match.
2. **Wrapper and GitHub adapter.** `operator-flow` with the GitHub provider for `codeHost`, `tracker`
   and `queue: issues`, plus the `repo-files` and `ainoflow` queue providers. Exit: every phase skill
   calls the wrapper; no skill names a provider CLI.
3. **Move the kit.** The run contract, phase skills, discovery library, review schema, claim guard and
   control-checkout updater move into this repository's kit package; the first project consumes it
   and keeps only its adapters and values. The repository context rule gains the kit as its second
   layer. Exit: the first project's discovery script is configuration plus its project readers.
4. **Dogfood.** Clear B1-B5 and start the Operator project's daemon on its private queue.
5. **More providers.** Each new code host or tracker is an adapter with its capability declaration
   and tests; no skill changes.

## Owner decisions

1. **Where the kit lives.** (a) This repository, a separate package the runtime does not import;
   (b) its own repository; (c) inside the core development pack. Recommended: (a) - the kit and
   the run contract change together, and one CI proves both.
2. **Default tracker for GitHub projects.** (a) The code host itself (labels, milestones), as today;
   (b) Ainoflow only, with labels as a projection. Recommended: (a) - the owner already works there.
3. **The first project's queue provider.** (a) Keep `repo-files`; (b) move to `ainoflow`.
   Recommended: (a) - its queue items are public documentation by its own rules.
4. **How phase skills reach a slot.** (a) From the kit version installed in the control checkout;
   (b) installed per user, outside any checkout. Recommended: (a) - one pinned version per project.
5. **Wrapper language.** (a) TypeScript in the kit package, built like the runtime; (b) a plain
   Node script. Recommended: (a) - the repository's conventions and tests already apply.
6. **Write access for other projects' findings.** (a) A scoped key that can only create queue items;
   (b) the owner relays every finding. Recommended: (a), with intake's name check as the second guard.
