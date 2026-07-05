# Deployment

Run the Operator engine as a single, always-on daemon container. The engine's
internal scheduler drives cycles on the configured interval; the supervisor
(Docker / Portainer) keeps it alive and delivers a graceful stop on redeploy.

## Artifacts

| File | Purpose |
|---|---|
| `Dockerfile` | Self-contained engine image — Node + git + gh + ripgrep + the agent CLIs (Claude Code + Cursor Agent). No external base image. |
| `docker-compose.yml` | Always-on `operator-engine` service (restart policy, graceful stop, state volume) + an opt-in `watchtower` profile for registry auto-poll. |
| `deploy.sh` | Push-based redeploy — pull a pinned image, recreate `operator-engine`, prune. Run by the deploy job and by hand on the VM. |
| `self-hosted-runner.md` | Sets up the operator's own VM to redeploy itself through a self-hosted runner. |
| `.env.example` | Environment template (image tag, log level, secrets). |
| `../.github/workflows/build-image.yml` | CI that builds + pushes the image to GHCR, then (on `master`) redeploys it via the self-hosted runner. |

## Invariants

- **Single writer.** SQLite is not multi-writer safe — never run two engine
  containers against the same volume. One container, `container_name:
  operator-engine`, never scaled.
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

The engine reads managed repos from `<config>/repos.yaml`. The compose file
points `--config` at `/var/lib/operator/config` on the state volume, so the
image stays free of instance data. Before first start, place your file at:

```
<operator-state volume>/config/repos.yaml
```

See `../config/repos.yaml.example` for the schema. `tokenEnvVar` in that file
must name an env var set on the container (default `MANAGED_REPO_GH_TOKEN`).

## Updates

CI publishes a fresh image on every push to `master` **and nightly** on a
`schedule:` cron — the nightly build runs with `no-cache` so the bundled agent
CLIs (Claude Code + Cursor Agent) re-fetch the latest upstream rather than
restoring the frozen install layers from cache. See "Keeping the agent CLIs
current" in `../docs/deployment.md`.

**The operator's own VM (self-improvement loop).** A second job in
`../.github/workflows/build-image.yml` runs on a self-hosted runner (label
`operator-deploy`) and, on `master` only, redeploys the freshly built image via
`deploy.sh` — so every merge and every nightly refresh reaches the running
daemon with no manual step. One-time VM setup is in `self-hosted-runner.md`.

**Manual / generic deployments (forks, Portainer).** No runner? Roll a new
image out yourself, or opt into registry auto-poll:

- **compose:** `docker compose -f deployment/docker-compose.yml pull && \
  docker compose -f deployment/docker-compose.yml up -d`.
- **Portainer:** pull the new image and recreate the stack (or bump
  `OPERATOR_IMAGE` to a `:<sha>` tag and redeploy). Roll back by redeploying a
  previous tag.
- **Watchtower:** start the opt-in profile to auto-poll GHCR and recreate the
  container when `:latest` changes —
  `docker compose -f deployment/docker-compose.yml --profile watchtower up -d`
  (scoped to `operator-engine` only).

Either way the supervisor sends `SIGTERM` to the old container first, so the
running cycle drains before the new image starts.
