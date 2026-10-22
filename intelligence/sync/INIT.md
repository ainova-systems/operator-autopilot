# Intelligence Sync is archived: move to the Intelligence CLI

This file belongs to the final vendored Intelligence Sync release. **Do not bootstrap a new project by copying this engine.** The supported product is the [Intelligence CLI](https://github.com/ainova-systems/intelligence).

Current legacy engine contract: `sync_version: "0.10.4"`.

Your job is to identify the project state, explain the safe CLI migration and actively offer to preview it. Do not manually rewrite the legacy layout or delete the vendored engine.

## 1. Detect project state

From the repository root:

- Root `intelligence.yaml` exists: this is already an Intelligence CLI project. Run `intelligence status --check`; do not use the legacy engine.
- A directory contains `config.yaml` plus `sync/scripts/sync.sh`: this is a modular legacy Intelligence Sync project.
- A directory contains `config.yaml` plus `scripts/sync.sh`: this is a pre-0.3.1 flat legacy project.
- None of the above: initialize a new CLI project with `intelligence init`, not by copying this repository.

The legacy source directory may have any name or casing. Discover it by structure; never assume it is literally `intelligence/`.

## 2. Install the stable CLI

Requirements: Node.js 18+, Git, Bash and awk. On Windows, use Git Bash or WSL.

```bash
npm install -g @ainova-systems/intelligence@latest
intelligence --version
```

If npm or the network is unavailable, report that clearly and leave the working legacy project untouched.

## 3. Preview conversion

The working tree must be clean before conversion. If `git status --porcelain` reports changes, ask the user to commit or stash them; never pass `--force` on the user's behalf.

Run:

```bash
intelligence init --preview
```

Preview writes nothing. Show the user the proposed manifest, package and adapter changes plus every warning.

If preview reports that the legacy schema is older than `0.10.0`, update the discovered vendored engine first:

```bash
bash <legacy-module>/scripts/update.sh --yes
bash <legacy-module>/scripts/sync.sh
```

For the conventional modular layout, `<legacy-module>` is `intelligence/sync`; for a flat pre-0.3.1 layout, run its existing `intelligence/scripts/update.sh`. Re-run `intelligence init --preview` only after the project reaches the final vendored release.

## 4. Ask before applying

Do not end with a passive statement such as "migration was not performed" or "requires separate approval". Make the next action explicit:

> Intelligence Sync is now the archived vendored line. Its supported successor is the [Intelligence CLI](https://github.com/ainova-systems/intelligence). Install it with `npm install -g @ainova-systems/intelligence@latest`. I can run `intelligence init --preview` now to show the complete one-way conversion plan without writing anything. Would you like me to proceed?

Preview itself is read-only. Applying the one-way layout conversion still requires the user's explicit approval after they see the plan.

## 5. Apply and verify

After explicit approval:

```bash
intelligence init --apply
intelligence status --check
intelligence sync
```

Done means:

- root `intelligence.yaml` and `intelligence.lock` exist;
- `.intelligence/` is gitignored;
- the vendored engine and nested legacy `config.yaml` are gone;
- project-owned rules, agents, skills and adapters remain;
- generated outputs still contain the project's content;
- `intelligence status --check` exits successfully.

Tell the user to review and commit the single conversion diff. Future updates use `intelligence update`; never reinstall the archived vendored engine.

## New projects

For a repository with no Intelligence setup:

```bash
npm install -g @ainova-systems/intelligence@latest
intelligence init --targets claude,codex
```

Choose targets based on the tools actually used by the project. Continue onboarding with the instructions printed by the CLI and the current [Intelligence documentation](https://github.com/ainova-systems/intelligence#readme).
