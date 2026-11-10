# Changelog

## [Unreleased]

## [0.11.1] - 2026-11-10

- A task of a `fallback: claude` operation is no longer held to Codex by its own history: a started, retried or quota-limited review runs on Claude while Codex is in a usage-limit cooldown, and quota waits queued by an older daemon are decided again when the daemon starts.

## [0.11.0] - 2026-11-10

- A Codex agent operation with a schema may declare `fallback: claude`: while Codex is in a usage-limit cooldown, a new task runs once on Claude, without file-editing tools and limited to the project's own permission rules, with the same `output.json` and `then`.
- A result's `endSubjects` also ends the open waits of those subjects in its workflow (status `ended`), so a question on work that was closed no longer stays open forever.

## [0.10.2] - 2026-11-08

- Releases are published to npm through npm trusted publishing (GitHub Actions OIDC) with provenance; the release workflow no longer uses a stored npm token.
- A final release points npm's `next` dist-tag at itself unless `next` holds a newer release candidate, so `@ainova-systems/operator@next` no longer installs a stale release candidate.

## [0.10.1] - 2026-11-07

- A per-subject tab whose pane holds an agent session no run started, such as one herdr resumes after a restart, is closed and replaced by a new tab that continues the session, instead of receiving the next run's launch command as a prompt; herdr's `pane process-info` decides whether a pane is back at its shell.

## [0.10.0] - 2026-11-06

- One project runs on several hosts that share its state: a workspace names its `host`, a key with `count` declares a numbered group, and each host runs its own daemon over one job queue, starting only the jobs it can place and keeping its own provider cooldowns, `perHost` limit pools, herdr tabs and `operator pause`.

## [0.9.0] - 2026-11-05

- Usage limits keep attended Claude sessions open until reset, queue same-provider resumptions without spending retries, and allow explicitly compatible new tasks to use Codex during a persisted cooldown (four hours when no reset time is reported).

## [0.8.1]

- A leader lease whose renewal finds it gone is taken again instead of stopping the daemon; the daemon stops only when another daemon holds the lease.

## [0.8.0]

- `tabs: per-subject` keeps one herdr tab and claude session per subject and operation until a result names the subject in `endSubjects` (`operator tabs` lists them), resuming a session only while claude keeps its transcript, and no tab is closed, reused or has its session ended unless herdr reports its pane idle, done, gone or twice `unknown` - a kept `keepTab` session now ends when its tab closes (also for tabs an older daemon recorded) and stays open, with the owner notified, while its pane works or is blocked.
- Locks are given back only by their token (shortened to a second and left to lapse, then taken again within seconds when still needed, including by a daemon restarted on the same host), never deleted by key, another host's run is interrupted only after its lease stayed missing for six seconds, a lost workspace lease is reported once per job, `operator job`, `jobs`, `claim` and `state` no longer print any `token` field in any collection, and files holding tokens are owner-only.
- `operator claim` takes, renews and releases a compare-and-set lease on a subject, and `operator queue` keeps a private work queue with fixed status transitions, both in reserved state collections.

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
