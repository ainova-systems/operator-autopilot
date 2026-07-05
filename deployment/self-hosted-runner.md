# Self-hosted deploy runner

> Scope: this is for the operator's **own** VM redeploying itself (ainova-systems
> repos). It is the push side of the self-improvement loop — the operator merges
> a change to its own `master`, CI builds the image, and this runner rolls it
> onto the daemon. A fork inherits the same pipeline unchanged: the workflow keys
> everything off `github.repository`, so a fork builds and deploys *its* image to
> *its* runner.

## How it fits together

```
operator merges to master
        │
        ▼
.github/workflows/build-image.yml
  ├─ build   (ubuntu-latest)       → push ghcr.io/<owner>/<repo>/operator-engine:<sha>
  └─ deploy  (self-hosted, operator-deploy)
             → deployment/deploy.sh
                 → docker compose pull + up -d operator-engine   (drains, restarts)
```

The `deploy` job runs only on `master` (push + the nightly rebuild), so every
merge and every nightly agent-CLI refresh lands on the running operator without
a manual pull. There is no Watchtower in this path — it is opt-in for manual
deployments (see `docker-compose.yml`).

## One-time VM setup (you own this)

An Ubuntu VM with Docker Engine + the compose plugin installed.

### 1. Register the runner (label `operator-deploy`)

Repo → **Settings → Actions → Runners → New self-hosted runner** gives you the
download commands + a registration token. Register it with the label the
workflow targets and install it as a service so it is long-lived and restarts on
boot:

```bash
mkdir -p ~/actions-runner && cd ~/actions-runner
# ... download per the GitHub UI ...
./config.sh --url https://github.com/<owner>/<repo> \
            --token <RUNNER_REGISTRATION_TOKEN> \
            --labels operator-deploy --unattended
sudo ./svc.sh install
sudo ./svc.sh start
```

### 2. Give the runner Docker access

The deploy job shells out to `docker`. Add the runner's user to the `docker`
group (or run the runner container with `/var/run/docker.sock` mounted):

```bash
sudo usermod -aG docker "$(whoami)"   # then restart the runner service
```

> **Keep the runner out of the `operator` compose project.** `deploy.sh` runs
> `docker compose -p operator up -d operator-engine`; if the runner were part of
> that project it would recreate itself mid-job. Run it as its own systemd
> service (above) or in a separate stack.

### 3. Runtime secrets — `/opt/operator/.env`

The daemon's secrets never travel through GitHub. Place them on the VM where
`deploy.sh` reads them (`OPERATOR_ENV_FILE`, default `/opt/operator/.env`):

```bash
sudo install -d -m 750 /opt/operator
sudo cp deployment/.env.example /opt/operator/.env
sudo chmod 600 /opt/operator/.env
# edit /opt/operator/.env — MANAGED_REPO_GH_TOKEN, ANTHROPIC_API_KEY, CURSOR_API_KEY
```

Leave `OPERATOR_IMAGE` unset in that file — the deploy job pins the exact
`:<sha>` it just built.

### 4. Seed instance config into the state volume

The daemon reads managed repos from the state volume (`--config
/var/lib/operator/config`). On a fresh volume, put `repos.yaml` there before the
first deploy:

```bash
docker volume create operator_operator-state
docker run --rm -v operator_operator-state:/state -v "$PWD/config":/src:ro \
  busybox sh -c 'mkdir -p /state/config && cp /src/repos.yaml /state/config/repos.yaml'
```

The volume is named `operator_operator-state` because `deploy.sh` pins the
compose project to `operator` — keep that project name for every manual command
too, or the daemon comes up against an empty database.

## First rollout

Either push a commit to `master` (the pipeline builds + deploys), or trigger it
by hand: repo → **Actions → Build Image → Run workflow**. Watch the `deploy`
job, then on the VM:

```bash
docker logs -f operator-engine
```

## Rollback

Every deploy pins `:<sha>`, so rolling back is redeploying an older one on the
VM:

```bash
OPERATOR_IMAGE=ghcr.io/<owner>/<repo>/operator-engine:<old-sha> \
  bash deployment/deploy.sh
```

(Find prior tags under the repo's **Packages**.) The daemon drains the current
cycle on `SIGTERM` before the swap, and boot reconciliation heals anything a
hard kill interrupted — a rollback is safe between cycles.

## Runner offline?

The `build` job still publishes the image (it runs on `ubuntu-latest`); only the
`deploy` job queues until the runner is back, then rolls out the latest build.
Nothing is lost — bring the runner up and it catches up on the next run, or run
`deploy.sh` by hand.
