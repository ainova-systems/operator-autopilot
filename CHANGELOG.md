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
- Published as the npm package `@ainova-systems/operator` and the image
  `ghcr.io/ainova-systems/operator-autopilot/operator`.

Releases up to 0.6.0 were the previous engine; their notes are in this file at tag `v0.6.0`.
