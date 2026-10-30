# Changelog

## [Unreleased]

- `tabs: per-subject` keeps one herdr tab and claude session per subject and operation until a result names the subject in `endSubjects` (`operator tabs` lists them), resuming a session only while claude keeps its transcript, and no tab is closed, reused or has its session ended unless herdr reports its pane idle, done, gone or twice `unknown` - a kept `keepTab` session now ends when its tab closes (also for tabs an older daemon recorded) and stays open, with the owner notified, while its pane works or is blocked.

## [0.7.0]

- Replaced the previous closed-loop engine with a small generic runtime: a YAML
  manifest of workflows, triggers, operations and pools; a versioned operation contract; state in
  Ainoflow (Storage, Shield, Guard); headless or herdr placement; crash-safe runs; and the
  `operator` CLI (`validate`, `run`, `trigger`, `enqueue`, `jobs`, `waits`, `state`).
- Operation kinds `script`, `agent` and `interactive`: an interactive run is a session a person
  can attend in a herdr tab, ended by its wrapper once its result file is written, and run as an
  agent when no terminal is reachable. `notify` names the final result statuses that raise an
  owner notification.
- A `next` request or a `wait` may name the workspace `member` its operation runs in; an operation
  may hold a `limit` pool alongside its `pool`, and `access: read` shares a member without holding it.
  A follow-on in the same workspace pool stays in its run's member, which the input file names.
- `keepTab` keeps a herdr run's tab, and an interactive session in it, open for a set time after its
  result, without holding the pipeline back; a `noop` run keeps none.
- `operator pause` starts no new job and fires no timer while running jobs finish; `--wait` returns,
  and the daemon logs and notifies the owner, once none runs. `operator resume` ends it, and so does
  the service starting again.
- `operator service install|uninstall|status <project>` runs the daemon as the systemd user service
  `operator@<project>`: install writes the unit and a private env file and enables it, uninstall
  stops it and keeps the env file. A host without systemd is refused before anything is written.
- An interactive session idle in herdr for `runtime.idleNudge` (default 20m) without a result is asked
  to write its result or say what it waits for; after two nudges the owner is notified once.
- Published as the npm package `@ainova-systems/operator` and the image
  `ghcr.io/ainova-systems/operator-autopilot/operator`.

Releases up to 0.6.0 were the previous engine; their notes are in this file at tag `v0.6.0`.
