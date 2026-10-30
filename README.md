# Operator

A small, generic runtime that runs a project's workflow operations - deterministic scripts and
agent CLIs (Claude Code, Codex) - on timers and named triggers, keeps its state in
[Ainoflow](https://ainoflow.io), and can place runs in [herdr](https://herdr.dev) tabs so a person
sees them working, or attends an interactive session there.

The runtime knows operations, triggers, pools, state and delivery. It does not know milestones,
labels, pull requests or merge rules: those live in the project's own scripts and skills, which
return a small versioned result and may request the next operation.

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
  the next run. A session is resumed when claude has its transcript
  (`<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<cwd as letters, digits and dashes>/<id>.jsonl`), however
  its last run ended; without one - its first run never got to start it - it starts new under the
  same id. A session kept after its result no longer has a timeout. `keepTab` applies to per-job tabs
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
  warning and one owner notification, sent again on later polls until herdr delivers it. A pane left
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
