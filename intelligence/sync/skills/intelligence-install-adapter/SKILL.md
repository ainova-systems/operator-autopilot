---
name: intelligence-install-adapter
description: "Enable IDE adapter for intelligence-sync"
argument-hint: <target-name>
---

# Install Adapter

## Steps

1. Check if target `$ARGUMENTS` is already enabled in `intelligence/config.yaml` — if yes, report and stop
2. Check if adapter exists in `intelligence/sync/scripts/adapters/$ARGUMENTS.sh`
   - If not, research the IDE's prompt format via web search and create adapter using `_template.sh` as reference
3. Update `intelligence/config.yaml`:
   - If target exists with `enabled: false` — change to `enabled: true`
   - If target missing — add under `targets:`
4. Add output directory to `.gitignore` if not already present
5. Run `/intelligence-sync` to generate output
6. Report: adapter enabled, files generated, output location
