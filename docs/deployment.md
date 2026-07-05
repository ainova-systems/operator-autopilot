# Operator Deployment

Operator is local-first: SQLite + filesystem + one agent API key is enough to run the closed loop. Production deployments add a supervisor (systemd / Docker / Kubernetes) but the engine code and the state layout are identical in every runtime. Pick the section that matches your environment.

## Prerequisites

- **Node.js 20+** (pinned as the runtime for the engine and app).
- **git 2.40+** on `$PATH` — the engine shells out to `git` inside managed workspaces.
- **The agent CLIs configured in `engine/content/defaults/agents.yaml`**, reachable from `$PATH` (or a pinned absolute path). The shipped config uses **two** providers: `claude` (Claude Code — analysis/review roles) and `cursor` (`cursor-agent` — the code-writing roles `creator`/`improver`/`supervisor`, on the Composer model). A single-provider deployment only needs one CLI.
- **ripgrep (`rg`)** on `$PATH` if the `cursor` provider is used — `cursor-agent` shells out to `rg` and refuses to run without it.
- **One VCS token** with repo-scoped permissions. Set the env-var named by `repos.yaml:vcs.tokenEnvVar` (default `GITHUB_TOKEN`).
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
| `GITHUB_TOKEN` (or per-repo `tokenEnvVar`) | — | VCS API token, scoped to the repos declared in `config/repos.yaml` |
| `ANTHROPIC_API_KEY` (or `CLAUDE_CODE_OAUTH_TOKEN`) | — | Claude Code auth — analysis/review roles |
| `CURSOR_API_KEY` | — | Cursor Agent auth — code-writing roles (required by the shipped `agents.yaml`); or run `cursor-agent login` once on the host |
| other agent-provider keys | — | Names come from `engine/content/defaults/agents.yaml` |

Never commit `.env` files. The engine and app load env-vars through `node --env-file=.env.local` at dev time; production runtimes inject them through the supervisor.

## Runtime modes

- **One-shot** — `npx tsx --env-file=.env.local engine/entry.ts --once --repo <id>`. Runs one cycle, exits non-zero on failure. Good for CI smoke tests and cron-style scheduling.
- **Daemon** — `npx tsx --env-file=.env.local engine/entry.ts`. Runs the full cycle loop on the interval configured in `engine-defaults/global.cycleIntervalMs`. Graceful shutdown on `SIGINT` / `SIGTERM`.
- **App** — `npm run dev --workspace @operator/app` (development) or `npm run build --workspace @operator/app && npm start --workspace @operator/app` (production). The app is read-mostly with a guarded write path for config edits.

## Local-first development

The fastest path to a running operator:

```bash
git clone https://github.com/ainova-systems/operator-autopilot.git
cd operator-autopilot
npm install

# Configure at least one managed repo
cp config/repos.yaml.example config/repos.yaml
# edit config/repos.yaml — set owner/repo, branch, tokenEnvVar

# Configure secrets locally
cat > .env.local <<'EOF'
GITHUB_TOKEN=ghp_...
ANTHROPIC_API_KEY=sk-ant-...
EOF

# Smoke test: one-shot cycle with a fresh database
npx tsx --env-file=.env.local engine/entry.ts --once --fresh-db --repo <your-repo-id>

# Start the app in another terminal to watch what happened
npm run dev --workspace @operator/app
# open http://localhost:3000
```

State files (`state/operator.db`, workspaces) stay inside the repo when `OPERATOR_DIR` is unset — `state/` is gitignored. For a persistent local daemon, set `OPERATOR_DIR=/var/lib/operator` and point the app at the same path.

## VM / systemd

Pick a host with Node.js 20 + git + your agent CLI already installed.

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

`/etc/operator/secrets.env` holds `GITHUB_TOKEN=…`, `ANTHROPIC_API_KEY=…`, etc. Use `chmod 600 /etc/operator/secrets.env` and `chown root:operator`. Enable + start:

```bash
systemctl daemon-reload
systemctl enable --now operator-engine.service
journalctl -u operator-engine -f
```

Run the app as a separate unit on the same host if you want the observability UI locally (`ExecStart=/usr/bin/npm start --workspace @operator/app` after a build step), reverse-proxied through nginx or caddy.

## Docker Compose

Minimal compose file for the engine + app sharing a named volume.

```yaml
# docker-compose.yml
services:
  operator-engine:
    image: node:20-bookworm
    working_dir: /app
    command: npx tsx engine/entry.ts
    volumes:
      - ./:/app:ro
      - operator-state:/var/lib/operator
    environment:
      OPERATOR_DIR: /var/lib/operator
      WORKSPACE_BASE_DIR: /var/lib/operator/workspaces
      OPERATOR_DB_PATH: /var/lib/operator/operator.db
      LOG_LEVEL: info
    env_file: .env.production
    restart: on-failure

  operator-app:
    image: node:20-bookworm
    working_dir: /app
    command: sh -c "npm install && npm run build --workspace @operator/app && npm start --workspace @operator/app"
    volumes:
      - ./:/app
      - operator-state:/var/lib/operator
    environment:
      OPERATOR_APP_DB_PATH: /var/lib/operator/app.db
      PORT: 3000
    ports:
      - "3000:3000"
    depends_on:
      - operator-engine

volumes:
  operator-state:
```

Run `docker compose up -d`. The engine writes to `operator-state`; the app reads from the same volume via `OPERATOR_DB_PATH`. For production, bake an image instead of bind-mounting the source (`Dockerfile` with `RUN npm ci && npm run build`); the compose file above is optimized for quick-start + live-reload dev on a VM.

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
          image: ghcr.io/ainova-systems/operator-autopilot/operator-engine:0.5
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

Store `GITHUB_TOKEN` + agent API keys in the `operator-secrets` Secret (base64-encoded). The app Deployment mounts the same PVC in read-only mode and exposes port 3000 behind an Ingress.

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
- **App shows "no active connection"** — open `/connections`, create one pointing at `$OPERATOR_DB_PATH`, and click Switch.
- **Force-push attempted** — this is a bug in the code, not a config issue. The engine never force-pushes; any such attempt must be reported via an issue.
