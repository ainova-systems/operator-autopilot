---
name: intelligence-update
description: "Update intelligence-sync, then offer the one-way switch to the intelligence CLI - performed only on the user's explicit approval"
argument-hint: "[--yes]"
agent: intelligence-operator
---

# Update intelligence-sync

You are the **intelligent driver** of an update. The bash engine is
deterministic and fail-closed — it never guesses; on any state it cannot
resolve it prints `IS_STATUS=<code>` and stops. Your job: discover the engine,
understand what is changing (read the CHANGELOG across the version gap), run
the update, branch on the status, and **verify afterward**.

Trigger: the user says something like *"update / migrate intelligence-sync"*.
They never run shell commands by hand — you do.

> **This is the final line of the vendored engine.** It keeps working
> indefinitely and this repository stays at its URL, so nothing breaks by
> standing still. Development continues in the **intelligence CLI**, and
> section 7 below is the supported way across — one-way, and only ever with
> the user's explicit approval.

## Key facts

- **Umbrella** = whatever directory holds `config.yaml` (`intelligence/`,
  `Intelligence/`, …). Never assume the name — find it.
- **Engine = a module discovered by ROLE, not by name**: a directory under
  the umbrella whose `scripts/sync.sh` **and** `scripts/VERSION` both exist
  (conventionally `sync/`, but never assume the folder name).
- **Applied schema version** is the frozen contract key `sync_version` in
  `config.yaml` (a permanent top-level scalar; absent ⇒ pre-0.3.1).
  **Engine version** is `<module>/scripts/VERSION`. The gap between them is
  the set of breaking changes to apply.
- Pre-0.3.1 projects have the engine flat at `<umbrella>/scripts/` and **no**
  `sync_version` key. Their frozen `update.sh` fails closed against the
  modular upstream (changes nothing) — you bootstrap the first hop.
- **Already on the CLI** (a root `intelligence.yaml` exists, no vendored
  module): this skill does not apply. Run `intelligence update` there — it
  covers the CLI itself, the project's schema and the package ranges in one
  plan — and stop.
- The `intelligence-` skill prefix is **reserved** for upstream meta-skills.

## Steps

### 1. Locate the umbrella & discover the engine
Find the dir containing `config.yaml` → `<umbrella>`. Then find the engine by
role: search `<umbrella>` (one level deep) for a directory `<M>` with both
`<M>/scripts/sync.sh` and `<M>/scripts/VERSION`.

- Several candidates → pick the one with the highest `scripts/VERSION`.
- A module engine exists → use it; **never** fall back to a flat
  `<umbrella>/scripts/` even if present (that's stale legacy).
- No module engine, only flat `<umbrella>/scripts/` (or nothing) → this is a
  pre-0.3.1 / un-bootstrapped project; go to step 3a's bootstrap.
- No `config.yaml` at all → not bootstrapped; point the user at upstream
  `INIT.md` and stop.

### 2. Fetch upstream (read-only) — do NOT write into the project yet
Clone upstream into a temp dir (default
`https://github.com/ainova-systems/intelligence-sync`, or the user's
`REPO_URL`/fork). The upstream module is always `intelligence/sync/`.

```
git clone --depth=1 <repo> <tmp>
```

**Make no changes to the project before step 3's confirmation.** In
particular do not copy anything into `<umbrella>/sync` yet — that would
modify (and could downgrade) an already-modular project even if the user then
declines. The temp clone is only for reading the CHANGELOG and as the source
for the eventual write.

### 3. Understand what is changing (changelog-aware)
Determine the project's current version = the `sync_version` value in
`config.yaml`, or `0.0.0` if the key is absent (pre-0.3.1). The engine
version = `<tmp>/intelligence/sync/scripts/VERSION`.

Read `<tmp>/CHANGELOG.md`. For every release in the range
**`current < release <= engine`** (inclusive of the target release — its
entry holds the destination's breaking post-conditions), read its entry. Pay
special attention to any **`### Breaking`** subsection (the
machine-distinguishable marker). Build a short list of breaking items, new
migrations, and anything to verify afterward. Surface it to the user; without
`--yes`, let them confirm before any write.

### 3a. Ensure the engine to run (only now, post-confirmation)
- **Modular project** (a module engine was discovered in step 1): run *its*
  `update.sh` — at the discovered module dir, whatever its name. `update.sh`
  re-clones upstream internally, shows the diff, and is authoritative; do not
  hand-copy over the module.
- **No module engine** (pre-0.3.1 flat or un-bootstrapped): only here create
  the module from the temp clone, and only after confirmation:
  ```
  mkdir -p <umbrella>/sync
  cp -r <tmp>/intelligence/sync/. <umbrella>/sync/
  ```
  then run `<umbrella>/sync/scripts/update.sh`.

### 4. Run the engine

```
bash <engine-module>/scripts/update.sh --yes   # omit --yes to confirm the diff
```
Capture stdout; find the last `IS_STATUS=<code> [IS_DETAIL=...]` line.

### 5. Branch on `IS_STATUS`

| Code | Meaning | Action |
|---|---|---|
| `ok` | Already current | Go to step 6. |
| `migrated` | Migration chain applied | Go to step 6; note the relocation/changes. |
| `aborted-incomplete` | Staged module incomplete; legacy intact (safe) | Re-run step 2–4 once (clone hiccup). Persists → show output, stop, don't hand-fix. |
| `ahead-of-engine` | Project schema newer than this engine | Do **not** downgrade. Point `REPO_URL` at the correct/newer upstream, or accept it's already ahead. Stop. |
| `needs-update` | Pending breaking changes (sync refused) | Expected pre-migration; proceed — `update.sh` is the migrator. If it persists *after* update, investigate. |
| `config-missing` | No `config.yaml` | Not bootstrapped — direct user to `<umbrella>/sync/INIT.md`. Stop. |
| `error` | Engine couldn't proceed | Show message; check `REPO_URL`. Stop. |
| *(no status)* | Engine crashed before contract | Show full output; don't modify the tree. Stop. |

On any failure code, first re-read the upstream `CHANGELOG.md` entries for
`current < release <= engine` (esp. `### Breaking`) — the breaking change
usually explains the error and what the user must do — before retrying or
escalating.

Genuinely **ambiguous** tree (e.g. both a legacy flat `<umbrella>/scripts/`
and a populated module, no clear `sync_version`): inspect both, summarize the
difference, ask the user which is authoritative, apply their choice. Never
guess.

### 6. Verify (always, after `ok`/`migrated`)

Structural — always:
- No `intelligence-*` directory directly under `<umbrella>/skills/`
  (meta-skills live only in the module's `skills/`).
- Project content intact: `<umbrella>/{rules,agents}/` and any
  non-`intelligence-` skills untouched.
- `config.yaml` has `sync_version` equal to the engine `scripts/VERSION`, and
  `sources.skills` includes the module skills path exactly once.

Changelog-driven — per release crossed:
- For each **`### Breaking`** item in the crossed range, verify its stated
  post-condition actually holds (e.g. a removed/renamed file is gone, a
  config-schema change is reflected). If a breaking item has no verifiable
  post-condition, state that you could not auto-verify it.

Then regenerate IDE outputs:
```
bash <umbrella>/sync/scripts/sync.sh
```
Relay any model-drift report. Summarize: versions before→after, the breaking
changes applied, verification result, anything the user must act on. Clean up
the temp clone. **Do not end with a passive sentence saying only that CLI
migration was not performed or needs separate approval.** Continue through
step 7 and make the migration offer actionable.

### 7. Offer the switch to the intelligence CLI — approval required

Only after step 6 reports a healthy project. The switch is **one-way** and
rewrites the project's layout, so it happens only when the user says so in
this conversation.

**7a. Check what the CLI publishes.**

```
npm view @ainova-systems/intelligence dist-tags --json
```

- A stable `latest` (a version with **no** suffix after a `-`) ⇒ proceed with
  `@latest`.
- Only a prerelease (`-rc.N`, `-beta`, …) ⇒ the CLI is not generally available
  yet. Say so in one line, state that the vendored setup keeps working, and
  **stop** — unless the user has explicitly asked for the release candidate in
  this conversation, in which case proceed with `@next` and name it as a
  release candidate every time you mention it. Never put a prerelease on a
  project on your own initiative.
- The command fails (offline, npm unreachable) ⇒ report and stop.

**7b. Describe what would change, then ask.** Present it plainly:

- `config.yaml` becomes `intelligence.yaml` at the repository root.
- Declared `packs:` become `packages:`, keeping their pins; mirrored pack
  content is *copied* into a gitignored `.intelligence/` store, not refetched.
- `intelligence.lock` is created and should be committed.
- The vendored engine directory and the pack mirrors are deleted — the engine
  ships inside the npm package from then on.
- Updates stop going through this skill: one `intelligence update` covers the
  CLI, the project's schema and its package ranges.

Then ask for an explicit yes. **`--yes` does not cover this** — that flag only
skips the diff confirmation in step 3, never this decision. No answer, a
hedged answer, or anything short of clear approval ⇒ do not proceed; leave the
project on the vendored setup and say it can be done any time.

The offer must name the successor, show where it lives and make the next action
unmistakable. Use this shape (with the resolved stable/prerelease tag from 7a):

> Intelligence Sync is now the archived vendored line. Its supported successor
> is the [Intelligence CLI](https://github.com/ainova-systems/intelligence).
> Install it with `npm install -g @ainova-systems/intelligence@latest`.
> I can start the migration now by running `intelligence init --preview`; this
> writes nothing and shows the complete one-way conversion plan. Would you like
> me to install the CLI and run that preview now?

Do not replace that question with "migration was not performed", "requires
separate approval", or another status-only closing line. The user must be able
to answer **yes** without having to discover another command or prompt.

**7c. Preconditions.** The working tree must be clean (`git status
--porcelain` empty) — conversion refuses otherwise, and the point is a single
reviewable commit. If it is dirty, ask the user to commit or stash; never pass
`--force` on their behalf.

**7d. Install and preview.** `intelligence init` is the universal entry point:
in an archived v1 project it *is* the conversion, and `--preview` stages and
verifies the whole thing while writing nothing to the project.

```
npm i -g @ainova-systems/intelligence@latest    # or @next, only if 7a said so
intelligence --version
intelligence init --preview
```

Show the user the manifest it printed and any warning it raised. If it fails,
stop and report — the project is untouched and still works.

**7e. Confirm once more, then convert.**

```
intelligence init --apply
```

`--apply` converts without a second interactive prompt, which is correct here
because the user has just approved the previewed plan. It is transactional:
the vendored engine, `config.yaml` and the mirrors are replaced only after the
staged state verified and a real sync of it succeeded. Any earlier failure
leaves the project untouched.

**7f. Verify the new setup.**

```
intelligence status --check
intelligence sync
```

`status --check` must exit 0 — it is the deep consistency pass (manifest/lock
agreement, package content, SHA drift, stale schema, invalid sources). Confirm
`intelligence.yaml` and `intelligence.lock` exist at the root, `.intelligence/`
is gitignored, the vendored module is gone, and the generated outputs still
contain the project's own rules and skills. Tell the user to review and commit
the single diff, and that from here on updating is `intelligence update` —
this skill is no longer part of the project.

## Notes

- Everything in steps 1–6 is **idempotent**. Re-running on a current project
  is a safe no-op (`IS_STATUS=ok`).
- Correctness rests on the engine's idempotent structural preconditions, not
  on the version stamp — a missing/wrong `sync_version` cannot cause a needed
  migration to be skipped; it only weakens the `ahead-of-engine` guard until
  re-stamped.
- Never touch `config.yaml` beyond what the engine does (the idempotent
  `sources.skills` line and the `sync_version` key). Never move/delete project
  skills, rules, or agents.
- Sibling modules beside the engine module are independent — only operate on
  the discovered engine module.
- The switch in step 7 needs the project at the final vendored schema, which
  steps 3–5 have just guaranteed. That is why it is offered here and not as a
  standalone action.
