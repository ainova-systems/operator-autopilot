# Deployment

Run the Operator engine as a single, always-on daemon container, with the
observability + setup UI alongside it. The engine's internal scheduler drives
cycles on the configured interval; the supervisor (Docker / Portainer) keeps it
alive and delivers a graceful stop on redeploy.

## Artifacts

| File | Purpose |
|---|---|
| `Dockerfile` | Self-contained image — Node + git + gh + ripgrep + the agent CLIs (Claude Code + Cursor Agent) + a pre-built Next.js app. No external base image. |
| `docker-compose.yml` | Always-on `operator-engine` service (restart policy, graceful stop, state volume), the `operator-app` UI on loopback:3000, and an opt-in `watchtower` profile for registry auto-poll. |
| `deploy.sh` | Manual rollout and rollback — pull a pinned image, recreate `operator-engine` and `operator-app`, prune. Run by hand on the host. |
| `.env.example` | Environment template (image tag, log level, secrets). |
| `../.github/workflows/build-image.yml` | CI that builds and pushes the image to GHCR. It publishes; it does not deploy. |

## Invariants

- **Single writer.** SQLite is not multi-writer safe — never run two engine
  containers against the same volume. One container, `container_name:
  operator-engine`, never scaled. `operator-app` shares the volume but is
  read-mostly: it writes only on a config edit or a completed setup step, and
  WAL mode serialises those against the engine.
- **The UI is unauthenticated.** `operator-app` edits engine configuration, so
  compose publishes it on `127.0.0.1` only. Reach it through an SSH tunnel, or
  set `OPERATOR_APP_BIND` once an authenticating reverse proxy is in front.
- **State on a volume.** `operator-state` holds the SQLite DB, KV, and managed
  workspaces. It must survive container recreate; without it every restart is
  a cold, empty database.
- **Graceful stop.** `SIGTERM` drains the in-flight cycle, then exits — agents
  are never killed mid-PR-transition. A hard kill (SIGKILL past the grace
  window, OOM, host crash) is still safe: boot reconciliation finalizes stale
  locks / labels / executions on the next start.

## Local / VM

```bash
cp deployment/.env.example deployment/.env   # fill in secrets
docker compose -f deployment/docker-compose.yml up -d --build

# Then register the first managed repository at http://localhost:3000/setup
docker logs -f operator-engine
```

## Portainer

1. **Stacks → Add stack →** name `operator-engine`.
2. Paste `docker-compose.yml`. Remove the `build:` block and set
   `OPERATOR_IMAGE` to a pushed tag (Portainer pulls, it does not build):
   `image: ghcr.io/<owner>/<repo>/operator-engine:latest`.
3. Add the environment variables from `.env.example` (secrets included).
4. **Deploy.** The stack owns the lifecycle; restart from the Portainer UI.

## Instance config

Two equivalent ways to register a managed repository — both end as the same
`kv:repos/*` row on the state volume:

- **The setup screen** (`http://localhost:3000/setup`) — no file, no restart.
  The row it writes is owned by the UI, so the seed mirror below leaves it
  alone on every subsequent start.
- **`repos.yaml`** — for a host provisioned by configuration management. The
  compose file points `--config` at `/var/lib/operator/config` on the state
  volume, so the image stays free of instance data. Place your file at
  `<operator-state volume>/config/repos.yaml` before first start; see
  `../config/repos.yaml.example` for the schema.

Either way, `tokenEnvVar` must name an env var set on the container (default
`MANAGED_REPO_GH_TOKEN`).

## Updates

CI publishes a fresh image on every push to `master` **and nightly** on a
`schedule:` cron — the nightly build runs with `no-cache` so the bundled agent
CLIs (Claude Code + Cursor Agent) re-fetch the latest upstream rather than
restoring the frozen install layers from cache. See "Keeping the agent CLIs
current" in `../docs/deployment.md`.

**Publishing is where CI stops.** No workflow reaches into a running
deployment, and there is no self-hosted runner in this pipeline. A host decides
for itself when to take a new image, which keeps the deployment story the same
for this project's own instance, a fork, and a customer VM.

Three ways to take one:

- **By hand:** `docker compose -f deployment/docker-compose.yml pull &&   docker compose -f deployment/docker-compose.yml up -d`, or `deploy.sh` with a
  pinned tag (below).
- **Watchtower:** the opt-in profile auto-polls GHCR and recreates the
  containers when `:latest` changes —
  `docker compose -f deployment/docker-compose.yml --profile watchtower up -d`.
  This is the low-effort choice for an always-on host.
- **Portainer:** pull the new image and recreate the stack, or bump
  `OPERATOR_IMAGE` to a `:<sha>` tag and redeploy.

Either way the supervisor sends `SIGTERM` to the old container first, so the
running cycle drains before the new image starts.

## Host setup for an always-on instance

Beyond the compose file, a long-lived host needs three things in place once.

**1. Runtime secrets.** `deploy.sh` reads them from `OPERATOR_ENV_FILE`,
default `/opt/operator/.env`. Point it anywhere the operating identity can read
at mode `0600` — a path inside its own home is fine and needs no root:

```bash
install -d -m 750 ~/.config/operator
cp deployment/.env.example ~/.config/operator/operator.env
chmod 600 ~/.config/operator/operator.env
# edit it — MANAGED_REPO_GH_TOKEN, ANTHROPIC_API_KEY, CURSOR_API_KEY
export OPERATOR_ENV_FILE=~/.config/operator/operator.env
```

Leave `OPERATOR_IMAGE` unset in that file; pass it per rollout instead.

**2. Instance config on the state volume.** The daemon reads managed repos from
`--config /var/lib/operator/config`. Either complete `/setup` in the UI after
the first start, or seed the file before it:

```bash
docker volume create operator_operator-state
docker run --rm -v operator_operator-state:/state -v "$PWD/config":/src:ro   busybox sh -c 'mkdir -p /state/config && cp /src/repos.yaml /state/config/repos.yaml'
```

The volume is named `operator_operator-state` because the compose project is
pinned to `operator`. Keep that project name for every manual command, or the
daemon comes up against an empty database.

**3. A pinned first rollout**, so the same command also serves as rollback:

```bash
OPERATOR_IMAGE=ghcr.io/<owner>/<repo>/operator-engine:<sha>   bash deployment/deploy.sh
```

Roll back by re-running it with an earlier `:<sha>` (prior tags are under the
repository's **Packages**). The daemon drains the current cycle on `SIGTERM`
before the swap, and boot reconciliation heals anything a hard kill
interrupted — a rollback is safe between cycles.
