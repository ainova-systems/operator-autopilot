#!/usr/bin/env bash
#
# Push-based redeploy of the always-on operator-engine daemon.
#
# Runs on the self-hosted runner (label `operator-deploy`) from
# ../.github/workflows/build-image.yml right after a fresh image is published to
# GHCR, and by hand on the VM for a manual rollout or rollback. Idempotent:
# pull the target image, recreate ONLY operator-engine, prune dangling layers.
#
# The runner must NOT belong to the `operator` compose project — `up -d` would
# otherwise recreate the runner mid-job. Keep it in its own stack / systemd unit.
#
# Required:
#   OPERATOR_IMAGE        full image ref to roll out, e.g.
#                         ghcr.io/<owner>/<repo>/operator-engine:<sha>
# Optional:
#   OPERATOR_ENV_FILE     runtime secrets file (default /opt/operator/.env) —
#                         holds MANAGED_REPO_GH_TOKEN / ANTHROPIC_API_KEY /
#                         CURSOR_API_KEY
#   COMPOSE_PROJECT_NAME  compose project (default operator) — pins the state
#                         volume name so it survives every recreate
#
# Manual rollback:
#   OPERATOR_IMAGE=ghcr.io/<owner>/<repo>/operator-engine:<old-sha> \
#     bash deployment/deploy.sh
#
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
compose_file="${COMPOSE_FILE:-$here/docker-compose.yml}"
env_file="${OPERATOR_ENV_FILE:-/opt/operator/.env}"
project="${COMPOSE_PROJECT_NAME:-operator}"

if [[ -z "${OPERATOR_IMAGE:-}" ]]; then
  echo "deploy: OPERATOR_IMAGE is required (e.g. ghcr.io/<owner>/<repo>/operator-engine:<sha>)" >&2
  exit 1
fi
if [[ ! -f "$env_file" ]]; then
  echo "deploy: runtime env file not found: $env_file" >&2
  echo "deploy: create it from deployment/.env.example (chmod 600); it holds the operator secrets." >&2
  exit 1
fi

export OPERATOR_IMAGE
echo "deploy: rolling out $OPERATOR_IMAGE (project=$project)"

compose=(docker compose -p "$project" -f "$compose_file" --env-file "$env_file")

"${compose[@]}" pull operator-engine
# Recreate only the daemon; SIGTERM drains the in-flight cycle within
# stop_grace_period before the new image starts (see docker-compose.yml).
"${compose[@]}" up -d operator-engine
# Reclaim the layers the superseded image left behind.
docker image prune -f >/dev/null

echo "deploy: operator-engine is now running $OPERATOR_IMAGE"
