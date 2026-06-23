---
name: intelligence-sync
description: "Sync intelligence to enabled IDE targets"
---

Run the sync engine to transform rules, agents, and skills from the intelligence source directory to each enabled IDE's native format.

> **Folder name:** `<intel>` is whatever holds your `config.yaml` — typically `intelligence/`, but may have been renamed (e.g. `Intelligence/`). The engine lives in the module subfolder `<intel>/sync/` and is self-locating, so any spelling works as long as you point bash at the right `sync/scripts/sync.sh` path.
>
> **sync.sh never migrates.** It is a pure synchronizer: on a pre-0.3.1 / non-modular layout or an un-applied schema it **fails closed** with `IS_STATUS=needs-update` (exit 6) and changes nothing. Migration is owned entirely by the `intelligence-update` flow — tell your agent *"Update intelligence-sync"* (or run `<intel>/sync/scripts/update.sh`) first, then re-run sync.

## Steps

1. Run `bash <intel>/sync/scripts/sync.sh` (where `<intel>` is your intelligence source folder; default `intelligence`).
2. Review the output — verify rule, agent, and skill counts per target.
3. If warnings about unsynced directories appear, add the missing paths to `<intel>/config.yaml` under `sources:`.
