# Sandbox deployment (Docker Sandboxes / `sbx`)

The **fifth** deployment mode, alongside local-first dev, VM/systemd, Docker
Compose, and Kubernetes (`../../docs/deployment.md`). It is optional by design —
`docs/vision.md` invariant 8 keeps plain VM / Docker / Kubernetes working
unchanged, and nothing here becomes a requirement for them.

## Why this mode exists

The engine executes the managed repo's own `scripts.init` and `scripts.verify`
**in its own environment** (`engine/verification/pipeline.ts` runs
`bash -c <verify>`; `engine/infra/workspace-init.ts` runs `scripts.init`). The
stock image (`../Dockerfile`) is Node + git + gh + ripgrep + the agent CLIs and
nothing else, so a managed repo whose verify needs .NET, a JDK, Playwright
browsers, or LibreOffice **cannot pass its own gate** — every creator PR fails
verify with command-not-found. Today the answers are "fork the Dockerfile" or
"run bare on a host that already has the toolchain".

Projects that already use [Sandbox Console](https://github.com/ainova-systems/code-sandbox-console)
have solved that exact problem for their coding agents: a committed
`.sandbox/config.yaml` recipe plus a Dockerfile that layers the project's real
toolchain onto a `docker/sandbox-templates:<flavor>` base. This mode layers the
engine **on top of that image**, so the project's toolchain *is* the engine's
toolchain, and the isolation comes for free: the engine, the agent CLIs it
spawns, and the verify commands all run inside a microVM with its own kernel.

Nothing here couples the two products. The engine gains no dependency on `sbx`,
and Sandbox Console gains no knowledge of the operator — the contact surface is
a committed recipe file and the `sbx` CLI, both of which exist already.

## What was measured (2026-08-06, sbx v0.31.x, Windows 11)

Everything below is verified behavior, not inference. It drives the design
choices in `operator.Dockerfile` and `operatorctl.sh`.

| Probe | Result | Consequence |
|---|---|---|
| Base toolchain (`claude-code-docker` + a project layer) | Node **22**, git 2.53, gh 2.46, ripgrep 15.1, dotnet 10.0.302 | The engine needs `engines: >=24` → the profile installs Node 24 with PATH precedence. gh/rg usually already present. |
| Key-less Claude | `claude -p` works with **no** `ANTHROPIC_API_KEY` in the VM | The host credential proxy authenticates the agent CLI; no Anthropic key inside. (`envVarsAnyOf` in the config schema is not enforced at runtime.) |
| Direct mount, Windows | **The whole host drive** is mounted read-write at `/<letter>` (`/d/Repositories/...`) | A direct-mount operator sandbox is *not* meaningfully isolated from the host disk. **Use `mount: clone`.** |
| GitHub credential scoping | Sandbox **with** `secrets: [github]` → API core limit **5000** (authenticated). Sandbox **without** → **60** (anonymous), `gh auth status` not logged in | The proxy signs per sandbox, not machine-wide. **Declare no `secrets:` on the operator entry** so the engine's agent-env stripping stays the real boundary. |
| Egress | npm registry ~330 ms; `git ls-remote` github instant | Comfortably inside the engine's 5-minute git subprocess timeout. |
| `sbx exec -d` across stop/resume | Process **does not survive**; the filesystem does. There is no `sbx start`. | No detached daemon can be assumed alive after a VM stop. `operatorctl up` is idempotent and *is* the restart path; `status` reports a dead daemon instead of guessing. |

## Security model

The microVM is **one trust domain**: the base-image contract requires a single
non-root `agent` user (uid 1000) with passwordless sudo, so the engine, the
agent subprocesses, and verify scripts all run as that user. File permissions
buy nothing here — anything in the VM can read anything else in the VM.

The real boundaries are therefore:

1. **Token scope.** Use a fine-grained, single-repo, short-lived PAT. It is the
   only secret that must exist inside the VM (the engine's `requireEnvToken`
   demands the env var named by `repos.yaml:vcs.tokenEnvVar`).
2. **The engine's agent-env stripping.** `buildChildEnv` removes
   `AGENT_FORBIDDEN_ENV` *and* every configured `tokenEnvVar` from agent
   subprocesses, so an agent cannot authenticate `gh` against the
   orchestrator-owned PR. This is load-bearing here, which is why
   `operatorctl doctor` asserts it (see below).
3. **No `secrets:` on the operator recipe entry.** A sandbox that declares the
   `github` service secret gets its outbound GitHub traffic signed by the host
   proxy — which would re-authenticate agent subprocesses at the *network*
   layer and void boundary 2. `doctor` fails loudly on this.
4. **Branch protection on the managed repo.** The engine never pushes or merges
   a protected branch; keep that enforced server-side too.

`--dangerously-skip-permissions` on the agent CLIs is sanctioned **only**
because execution is inside the microVM: the blast radius is the VM and the
workspace clones it made itself.

## What survives what

| Action | Engine state (`/home/agent/operator-state`) | Workspaces |
|---|---|---|
| `operatorctl down` / `up` | preserved | preserved |
| `operatorctl stop` → resume | preserved (the daemon process does not — run `up`) | preserved |
| `sbx rm` / image rebuild | **lost** | lost (re-cloned) |

Losing state is recoverable, not catastrophic: work-item content lives in git
and in the PRs, and `--fresh-db` is a supported engine mode. What is lost is
execution history and metrics. Take `operatorctl backup` before a rebuild.

**Never put the SQLite state on a host share.** The engine runs WAL mode, and
WAL over a 9p/virtio-fs mount is a corruption class. State stays on the VM disk.

## Setup

1. **Prerequisites** — `sbx` installed and signed in (`sbx login`), Docker
   Engine on the host (for `docker build`), Git Bash on Windows. The adopting
   project already has a `.sandbox/config.yaml` and its own Dockerfile; if it
   does not, create one with Sandbox Console first, or point
   `OPERATOR_BASE_IMAGE` at any image descending from
   `docker/sandbox-templates:<flavor>`.

2. **Add the operator entry** to the project's `.sandbox/config.yaml`:

   ```yaml
   operator:
     agent: claude              # first-class claude sandbox: proxy-authenticated agent CLI
     title: Operator
     image: myrepo:operator     # built from operator.Dockerfile, below
     mount: clone               # NEVER direct — see the measured table above
     # NO secrets: — the GitHub token is an env var, so env-stripping stays meaningful
     # NO ports:   — the observability app has a guarded write path; publish it
     #               deliberately, not by default
   ```

   Note the recipe's `dockerfile:` key is deliberately **not** used: it resolves
   under the project's `.sandbox/`, and this profile is versioned with the
   engine instead. Build with `docker build` (below) and the recipe consumes the
   resulting tag through `image:`.

3. **Build and load the image** (from this repository's root):

   ```bash
   docker build --pull -f deployment/sandbox/operator.Dockerfile \
     --build-arg OPERATOR_BASE_IMAGE=myrepo:claude \
     --build-arg OPERATOR_REF=master \
     -t myrepo:operator deployment/sandbox
   docker save myrepo:operator -o /tmp/operator.tar
   sbx template load /tmp/operator.tar     # the sbx image store is separate from host docker
   ```

4. **Create the sandbox** from the project's own generated CLI, so naming and
   identity stay that project's business:

   ```bash
   cd /path/to/project
   bash .sandbox/scripts/sbx.sh connect operator     # creates from the recipe, then attaches
   export OPERATOR_SANDBOX="$(bash .sandbox/scripts/sbx.sh name operator)"
   ```

5. **Provision instance config and the token** inside the VM:

   ```bash
   ctl() { bash /path/to/operator-autopilot/deployment/sandbox/operatorctl.sh "$@"; }
   ctl shell
   # inside:
   mkdir -p ~/operator-state/config
   cat > ~/operator-state/config/repos.yaml <<'YAML'
   repos:
     - id: myrepo
       vcs:
         platform: github
         repo: owner/myrepo
         branch: main
         tokenEnvVar: MANAGED_REPO_GH_TOKEN
       features: { prReview: true, taskSelect: true, taskExecute: true,
                   dailyResearch: true, improver: true,
                   findingSelect: true, findingExecute: true }
       limits: { maxActiveTasks: 2, maxActiveFindings: 2 }
   YAML
   printf 'export MANAGED_REPO_GH_TOKEN=%s\n' '<fine-grained PAT>' >> ~/.bashrc
   exit
   ```

   Single-vendor option: the shipped `agents.yaml` routes the code-writing roles
   to `cursor-agent` and so requires `CURSOR_API_KEY`. To run on Claude alone,
   edit `engine/content/defaults/agents.yaml` inside the VM so `creator`,
   `improver`, and `supervisor` use `provider: claude`, then reseed
   (`npx tsx engine/entry.ts --reseed agent-roles`).

6. **Preflight, then run:**

   ```bash
   ctl doctor        # toolchain, egress, credential scoping, env-leak assertion
   ctl once --repo myrepo --fresh-db     # one foreground cycle as a smoke test
   ctl up            # start the daemon
   ctl status
   ```

## Daily operation

```bash
ctl status                 # VM state + daemon liveness + last log lines
ctl logs -f                # follow the engine log
ctl down                   # SIGTERM + full drain, VM stays up
ctl stop                   # drain, then stop the VM (state preserved)
ctl up                     # start or restart — also the post-resume path
ctl backup ./operator.db   # WAL-atomic copy to the host, before any rebuild
```

`operatorctl` never kills an `sbx` child process. An interrupted `sbx`
operation permanently claims the sandbox name, and the only documented recovery
is `sbx reset`, which destroys every sandbox on the machine. Let slow `sbx`
calls finish.

## Known limitations

- **Windows-first.** `sbx` and Sandbox Console are developed and verified on
  Windows 11; macOS/Linux are untested upstream. `operatorctl` needs only bash
  and `sbx`.
- **No auto-start after host reboot.** A stopped sandbox resumes on demand
  (`sbx run` / any `sbx exec`), and the daemon needs `ctl up` after that.
  Supervising this from the host (a scheduled task or a login item calling
  `ctl up`) is the operator's choice; upstream `kit` `startup` hooks are the
  natural home for it once implemented.
- **One instance per managed repo.** SQLite is single-writer, and two operators
  on one repo produce duplicate PRs. `operatorctl` guards the VM-local case with
  a lock directory; it cannot see an operator running elsewhere.
- **Verify timeout.** The engine caps verify at 120 s, which a cold heavyweight
  build can exceed — exactly the workloads this mode unlocks. Tracked in
  [issue #50](https://github.com/ainova-systems/operator-autopilot/issues/50);
  until it lands, warm the caches from `scripts.init`.
- **Observability app.** Not started by this profile. It reads the engine's
  SQLite directly, so it must run inside the same VM (publish a port
  deliberately) or read a `backup` copy on the host.
