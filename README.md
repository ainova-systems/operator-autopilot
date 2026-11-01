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

Three paste-ready prompts for an agent session (Claude Code). Run the first once per host. Then run
one of the other two at the root of the repository to be managed: 2a builds the project's own
workflow, and 2b adopts the recommended one from the development packs.
[docs/setup.md](docs/setup.md) explains what each step decides and why.

Every prompt follows the same rules:
- it asks the owner one question at a time, each with options and a recommendation;
- it never prints a secret and never force-pushes;
- it stops before enabling the service.

### 1. Install Operator on a host

````text
Install the Operator runtime (@ainova-systems/operator) on this host. Ask me one question at a time,
with options and your recommendation. Never print a secret; stop and ask whenever something needs a
login, a secret or sudo.

1. Report the baseline: OS, user, free RAM and disk, `loginctl show-user $USER -p Linger`, and the
   versions of node (24 or newer required), npm, git, the code host's CLI (gh, glab, ...), the agent
   CLIs that will run operations (claude, codex), and herdr (optional; without it runs are headless,
   with it they open in terminal tabs a person can watch and talk to). List what is missing with its
   install command; install only after I confirm.
2. `npm install --global @ainova-systems/operator@latest`; report `operator --version`.
3. Ask me for the AINOFLOW_API_KEY of the project's state namespace and store it in
   ~/.config/operator/<project>.env with mode 600. It is never written into a repository or printed.
4. Check that the code host's CLI is logged in with the identity that will push and comment; if it
   is not, tell me to run the login myself - never ask me to paste a token.
5. Ask before running `loginctl enable-linger $USER`, which keeps the user service running after
   logout.
6. Report a checklist: each item ready, missing or needs me. Do not install the service: that needs
   the project's manifest, which prompt 2a or 2b writes.
````

### 2a. Set up the project's own workflow

````text
Make this repository a project managed by the Operator runtime, with a workflow of its own. The host
already has the runtime (prompt 1). Ask me one question at a time: say what you found, give two to
four options and recommend one, using the Operator repository's docs/patterns/ as the reference for
what each option decides.

Rules for the whole run: secrets live in the env file outside the repository and are never printed;
a public repository keeps its work queue private (the runtime's `operator queue`, never issues or
committed task files for findings); a change to the workflow never reaches a task in flight - a
pipeline branch runs the skills and rules it was created with; never force-push, never bypass branch
protection, never record a decision as mine that I did not make.

1. Research the repository and report a short table, changing nothing: default and integration
   branches, protection, merge method and branch prefixes; the CI workflows on a pull request, which
   checks are required and how long they take; test, build and typecheck commands; preview or QA
   environments and how a deployment names the head it serves; where work is queued and how an item
   says it is ready; the code host and where I make decisions; existing agent rules and skills.
2. Interview me until the workflow is fully specified: the phases and how a pull request shows its
   phase (milestones, labels or a tracker); the operations and the engine and placement of each;
   parallel slots (separate checkouts); the judges for review and verification and what happens when
   one is unavailable; QA admission; my signals (accept, hold, revalidate, reject, cancel); merge gates
   beyond required checks; the queue source and its ordering; notifications.
3. Write the workflow, which belongs to this repository from now on: `operator.yaml` (workflows,
   triggers, operations, pools), a discovery script that reads the code host and requests the next
   operation per pull request, with tests, and one skill per phase that does the work and writes the
   result file (contract 1). Create the labels and milestones I chose, the slot checkouts, and for
   herdr one workspace per slot; open the agent once in each so no trust prompt stops a run.
4. Validate and show me the results, enabling nothing: `operator validate --manifest operator.yaml
   --describe`; the discovery tests; `operator run --manifest operator.yaml --dry-run`, listing the
   requests discovery makes for the current pull requests and queue with the reason for each.
5. On my go: `operator service install <project> --manifest operator.yaml --env-file <env file>`,
   then report `operator service status <project>`.

Commit the workflow files through the repository's normal change process, with nothing secret in them.
````

### 2b. Adopt the recommended workflow from the development packs

````text
Make this repository a project managed by the Operator runtime using the recommended pull-request
workflow from the development packs, adapted to this repository. The host already has the runtime
(prompt 1). Ask me one question at a time: say what you found, give two to four options and
recommend one, using the Operator repository's docs/patterns/ as the reference.

Rules for the whole run: as in prompt 2a - secrets only in the env file and never printed, a public
repository's queue stays private, a change never reaches a task in flight, no force-push, no
bypassing branch protection, no decision recorded as mine that I did not make.

1. Intelligence is required. If the repository has no intelligence.yaml, install the intelligence
   CLI (`npm install --global @ainova-systems/intelligence@<version>`) and initialise it; otherwise
   install the version intelligence.yaml names in `schema_version`. Report `intelligence --version`.
2. Add the package `@ainova-systems/intelligence-dev-packs` to intelligence.yaml with the packs
   `core` and `operator` among its sources, then `intelligence sync` and report its status. Change
   pins only through intelligence's own update command, never by editing the lock or the installed
   package tree. (The `operator` pack is being published; if it is not available yet, report that
   and stop here.)
3. Research the repository as in prompt 2a step 1 and report the table, changing nothing.
4. Fill the gaps between the packs and this repository, asking me one question at a time:
   - the project profile the core pack reads (`dev-init` sets it up: branches, merge method, gates,
     labels, PR template);
   - the operator profile keys: `forge_cli` - the GitHub forge script the operator pack ships, or
     another code host's implementation of its contract; `operator_config` - the workflow
     configuration with phase and label names, slots, quotas, ready limit and the CI workflows that
     decide; `operator_discover`; and the project hooks `qa_status`, `qa_feedback` and
     `qa_feedback_status` when the repository has preview or QA environments;
   - the implementation skill the operator pack's Development phase runs (`flow_implement`) and the
     judge runner for review and verification;
   - project rules for whatever the research found that the packs do not cover.
   Write each as the repository's own rule or configuration file, never as an edit inside the
   installed packs.
5. Write `operator.yaml` (operations for intake, plan, implement, review, verify, merge and, if I
   want it, clarify; triggers; pools with one slot per checkout) and the discovery script built on
   the operator pack's helpers, with tests. Create the labels and milestones the packs use, the slot
   checkouts, and for herdr one workspace per slot; open the agent once in each.
6. Validate and show me the results, enabling nothing: `intelligence sync` reports ok;
   `operator validate --manifest operator.yaml --describe`; the operator pack's forge contract test
   against the configured `forge_cli`; the discovery tests; `operator run --manifest operator.yaml
   --dry-run`, listing the requests for the current pull requests and queue with the reason for each.
7. On my go: `operator service install <project> --manifest operator.yaml --env-file <env file>`,
   then report `operator service status <project>`.

Commit through the repository's normal change process. A newer pack version later is an ordinary
dependency update; branches already in flight keep the version they started with.
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
  `endSubjects` names subjects whose work is over: their per-subject tabs close and their sessions
  and Codex threads are forgotten; a result without it is read as before. Exit 0 without a valid
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
- **Pools.** `limit` pools are Ainoflow Guard semaphores (optionally shared across projects);
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
  waiting. An episode of use is logged once, and past `runtime.idleNudge` (30m when off) it is a
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
operator pause --wait [--reason text] [--timeout 2h]   # finish running jobs, start none; before a host restart
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
