---
name: intelligence-uninstall-adapter
description: "Disable IDE adapter and clean up output"
argument-hint: <target-name>
---

# Uninstall Adapter

## Steps

1. Set `enabled: false` for the target in `intelligence/config.yaml`
2. Remove the generated output directory (e.g., `.cursor/`, `.codex/`)
3. Remove the output directory from `.gitignore` if no longer needed
4. Run `intelligence/sync/scripts/sync.sh` to verify remaining targets
5. Report: adapter disabled, output removed
