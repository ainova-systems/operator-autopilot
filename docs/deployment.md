# Operator Deployment

Operator is local-first: SQLite + filesystem + one agent API key is enough to run the closed loop. Production deployments add a supervisor (systemd / Docker / Kubernetes) but the engine code and the state layout are identical in every runtime. Pick the section that matches your environment.

**Start here in every runtime: `http://localhost:3000/setup`.** The setup screen creates the engine's state database, checks the host for git, the agent CLIs, and a working git-host token, registers the first managed repository, and prints the command that runs the first cycle. It writes through the same validated endpoints as the rest of the UI, so a repository added there and a repository added in `config/repos.yaml` end up as the same `kv:repos/*` row — the file remains a perfectly good alternative for provisioning a host from configuration management.

## Prerequisites

- **Node.js 24+** (`package.json` `engines` requires `>=24.0.0`; the Docker image uses `node:24`).
- **git 2.40+** on `$PATH` — the engine shells out to `git` inside managed workspaces.
- **The agent CLIs configured in `engine/content/defaults/agents.yaml`**, reachable from `$PATH` (or a pinned absolute path). The shipped config uses **two** providers: `claude` (Claude Code — analysis/review roles) and `cursor` (`cursor-agent` — the code-writing roles `creator`/`improver`/`supervisor`, on the Composer model). A single-provider deployment only needs one CLI.
- **ripgrep (`rg`)** on `$PATH` if the `cursor` provider is used — `cursor-agent` shells out to `rg` and refuses to run without it.
- **One VCS token** with repo-scoped permissions. Set the env-var named by `repos.yaml:vcs.tokenEnvVar` — the field is required (no default); the example config and compose file use `MANAGED_REPO_GH_TOKEN`.
- **Disk** for per-repo workspaces under `$WORKSPACE_BASE_DIR` (each managed repo gets one clone).

## Environment variables

| Variable | Default | Role |
|---|---|---|
| `OPERATOR_DIR` | `.` (repo root when developing) | Location of `config/repos.yaml` + seed baselines |
| `WORKSPACE_BASE_DIR` | `$OPERATOR_DIR/repos` | Parent directory for per-repo clones (matches the `repos` KV category) |
| `OPERATOR_DB_PATH` | `$OPERATOR_DIR/state/operator.db` | SQLite file backing `LocalStorageBundle` (KV + Guard + RateLimiter) |
| `OPERATOR_APP_DB_PATH` | `envPaths('operator-app').config/app.db` | SQLite file backing the Next.js app's connections + app-state |
| `WORKSPACE_OVERRIDE` | unset | Point at an existing checkout; engine refuses to run on a dirty workspace |
| `LOG_LEVEL` | `info` | `info`, `debug`, or `warn` |
| `MANAGED_REPO_GH_TOKEN` (whatever each repo's `tokenEnvVar` names) | — | VCS API token, scoped to the repos declared in `config/repos.yaml` |
| `ANTHROPIC_API_KEY` (or `CLAUDE_CODE_OAUTH_TOKEN`) | — | Claude Code auth — analysis/review roles |
| `CURSOR_API_KEY` | — | Cursor Agent auth — code-writing roles (required by the shipped `agents.yaml`); or run `cursor-agent login` once on the host |
| other agent-provider keys | — | Names come from `engine/content/defaults/agents.yaml` |

Never commit `.env` files. The engine and app load env-vars through `node --env-file=.env.local` at dev time; production runtimes inject them through the supervisor.

## Runtime modes

- **One-shot** — `npx tsx --env-file=.env.local engine/entry.ts --once --repo <id>`. Runs one cycle, exits non-zero on failure. Good for CI smoke tests and cron-style scheduling.
- **Daemon** — `npx tsx --env-file=.env.local engine/entry.ts`. Runs the full cycle loop on the interval configured in `engine-defaults/global.cycleIntervalMs`. Graceful shutdown on `SIGINT` / `SIGTERM`.
- **App** — `npm run dev --workspace @operator/app` (development) or `npm run build --workspace @operator/app && npm start --workspace @operator/app` (production). The app is read-mostly with a guarded write path for config edits and for the setup screen. It never starts, stops, or supervises the engine — it observes and configures the same SQLite file.

## Local-first development

The fastest path to a running operator:

```bash
git clone https://github.com/ainova-systems/operator-autopilot.git
cd operator-autopilot
npm install

# Secrets. The engine reads these; the setup screen only names the variable.
cp .env.local.example .env.local
# edit .env.local — MANAGED_REPO_GH_TOKEN, ANTHROPIC_API_KEY, CURSOR_API_KEY

# Guided setup: creates state/operator.db, checks this host, registers a repo
npm run dev --workspace @operator/app
# open http://localhost:3000/setup
```

The setup screen's host check reads the *app* process's environment, which is not the engine's. The root `.env.local` is passed to the engine explicitly (`--env-file`) and Next.js never sees it; Next loads `app/.env.local` instead (also gitignored). Copy the same values there, or export them in the shell before starting the app, if you want the credential checks to resolve rather than warn. They warn instead of failing precisely because the engine may hold credentials the app cannot see.

Then run the first cycle against the repository you registered:

```bash
npx tsx --env-file=.env.local engine/entry.ts --once --repo <repo-id>
```

State files (`state/operator.db`, workspaces) stay inside the repo when `OPERATOR_DIR` is unset — `state/` is gitignored. For a persistent local daemon, set `OPERATOR_DIR=/var/lib/operator` and point the app at the same path.

**Provisioning without the screen.** `cp config/repos.yaml.example config/repos.yaml`, edit it, and start the engine. The seed mirror upserts every entry into `kv:repos/*` on each start and deletes rows that disappear from the file — but it never touches a row the UI owns, so the two paths coexist. Use the file when a host is provisioned by configuration management; use the screen when a person is onboarding a repository.

## VM / systemd

Pick a host with Node.js 24 + git + your agent CLI already installed.

```ini
# /etc/systemd/system/operator-engine.service
[Unit]
Description=Operator Engine
After=network.target

[Service]
Type=simple
User=operator
Group=operator
WorkingDirectory=/opt/operator
Environment=OPERATOR_DIR=/var/lib/operator
Environment=WORKSPACE_BASE_DIR=/var/lib/operator/workspaces
Environment=OPERATOR_DB_PATH=/var/lib/operator/operator.db
Environment=LOG_LEVEL=info
EnvironmentFile=/etc/operator/secrets.env
ExecStart=/usr/bin/npx tsx /opt/operator/engine/entry.ts
Restart=on-failure
RestartSec=10s

[Install]
WantedBy=multi-user.target
```

`/etc/operator/secrets.env` holds `MANAGED_REPO_GH_TOKEN=…`, `ANTHROPIC_API_KEY=…`, etc. Use `chmod 600 /etc/operator/secrets.env` and `chown root:operator`. Enable + start:

```bash
systemctl daemon-reload
systemctl enable --now operator-engine.service
journalctl -u operator-engine -f
```

Run the app as a separate unit on the same host if you want the observability UI locally (`ExecStart=/usr/bin/npm start --workspace @operator/app` after a build step), reverse-proxied through nginx or caddy.

## Docker Compose

Use the committed stack — [`deployment/docker-compose.yml`](../deployment/docker-compose.yml) — rather than a hand-written file. It is the same stack the operator's own VM runs, and [`deployment/Dockerfile`](../deployment/Dockerfile) bundles Node, git, `gh`, ripgrep, and the agent CLIs, so the host needs none of them.

```bash
cp deployment/.env.example deployment/.env         # then fill in the tokens
docker compose -f deployment/docker-compose.yml up -d --build

# open http://localhost:3000/setup
docker logs -f operator-engine
```

What the stack gives you:

| Service | Role |
|---|---|
| `operator-engine` | The daemon. `restart: unless-stopped`, `stop_grace_period: 5m` matched to the engine's SIGTERM drain, `--config /var/lib/operator/config` so instance config lives on the volume rather than in the image. |
| `operator-app` | The observability + setup UI, same image with a different entrypoint, published on `127.0.0.1:3000`. `OPERATOR_DB_PATH` points it at the engine's state file, so it auto-creates its `default` connection and the setup screen opens with step one already satisfied. |
| `watchtower` | Opt-in registry auto-poll (`--profile watchtower`), scoped by label to the two operator containers. |

Both services mount the single `operator-state` volume. The engine is the continuous writer; the app writes only when someone edits configuration or completes the setup screen, and WAL mode serialises the two. **Never scale either service beyond one replica** — SQLite is not multi-writer safe.

The UI is bound to loopback because it edits engine configuration and carries no authentication of its own. Reach it over an SSH tunnel (`ssh -L 3000:127.0.0.1:3000 <host>`), or put an authenticating reverse proxy in front and set `OPERATOR_APP_BIND=0.0.0.0`.

Portainer and the push-based redeploy path are covered in [`deployment/README.md`](../deployment/README.md).

## Kubernetes

Deploy the engine as a single-replica Deployment (SQLite is not multi-writer safe; the app queries the same file read-mostly). Persist state on a `PersistentVolumeClaim`.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: operator-engine
spec:
  replicas: 1
  strategy: { type: Recreate } # SQLite — never run two writers
  selector: { matchLabels: { app: operator-engine } }
  template:
    metadata: { labels: { app: operator-engine } }
    spec:
      containers:
        - name: engine
          # `Build Image` publishes `:latest` and `:<commit-sha>`. There is no
          # version-numbered tag — pin to a SHA for a reproducible rollout.
          image: ghcr.io/ainova-systems/operator-autopilot/operator-engine:latest
          command: ["npx", "tsx", "engine/entry.ts"]
          env:
            - { name: OPERATOR_DIR, value: /var/lib/operator }
            - { name: WORKSPACE_BASE_DIR, value: /var/lib/operator/workspaces }
            - { name: OPERATOR_DB_PATH, value: /var/lib/operator/operator.db }
            - { name: LOG_LEVEL, value: info }
          envFrom:
            - secretRef: { name: operator-secrets }
          volumeMounts:
            - { name: state, mountPath: /var/lib/operator }
          resources:
            requests: { cpu: "200m", memory: "512Mi" }
            limits:   { cpu: "1",    memory: "1Gi"   }
      volumes:
        - name: state
          persistentVolumeClaim: { claimName: operator-state }
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: operator-state }
spec:
  accessModes: [ReadWriteOnce]
  resources: { requests: { storage: 20Gi } }
```

Store `MANAGED_REPO_GH_TOKEN` + agent API keys in the `operator-secrets` Secret (base64-encoded). The app runs as its own single-replica Deployment from the same image with `command: ["npm", "run", "start", "--workspace", "@operator/app"]`, mounting the same PVC read-write (the setup screen and the config editor write rows) and exposing port 3000 behind an authenticating Ingress. `ReadWriteOnce` means both pods must land on the same node — co-schedule them, or move to a single pod with two containers.

## Backups

SQLite files are the full state. Back up `OPERATOR_DB_PATH` + `OPERATOR_APP_DB_PATH` with any file-based backup tool. The engine uses WAL mode — copy the `.db` + `.db-wal` + `.db-shm` triple atomically (e.g. `sqlite3 operator.db '.backup /backup/operator.db'`). Workspaces under `WORKSPACE_BASE_DIR` are disposable — the engine re-clones them if missing.

## Upgrading

- **Config-only changes** (e.g. new reviewer prompt): edit `engine/content/*`, run `npx tsx engine/entry.ts --reseed <category>`. Only `source: "content"` rows are refreshed; user-edited rows with `modifiedFromBaseline: true` are preserved.
- **Engine code changes**: stop the daemon, `git pull`, `npm install`, restart. SQLite schema migrations are idempotent; wiping the database is never required.
- **Major version bump**: v4 → v5 is not auto-migrated — wipe the v4 state directory and start fresh with `--fresh-db`. See the breaking-changes notes in `CHANGELOG.md`.

### Keeping the agent CLIs current

The container bakes the agent CLIs at **build time** — `npm install -g @anthropic-ai/claude-code` and the `cursor-agent` installer both resolve to *latest at that moment*, then freeze into the image. Two things keep a deployment from drifting behind upstream:

1. **Rebuild on a schedule.** `.github/workflows/build-image.yml` rebuilds and pushes `:latest` nightly (`schedule:` cron) with `no-cache` on scheduled runs, so the CLI install layers actually re-fetch rather than restoring from the layer cache. A code push or manual `workflow_dispatch` still builds on the fast cached path.
2. **Redeploy the new image.** CI publishes, and for the operator's own VM the deploy job in `build-image.yml` rolls it out immediately over a self-hosted runner (`deployment/self-hosted-runner.md`) — the nightly rebuild redeploys too, so the running daemon never drifts behind the bundled CLIs. Any other host must `docker compose pull && docker compose up -d` to pick up the fresh `:latest`; automate that with one of:
   - A **self-hosted deploy runner** (recommended when the host is yours) — `deployment/deploy.sh` on a `master` build. See `deployment/self-hosted-runner.md`.
   - **Watchtower**, the opt-in `watchtower` compose profile — watches the registry and recreates the container when `:latest` changes. Scope it to `operator-engine` only. Good for a Portainer stack with no runner: `docker compose -f deployment/docker-compose.yml --profile watchtower up -d`.
   - A nightly cron on the host: `docker compose -f deployment/docker-compose.yml pull && docker compose -f deployment/docker-compose.yml up -d` (run *after* the CI build window).
   - Pin a digest/tag and bump it through your normal deploy pipeline if you prefer deterministic, reviewed updates over auto-pull.

   The engine drains the in-flight cycle on `SIGTERM` (see `stop_grace_period`), so an image swap between cycles is safe — a recreate never interrupts an agent mid-PR-transition.

> The same drift applies to any self-hosted CI runner image that bakes the agent CLIs in at build time. Give its build the same `schedule:` + `no-cache` treatment, and refresh the runners (ephemeral runners re-pull `:latest` per job; long-lived runner containers need the deploy runner, the Watchtower profile, or a scheduled `pull && up -d`).

## Troubleshooting

- **"Kind registry: empty category"** on boot — `kv:work-item-kinds/*` was not seeded. Run with `--reseed work-item-kinds` or confirm `engine/content/prompts/kinds.yaml` is readable.
- **Cycle hangs for >2h** — the engine's top-level `AbortSignal.timeout(7_200_000)` fires. Check agent-provider logs for a stuck CLI invocation.
- **"Workspace has uncommitted changes"** — `WORKSPACE_OVERRIDE` mode refuses to run on a dirty tree. Commit/stash or unset the override.
- **`EACCES: permission denied, mkdir '/var/lib/operator/state'`** — the named volume predates the image change that creates the mount point owned by uid 10001, so it is still root-owned. Fix it once: `docker compose -f deployment/docker-compose.yml down && docker run --rm -v operator-state:/v alpine chown -R 10001:37 /v && docker compose -f deployment/docker-compose.yml up -d` (use the project-prefixed volume name from `docker volume ls`).
- **App shows "no active connection"** — open `/setup` and complete the first step, or create one by hand under `/connections` pointing at `$OPERATOR_DB_PATH` and click Switch.
- **Setup's host check warns about credentials that are definitely set** — the check reads the app process's environment, not the engine's. Export the same variables where the app runs, or paste the token into the setup screen for a one-shot verification (it is not stored).
- **Force-push attempted** — this is a bug in the code, not a config issue. The engine never force-pushes; any such attempt must be reported via an issue.
