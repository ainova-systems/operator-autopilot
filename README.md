# Operator

A small, generic runtime that runs a project's workflow operations - deterministic scripts and
agent CLIs (Claude Code, Codex) - on timers and named triggers, keeps its state in
[Ainoflow](https://ainoflow.io), and can place agent runs in [herdr](https://herdr.dev) tabs so a
person sees them working.

The runtime knows operations, triggers, pools, state and delivery. It does not know milestones,
labels, pull requests or merge rules: those live in the project's own scripts and skills, which
return a small versioned result and may request the next operation.

## How it works

```text
timer / trigger ─▶ job (deduped) ─▶ pool slot ─▶ run: script or agent, headless or in a herdr tab
                                                     │
                       next operations / a wait ◀── result file (contract 1)
```

- **Manifest** (`orchestrator.yaml`, next to the project's sources) names workflows, their triggers
  (`every`, `cron`, `on`), operations and pools.
- **Contract 1.** Every run gets an input file (`$OPERATOR_INPUT`) and writes one result file
  (`$OPERATOR_RESULT`): `status` is `done | noop | waiting | needs-input | failed`, with `evidence`,
  `next` requests and, for a question, a `wait` that a later `operator trigger` resumes. Exit 0
  without a valid result is a failure.
- **Dedupe, not exactly-once.** A job's id is derived from (workflow, operation, subject, trigger
  id); the same trigger twice is one job. Operations re-read live state before acting.
- **Crash safety.** A run's wrapper is detached from the daemon and leaves a heartbeat and
  `exit.json` in its run directory. A restarted daemon adopts running jobs instead of starting them
  again, and re-runs a job whose wrapper died.
- **Exclusive operations.** `exclusive: true` keeps an operation - typically discovery - to one run
  at a time, so a timer slot and a manual trigger cannot both take the same work.
- **Pools.** `limit` pools are Ainoflow Guard semaphores (optionally shared across projects);
  `workspaces` pools hand out named working directories, each held by a renewable Shield lease.
- **herdr.** `placement: herdr` opens a tab of the runtime's own in the target workspace and runs the
  wrapper there. Screen state is only a hint; a `blocked` agent raises a notification and is never
  answered by the runtime. Without herdr the run degrades to headless and the job record says so.
  A tab herdr cannot close when its run ends is closed on a later poll; one closed by hand counts
  as closed.

## Use

```bash
npm install --global @ainova-systems/operator   # or: npm install && npm run build
operator validate --manifest orchestrator.yaml  # manifest, scripts (--describe), skills, schemas, state
operator run --manifest orchestrator.yaml       # the daemon; one active daemon per project
operator run --dry-run                          # scripts run, agents are only logged, local state
operator trigger <workflow> <name> --subject pr-7 --key q-1 --input '{"answer":"yes"}'
operator jobs [--status queued]  |  operator job <id>  |  operator waits
operator state get|put|list|delete <collection> [key]   # project state for scripts and skills
```

`AINOFLOW_API_KEY` comes from the environment, or from the manifest's `envFile` /
`OPERATOR_ENV_FILE` (`envKeys` / `OPERATOR_ENV_KEYS` limit what is taken). The file state provider is
for tests and dry runs only.

`deploy/systemd/operator@.service` runs the daemon as a user service. `fixtures/demo` is a complete
example project: a discovery script, a stand-in agent placed in a herdr tab, a follow-on step and a
question answered through a trigger.

## Develop

```bash
npm ci
npm run typecheck
npm test            # unit and integration tests; live Ainoflow tests run when AINOFLOW_API_KEY is set
npm run test:pack   # packs the package, installs it into an empty directory and runs the CLI
```

Node 24 or newer. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
