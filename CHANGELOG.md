# Changelog

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
  result, without holding the pipeline back.
- Published as the npm package `@ainova-systems/operator` and the image
  `ghcr.io/ainova-systems/operator-autopilot/operator`.

Releases up to 0.6.0 were the previous engine; their notes are in this file at tag `v0.6.0`.
