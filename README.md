# Operator

A small, generic runtime that runs a project's workflow operations - deterministic scripts and
agent CLIs (Claude Code, Codex) - on timers and named triggers, keeps its state in
[Ainoflow](https://ainoflow.io), and can place runs in [herdr](https://herdr.dev) tabs so a person
sees them working, or attends an interactive session there.

The runtime knows operations, triggers, pools, state and delivery. It does not know milestones,
labels, pull requests or merge rules: those live in the project's own scripts and skills, which
return a small versioned result and may request the next operation. Where the line between the
runtime, the installable skill packs and a project's own workflow runs is [docs/project-boundaries.md](docs/project-boundaries.md).
[Fast start](#fast-start) holds the prompts that install the runtime and make a repository a
managed project, and [docs/patterns/](docs/patterns/README.md) holds the SDLC patterns they recommend from.

## Fast start

Three paste-ready prompts for an agent session. Each one describes the state to reach, the limits to
respect and how to show it is reached; the agent works out the steps for the host and the repository
in front of it. Run the first once per host, then one of the other two at the root of the repository
to be managed. [docs/setup.md](docs/setup.md) explains what each choice decides.

### 1. Install Operator on a host

````text
Goal: this host can run the Operator runtime (@ainova-systems/operator, latest release) as a
background service for the projects I will set up on it.

Done when:
- `operator --version` prints the latest release, on a Node version the package supports;
- the code host's CLI and the agent CLIs I want operations to use are installed and signed in with
  the identity that will push and comment;
- the state backend's key is stored where only my user can read it, outside any repository;
- user services keep running when I am logged out, if the host supports that;
- herdr is installed if I want runs visible in terminal tabs (optional).

Limits: work out the steps for this OS yourself. Ask me before anything that needs sudo, a login or a
secret, and never print a secret or ask me to paste a token - I sign in myself. Install nothing I did
not confirm. Do not install a service yet: that needs a project's manifest.

Finish with a short table: each item ready, missing, or needs me.
````

### 2a. Set up the project's own workflow

````text
Goal: this repository is run by the Operator runtime with a workflow of its own - pull requests move
from queued work to merge-ready through phases that fit how this team already works, and I only make
the decisions that are mine.

Done when:
- the workflow is described in the repository (operator.yaml, a discovery that decides the next
  operation for each pull request, and one skill per phase) and validated, with tests;
- a dry run lists, for the current pull requests and queue, the operation each would get and why,
  and I agree with every line;
- the service is installed only after I say go.

How to get there: learn the repository first (branching, CI and which checks decide, tests, preview
or QA environments, where work is queued, where I make decisions, existing agent rules), then settle
each open choice with me one question at a time - what you found, two to four options, your
recommendation. Use the Operator repository's docs/patterns as the reference for what each choice
decides.

Limits: secrets stay out of the repository and are never printed; a public repository keeps its work
queue private; a change to the workflow never reaches a task already in flight; never force-push,
bypass branch protection, or record a decision as mine that I did not make. Everything lands through
the repository's normal change process.
````

### 2b. Adopt the recommended workflow from the operator packs

````text
Goal: this repository is run by the Operator runtime with the recommended pull-request workflow from
the operator packs (https://github.com/ainova-systems/operator-packs), installed and kept up to date
through intelligence (@ainova-systems/intelligence) as that repository's README describes, and
adapted to how this repository already works.

Done when:
- intelligence manages the packs: the operator-packs registry is added and the `operator` pack
  installed from it, and the `core` pack from intelligence-dev-packs too unless the repository
  already has its own equivalents, which the operator profile keys then point to;
- everything the packs leave to the project is answered in the repository's own rules and
  configuration - never by editing installed pack files - including the profile keys the operator
  pack lists in its README;
- operator.yaml and a discovery built on the pack's helpers are validated, with tests, and the pack's
  forge contract test passes against the configured code host;
- a dry run lists, for the current pull requests and queue, the operation each would get and why,
  and I agree with every line;
- the service is installed only after I say go.

How to get there: learn the repository first, compare it with what the packs expect, and settle each
gap with me one question at a time - what you found, two to four options, your recommendation. If a
pack is not published yet, say so and stop there.

Limits: as for any setup - secrets stay out of the repository and are never printed; a public
repository keeps its work queue private; a change never reaches a task already in flight; pack
versions change only through intelligence's own update; never force-push, bypass branch protection,
or record a decision as mine that I did not make. Everything lands through the repository's normal
change process.
````

## How it works

```text
timer / trigger ─▶ job (deduped) ─▶ pool slot ─▶ run: script, agent or interactive, headless or in a herdr tab
                                                     │
                       next operations / a wait ◀── result file (contract 1)
```

- **Manifest** (`operator.yaml`, next to the project's sources) names workflows, their triggers
  (`every`, `cron`, `on`), operations and pools.
- **Contract 1.** Every run gets an input file (`$OPERATOR_INPUT`) and writes one result file
  (`$OPERATOR_RESULT`): `status` is `done | noop | waiting | needs-input | failed`, with `evidence`,
  `next` requests and, for a question, a `wait` that a later `operator trigger` resumes. Optional
  `endSubjects` names subjects whose work is over: their per-subject tabs close, their sessions
  and Codex threads are forgotten and their open waits in the workflow end unanswered (`ended`);
  a result without it is read as before. Exit 0 without a valid
  result is a failure.
- **Dedupe, not exactly-once.** A job's id is derived from (workflow, operation, subject, trigger
  id); the same trigger twice is one job. A `next` request may carry a `key`: requests with the
  same operation, subject and key are one job while its record is kept, so a discovery that runs
  every few minutes can ask for the same work each time. Operations re-read live state before acting.
- **Crash safety.** A run's wrapper is detached from the daemon and leaves a heartbeat and
  `exit.json` in its run directory. A restarted daemon adopts running jobs instead of starting them
  again, and re-runs a job whose wrapper died.
- **Codex agents.** `engine: codex` with `agent: <name>` runs read-only with the model, reasoning
  effort and instructions of `.codex/agents/<name>.toml` in the run's working directory; `validate`
  reads the definition and names what it cannot read.
- **Exclusive operations.** `exclusive: true` keeps an operation - typically discovery - to one run
  at a time, so a timer slot and a manual trigger cannot both take the same work.
- **Pools.** `limit` pools are Ainoflow Guard semaphores (optionally shared across projects, or counted per host with `perHost`);
  `workspaces` pools hand out named working directories, each held by a renewable Shield lease.
  The runtime gives every lock back - a workspace, a run lease, the leader lease - by shortening it
  to one second with its token, never by deleting the key, which could remove a successor's lock;
  the next job that wants it retries once that second passed. A lease past its 24h lifetime is
  ended the same way and taken again within a few seconds - the leader lease, a run lease and a
  workspace alike. While a host takes its run lease again the key is briefly missing, so a daemon
  observing that host's job reads the run as expired only once the key stayed missing for six
  seconds. A workspace lease lost to another host is reported to the owner once per job, and a
  daemon that stops during a retake gives up the wait without reporting a loss.
  A daemon restarted on the same host takes the leader lease as soon as the stopped one's second
  passed. No command prints a token: any field named `token`, at any depth and in every
  collection, is left out of `operator job`, `jobs`, `claim` and `state` output, and the files that
  hold tokens (`leader.json`, the file state) are written readable by their owner only.
  A `next` request (or a `wait`, for the operation it resumes) may name the `member` to run in -
  for example the workspace that holds its subject - and the job waits for that member rather than
  taking another. A follow-on in the same workspace pool stays in the member its run held unless its
  request names another, and the input file tells each run its `member`. An operation may hold a `limit` pool alongside its `pool`, and `access: read`
  places a run in its named member without holding it, so read-only runs share a workspace.
- **Three kinds.** `script` is a deterministic program; `agent` is an agent CLI that answers and
  exits (`claude -p`, `codex exec`); `interactive` is a session a person can attend in a terminal
  (`claude` without `-p`, or a command). An interactive run needs a terminal placement: the
  wrapper hands it the terminal and ends it a few seconds after its result file is written, because
  the slot it holds goes to the next run. Without a reachable terminal it runs as an agent, and the
  job record says so. The command learns it has a terminal from `OPERATOR_ATTENDED=1`.
- **Kept tabs.** `keepTab: 30m` leaves a herdr run's tab open that long after its result: the
  result is collected and the follow-on starts at once, while an interactive session stays live in
  the tab for a person's questions and any other run's output stays readable; then the session ends
  and the tab closes, after a daemon restart too.
- **Per-subject tabs.** `tabs: per-subject` keeps one herdr tab per subject, operation and workspace
  member for the whole life of the subject. The first run opens it; every later run of the same
  operation for that subject runs in it, after the session the previous run left open there has
  ended. A `claude` run starts its session under a runtime-chosen `--session-id`, and the next run in
  the tab continues it with `--resume`, so a step that needs more work picks up where it stopped;
  other operations keep tabs and sessions of their own, so a reviewer never shares the implementer's
  context. One conversation per key: while a run of the key still works in the tab, the next one
  waits rather than forking it. The tab stays open until a result names its subject in
  `endSubjects`; `operator tabs` lists the tabs kept and their sessions, and the records survive a
  daemon restart and are renewed while their tabs stay open. A tab is recorded as soon as it opens,
  so a run that fails to start leaks none. A tab closed by hand is replaced, with a new session, by
  the next run. The wrapper, in the pane with the session's own environment and cwd, resumes the
  session when claude has its transcript (`<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<real path of
  the cwd as letters, digits and dashes>/<id>.jsonl`), however its last run ended, and otherwise starts
  it new under the same id - its first run never got to start it. If an agent run's claude still
  refuses ("already in use", "No conversation found"), the wrapper tries once the other way; never
  after a result, a signal or a hand-over, and never in an attended session, whose terminal output the
  wrapper does not see - one the owner quit stays quit. A session kept after its result no longer has a timeout. `keepTab` applies to per-job tabs
  only.
- **Tabs in use.** The runtime closes a tab - a kept tab whose `keepTab` ran out, a per-subject tab
  whose subject ended - or ends the session in a per-subject tab for the next run only when herdr
  reports the pane `idle`, `done`, gone, or `unknown` on two polls in a row (herdr reports `unknown`
  for a shell, but also for an agent a person just started before it detects it). `working`,
  `blocked` or a herdr that does not answer mean someone, usually the owner talking to the session after its
  result, may be doing work that closing it would cut off: the close waits for a later poll, an ended
  subject's tab leaves the registry and waits in the close retries, and the next run stays queued,
  saying why. A session on another host, or a pane not back at its shell, also keeps the next run
  waiting. A pane is back at its shell when herdr's `pane process-info` shows the shell holding its
  terminal; an agent still sitting idle or done there after the run's session ended is one no run
  started - herdr resumes the sessions of its panes after a restart - so the runtime closes that tab
  and the next run opens a new one that continues the subject's session. The retry of an
  interrupted run does the same even while the pane reports `working` or `blocked`, when herdr
  names the session there as that run's own: its wrapper is gone, and herdr resumed the session,
  often stopped at a prompt or a dialog. Any other session there keeps the retry waiting. An episode of use is logged once, and past `runtime.idleNudge` (30m when off) it is a
  warning and one owner notification, sent again on later polls until herdr delivers it. Timing: an
  ended subject's tab closes in the poll that ends it when its pane reads idle, done or gone, and on
  the next poll when it reads `unknown`; a tab still in use is asked again every minute, so it closes
  up to a minute after its pane frees. A pane left
  working or blocked keeps its tab open for as long as it stays so - the owner is told, and closes
  or frees it. A kept session is ended by closing its tab, never by its own clock; a tab an older
  daemon recorded without its pane closes as before.
- **Notifications.** `notify` lists the final result statuses that raise an owner notification
  (default `needs-input` and `failed` for agent and interactive operations, none for scripts); a
  scheduled retry is not final.
- **herdr.** `placement: herdr` opens a tab of the runtime's own in the target workspace and runs the
  wrapper there. Screen state is only a hint; a `blocked` agent raises a notification and is never
  answered by the runtime. An interactive session whose pane reads `done` or `idle` for
  `runtime.idleNudge` (default 20m, `off` to disable) without a result is asked, in the session, to
  write its result or say what it waits for; after two such nudges the owner is notified once. A
  session waiting on its own background work answers and keeps waiting. Without herdr the run
  degrades to headless and the job record says so.
  A tab herdr cannot close when its run ends is closed on a later poll; one closed by hand counts
  as closed.

## Several hosts

One project can run on several hosts that share its state namespace. Give each workspace the host
that runs it; a key with `count` declares a group, numbered from 1, whose `{name}` fills in the
directory and the herdr workspace:

```yaml
pools:
  claude-slot:
    workspaces:
      d: { count: 3, host: vm1, cwd: '../repo-{name}', herdr: 'repo-{name}' }   # d1, d2, d3
      a: { count: 3, host: vm2, cwd: '../repo-{name}', herdr: 'repo-{name}' }   # a1, a2, a3
  codex-review: { limit: 3, perHost: true }
```

Each host installs the service with the same manifest and an `OPERATOR_HOST=<name>` line in the
service's env file (the machine's host name when unset). Once any workspace names a host:

- every host runs its own daemon under its own leader lease, and all of them read one job queue;
- a host starts only jobs it can place: one for a workspace of another host is left to that host,
  and one for any member of a pool goes to whichever host takes a free member first. Timers fire
  once, since every host enqueues the same job; an `exclusive` operation runs once across all hosts;
- provider cooldowns, `perHost` limit pools, herdr tabs and `operator pause` belong to the host,
  because its accounts, its terminal and its restarts are its own (`operator pause` and `resume` run
  in a shell take the host from `OPERATOR_HOST` there too, and refuse a name no workspace carries);
  other limit pools, run leases,
  claims, the work queue and waits stay shared;
- an expired run of another host is taken over only after this host holds its run lease, so the
  host that ran it cannot take the lease back and keep running; a run that finds its lease held by
  another daemon stops;
- `validate` checks only this host's workspaces.

A daemon of the manifest before it named hosts placed every job anywhere: hosted daemons wait while
one still holds the project's leader lease, so stop it, then start the hosted ones.

A subject's work stays on its host while it is bound to one workspace, which is what keeps a
session, a kept tab or a Codex thread where it was started. Hosts keep their clocks in sync.

## Provider usage limits

Usage exhaustion is an availability wait, not an ordinary failed attempt. The runtime recognizes
Claude's rejected `rate_limit_event` and transcript API usage errors, and Codex's structured usage
errors. User messages, tool output, context-window exhaustion, authentication failures and allowed
or warning-only rate-limit events do not start a cooldown. A reported future reset time wins;
without a usable reset time the default is **four hours from detection**. Codex reset clocks
use the CLI process timezone, including an operation’s `env.TZ` override. Repeated notifications
for the same window do not keep extending it. Cooldowns persist in the state backend, scoped to
this project's namespace and provider, and to the host when the manifest names hosts (below); use
separate namespaces for independent provider accounts.

An attended Claude task keeps its **same process, conversation and workspace** while waiting.
Its active execution timeout pauses, and idle nudges stop. At reset the daemon continues an idle
or done pane once; a working client is allowed to resume itself. Blocked, unknown and unreachable
panes are never answered automatically. Unconfirmed continuation delivery retries up to three
times, at least a minute apart, checking for activity first; an unresolved delivery notifies the
owner and leaves the session open. The per-run deadline and delivery state survive a daemon
restart. A valid completed operation result always wins over earlier quota evidence.

The existing wall-time cap still applies to headless runs and any operation holding a
**nonrenewable `limit` pool**, whether through `pool` or `limit`: a session cannot outlive its Guard
capacity. If that cap ends a quota-limited run, the same job queues until reset and resumes its
saved Claude session or Codex thread. This does not spend ordinary retries. `attempt` counts
physical launches; `retryCount` counts ordinary failed retries. Every launch keeps its own run
files. An automatically assigned workspace stays pinned through quota recovery and ordinary retries.
An already-started queued task, a retry, and a new round in a retained conversation never switch provider,
except in an operation with `fallback: claude` (below).

Fallback is **opt-in per compatible operation**, in either direction: a Claude operation may
declare `fallback: codex`, and a Codex agent operation with a `schema` may declare
`fallback: claude`:

```yaml
workflows:
  development:
    operations:
      work:
        kind: interactive
        engine: claude
        fallback: codex
        prompt: >-
          Perform the task described in {input}. Preserve existing work and write the
          operation result (contract 1) to {result}.
        placement: herdr
        tabs: per-subject
        args: ['--permission-mode', auto]
      review:
        kind: agent
        engine: codex
        fallback: claude
        agent: code-reviewer
        schema: review.schema.json
        thread: per-subject
        then: review-verdict
```

Only a **new task that has not started** can choose the fallback provider when its own provider's
cooldown is already known. The task that first discovers the limit has already started and stays
with its provider. A retained
conversation for the same subject and operation also counts as started. Its provider is pinned
until the subject ends. If both providers are cooling down, new tasks stay queued until the first
usable reset; existing tasks wait for their own provider. A waiting live task keeps its workspace
lease, so fallback cannot borrow that workspace. An operation with `fallback: claude` is the
exception, described below. When the daemon starts, every queued job waiting for a provider reset
is decided again against the current manifest and cooldowns; a job still pinned to a cooling
provider gets the same wait back.

Enabling fallback declares that the prompt/skill can be performed by either engine. Codex runs as
an agent, retains the original task input and result contract, and uses its own conversation.
Claude model and CLI arguments are not forwarded. Untranslatable tool restrictions, injected
system prompts or settings arguments make validation refuse fallback instead of dropping a policy.
Codex uses `on-request` approvals and `read-only` for declared read access; write access uses
`workspace-write` plus only the current run directory. No permission bypass is added. Fallback may
return its contract as its final JSON message (including from a read-only sandbox); plain text,
invalid JSON or exit zero alone is never success. Existing native Codex output/schema operations
keep their output contract and read-only sandbox.

`fallback: claude` runs the same rendered prompt (`{output}` included) through `claude -p` with
`--json-schema` set to the operation's schema, and the instructions of `.claude/agents/<agent>.md`
(frontmatter removed) as `--append-system-prompt` only when the run's checkout defines it (`operator
validate` warns otherwise). It is not `--agent`: an agent's `tools` list leaves out the tool Claude
answers a schema with, and the run would end in prose. The agent's frontmatter (`tools`, `model` and
the rest) therefore does not apply; what the run may do is the permissions above. Without one, the default
Codex prompt names the Codex agent file, so a project using this fallback gives the operation its
own prompt or a Claude agent definition. Codex model and CLI arguments are not forwarded. The
Claude fallback run has no file-editing tools (Edit, Write and NotebookEdit are removed), may read
any file (`Read(//**)`, as Codex's read-only sandbox does - the input file lives in the run
directory), may run the read-only git commands a review needs (`rev-parse`, `merge-base`,
`diff`, `log`, `show`, `status`, with or without `-C`) and `sha256sum` - git's `--output`
option, which writes a file, is denied - runs unattended under `--permission-mode dontAsk` so it never waits on a permission
prompt, and every other tool is limited to what the project's own permission rules allow; the
project's deny rules, a `Read(.env)` deny included, still apply. That is not Codex's
read-only sandbox: a command those rules allow still runs. The runtime writes the
`structured_output` of Claude's final result to the run's `output.json`, so the result and the
`then` operation are exactly those of a Codex run; a run that ends without structured output, or
exits nonzero, fails. The fallback run answers once: it keeps no session, tab or provider affinity
for the subject, a retry starts afresh, and it never touches the operation's Codex thread, which
the next Codex run continues. Because the conversation lives in that thread, nothing in a task's
own history pins such an operation to Codex: not the subject's Codex affinity, not an idle Codex
tab, not an earlier start, a retry, or a Codex run that hit the usage limit. Each start chooses
from the cooldowns: during a Codex cooldown it runs on Claude when Claude is free, a task whose
Claude run hit the limit returns to Codex when Codex is free, and while both cool down it waits
for the earlier reset. Only a Codex review the subject tab is still running holds a new task to
Codex. A subject whose older Codex job is only queued, for example waiting for the quota reset,
counts as idle.

`operator job <id>` / `operator jobs --json` show `provider`, `quotaWait.until`, and the reason for
waiting; `operator state get provider-cooldowns claude` reads the cached provider deadline. These
runtime-owned collections are read-only through the state CLI. This behavior applies to wrappers
started by this version; upgrading the daemon does not replace code in an already-running wrapper.

## Use

```bash
npm install --global @ainova-systems/operator   # or: npm install && npm run build
operator validate --manifest operator.yaml      # manifest, scripts (--describe), skills, schemas, state
operator run --manifest operator.yaml          # the daemon; one active daemon per project
operator run --dry-run                          # scripts run, agents are only logged, local state
operator trigger <workflow> <name> --subject pr-7 --key q-1 --input '{"answer":"yes"}'
operator jobs [--status queued]  |  operator job <id>  |  operator waits  |  operator tabs [--json]
operator state get|put|list|delete <collection> [key]   # project state for scripts and skills
operator claim take|renew|release <subject> --run <id> [--ttl 1h]  |  operator claim show [subject]
operator queue add --title t --body-file spec.md  |  queue list|get|take|update   # private work queue
operator pause --wait [--reason text] [--timeout 2h]   # finish running jobs, start none; before a host restart (only this host's, once hosts are named)
operator resume                                 # also happens by itself when the service starts again
operator service install <project> --manifest operator.yaml [--env-file secrets.env] [--no-start]
operator service status <project>  |  operator service uninstall <project>
```

`AINOFLOW_API_KEY` comes from the environment, or from the manifest's `envFile` /
`OPERATOR_ENV_FILE` (`envKeys` / `OPERATOR_ENV_KEYS` limit what is taken, and a missing file is fine
once the environment already holds every one of them). The file state provider is
for tests and dry runs only.

The same CLI ships as an image, `ghcr.io/ainova-systems/operator-autopilot/operator`, for hosts
that run it in a container. The image carries no agent CLIs, so it suits script operations or a
base image that adds them; it runs as the `node` user, which must be able to read the mounted
project:

```bash
docker run --rm -v "$PWD:/project" ghcr.io/ainova-systems/operator-autopilot/operator validate
```

`operator service install` runs the daemon as the systemd user service `operator@<project>` (Linux):
it writes the unit to `~/.config/systemd/user/` and `~/.config/operator/<project>.env` with the
manifest, the secrets file and your current `PATH`, which the jobs start with, then enables and starts
it. An existing env file is kept as it is. Without linger the service stops when you log out
(`loginctl enable-linger`). `uninstall` stops and disables it, keeps the env file, and removes the unit
once no other project uses it; running jobs are detached and finish on their own, so `operator pause
--wait` first lets them end. Elsewhere, run `operator run` under the host's own service manager.

**Claims and the work queue.** `operator claim` is a lease on an opaque subject. The state
backend's atomic lock (Shield on Ainoflow) decides who holds it, so two runs never both hold one:
`take` wins only when the lock is free or the same run already holds it, and a conflict exits 3 and
names the holder, or says it is unknown while the winner is still writing its record. That record
only describes the holder, and its expiry is advisory; `claim show` reports both and says when they
disagree. `renew` and `release` act only for the holder, and the holder may renew its own lease that
ran out while nobody else took the subject. A lease is whole seconds and at most 24 hours, the lock's
lifetime; renewing keeps a subject longer, up to the end of the lock's day, after which the holder
takes it again like anyone else. `release` shortens the lock to one second by its token and lets it
lapse, since the backend has no token-checked delete; the lock token itself is never printed, not
even by `operator state`. A take whose answer is lost after the backend granted the lock leaves a
lock nobody holds a token for: it cannot be ended early, so the subject reads held, with the holder
unknown, until that lease runs out. The record's expiry is judged by the clock of the host reading it, so
hosts sharing a namespace keep their clocks in sync. Subjects, run ids and item ids use letters,
digits, `.`, `_`, `:` and `-`, at most 120. `operator queue` keeps a project's private work items
(`{ id, title, body, priority, status, source, createdAt, updatedAt, takenBy: { run, ref } }`) in its
own namespace: `take` moves a `ready` or `needs-decision` item to `taken` for one run, with an opaque
`--ref` to what the run delivers it in; `update` needs the `--if-match` etag from `get` and answers
the new one; statuses follow fixed transitions, and a `done` or `cancelled` item no longer changes.
Both live in reserved collections that `operator state` cannot write. A key that may only create
queue items, for another project's sessions filing findings, is a property of the state provider's
key, not something the runtime enforces.

`fixtures/demo` is a complete
example project: a discovery script, a stand-in agent placed in a herdr tab, a follow-on step and a
question answered through a trigger.

## Develop

```bash
npm ci
npm run typecheck
npm test            # unit and integration tests; live Ainoflow tests run when AINOFLOW_API_KEY is set
                    # in the environment or in .env.local (see .env.local.example)
npm run test:pack   # packs the package, installs it into an empty directory and runs the CLI
```

Node 24 or newer. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
