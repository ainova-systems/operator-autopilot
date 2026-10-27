# Operator (ainova-systems/operator-autopilot)

A small, generic runtime: it runs a project's operations - scripts and agent CLIs -
on timers and named triggers, with its state in Ainoflow, optionally placing runs in herdr tabs.
Published as `@ainova-systems/operator` with the `operator` CLI.

**The boundary is the design.** The runtime knows operations, triggers, pools, state and delivery.
It does not know milestones, labels, pull requests, review, merge or release: a project's own
scripts and skills decide those and return a contract result. Adding a workflow is a manifest
change in that project, never a runtime change. A feature that needs the runtime to understand a
project's process is in the wrong repository.

## Layout

```
src/
  cli.ts          the operator CLI (validate, run, trigger, enqueue, jobs, job, waits, state, job-exec)
  manifest.ts     operator.yaml: workflows, triggers (every/cron/on), operations, pools; all problems at once
  contract.ts     contract 1: the input file every run gets, the result file it writes back
  daemon.ts       leader lease, timers, dispatch into pools, observe runs, collect results, restart adoption
  triggers.ts     timer slots and named triggers (resume a wait, else the workflow's `on:` trigger)
  jobs.ts waits.ts job and wait records; job ids are dedupe keys (workflow, operation, subject, trigger id)
  pools.ts        limit pools on Guard, workspace pools on renewable Shield leases
  launch.ts job-exec.ts runfiles.ts   run directory, detached wrapper, heartbeat and exit.json
  collect.ts      exit + result file -> contract result (Codex output -> result via `then`)
  engines.ts      argv for command / claude -p, or a claude session when attended / codex exec (resume per subject)
  herdr.ts        the herdr CLI calls: own tab, metadata, run, close, status, notification
  state/          one interface; ainoflow.ts (HTTP) and file.ts (tests and dry runs only)
fixtures/demo/    a complete example project used by tests and the live demo
deploy/systemd/   operator@<project>.service
```

## Invariants

- A duplicate trigger is one job: the create-only write of a deterministic job id is the dedupe.
- Exit 0 without a valid result file is a failure. Business success is the operation's evidence,
  never the runtime's inference.
- A run is collected from its run directory, never from screen state. A restarted daemon adopts a
  live run and re-runs one whose wrapper died; it never starts the same attempt twice.
- The runtime never answers an agent prompt; a `blocked` pane raises a notification.
- An interactive run is collected like any other: its result file is the proof. The wrapper ends the
  session after that file is written, because the slot goes to the next run; the terminal is where
  it runs, never how its end is decided.
- The file state driver is for tests and dry runs; a live daemon refuses it unless told explicitly.
- Every Ainoflow feature the runtime relies on is checked through `/api/v1/capabilities` at start.

## Conventions

- TypeScript with erasable syntax only (`erasableSyntaxOnly`): Node runs `src/*.ts` directly in
  tests, `npm run build` emits `dist/`. Relative imports carry the `.ts` extension.
- Named exports and imports only. Errors are `OperatorError` with a stable `code`.
- Log lines are `<iso> <LEVEL> <message> key=value ...`; every externally visible action and every
  decision (queued, started, interrupted, finished, why) has an INFO line.
- Tests are colocated `*.test.ts` on `node:test`; integration tests use the file driver, real
  temporary directories and real processes (a crash test kills a real daemon).
- Dependencies stay minimal: `yaml` at runtime; `typescript` and `@types/node` for development.

## Commands

```bash
npm ci
npm run typecheck
npm test
npm run test:pack
node src/cli.ts validate --manifest fixtures/demo/operator.yaml --offline
```
