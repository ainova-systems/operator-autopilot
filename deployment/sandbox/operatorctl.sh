#!/usr/bin/env bash
# operatorctl — lifecycle for an Operator engine running inside a Docker
# Sandboxes (`sbx`) microVM. The fifth deployment mode; see README.md.
#
# Design constraints this script exists to honor (all measured, see README.md):
#   - A detached process does NOT survive `sbx stop` + resume, and there is no
#     `sbx start`. So `up` is idempotent and re-entrant: it is the documented
#     restart path, and `status` reports a dead daemon rather than assuming.
#   - sbx child processes are NEVER killed. An interrupted sbx operation
#     permanently poisons the sandbox name and the only known recovery is
#     `sbx reset`, which destroys every sandbox on the machine.
#   - Stopping the engine means SIGTERM + the full drain budget BEFORE the VM
#     is stopped, so the in-flight cycle finishes and no agent is killed
#     mid-PR-transition.
#   - Exactly one engine process per state dir (SQLite single writer), enforced
#     here with a lock directory inside the VM.
#
# Usage: bash deployment/sandbox/operatorctl.sh <command> [args]
#   doctor              preflight the sandbox: toolchain, egress, credential
#                       scoping, and the agent-env leak assertion
#   up                  start (or restart) the engine daemon inside the VM
#   down                SIGTERM + drain the engine; leaves the VM running
#   stop                down, then stop the VM (state preserved)
#   status              VM state + daemon liveness + last log lines
#   logs [-f] [n]       tail the engine log
#   once [args...]      run a single cycle in the foreground (smoke test)
#   shell               interactive shell in the VM at the engine directory
#   backup <out.db>     WAL-atomic copy of the engine SQLite to the host
#   version             print this script's contract version
#
# Environment:
#   OPERATOR_SANDBOX    sbx sandbox name (required; no guessing — the name is
#                       the project's, and this script must never invent one)
#   OPERATOR_HOME       engine directory inside the VM (default /opt/operator)
#   OPERATOR_DRAIN_SECS drain budget for `down` (default 300, matching the
#                       engine's SHUTDOWN_GRACE_MS default of 300000 ms)
set -euo pipefail

CONTRACT_VERSION="1.0.0"
HOME_DIR="${OPERATOR_HOME:-/opt/operator}"
STATE_DIR="/home/agent/operator-state"
LOG_FILE="$STATE_DIR/engine.log"
PID_FILE="$STATE_DIR/engine.pid"
LOCK_DIR="$STATE_DIR/engine.lock"
DRAIN_SECS="${OPERATOR_DRAIN_SECS:-300}"

die() { printf 'operatorctl: %s\n' "$*" >&2; exit 1; }
note() { printf '%s\n' "$*"; }

[ -n "${OPERATOR_SANDBOX:-}" ] || die "set OPERATOR_SANDBOX to the sbx sandbox name (see .sandbox/config.yaml; \`sbx.sh name <key>\` derives it)"

SBX="sbx"
if ! command -v sbx >/dev/null 2>&1; then
  if [ -n "${LOCALAPPDATA:-}" ] && [ -x "${LOCALAPPDATA}/DockerSandboxes/bin/sbx.exe" ]; then
    SBX="${LOCALAPPDATA}/DockerSandboxes/bin/sbx.exe"
  else
    die "sbx not found on PATH (Windows: %LOCALAPPDATA%\\DockerSandboxes\\bin\\sbx.exe)"
  fi
fi

# Every in-VM call goes through here. `sbx exec` auto-starts a stopped
# sandbox, which is why `up` needs no separate start step.
vm() { "$SBX" exec "$OPERATOR_SANDBOX" bash -lc "$1"; }
vm_i() { "$SBX" exec -i "$OPERATOR_SANDBOX" bash -lc "$1"; }

daemon_pid() {
  vm "cat '$PID_FILE' 2>/dev/null || true" | tr -d '\r\n'
}

daemon_alive() {
  local pid; pid=$(daemon_pid)
  [ -n "$pid" ] || return 1
  vm "kill -0 '$pid' 2>/dev/null" >/dev/null 2>&1
}

cmd_doctor() {
  note "== toolchain =="
  vm "node --version; git --version; gh --version | head -1; command -v claude >/dev/null && echo 'claude: present' || echo 'claude: MISSING'; command -v cursor-agent >/dev/null && echo 'cursor-agent: present' || echo 'cursor-agent: absent (claude-only preset is fine)'"

  note ""
  note "== engine =="
  vm "cd '$HOME_DIR' && node -e 'const e=require(\"./package.json\").engines.node; const ok=process.versions.node.split(\".\")[0] >= 24; console.log(\"engine requires node \"+e+\", running \"+process.version+(ok?\" OK\":\" TOO OLD\"))'"
  vm "cd '$HOME_DIR' && node -e 'require(\"better-sqlite3\"); console.log(\"better-sqlite3: loads OK\")' || echo 'better-sqlite3: FAILED to load — rebuild the image'"

  note ""
  note "== egress =="
  vm "npm ping 2>&1 | tail -1; git ls-remote https://github.com/ainova-systems/operator-autopilot HEAD >/dev/null 2>&1 && echo 'github git: reachable' || echo 'github git: BLOCKED'"

  note ""
  note "== credential scoping (the boundary this mode depends on) =="
  # A sandbox that declares no `github` service secret must reach the GitHub
  # API anonymously. If this reports authenticated, the sbx credential proxy
  # is signing traffic VM-wide and the engine's agent-env stripping is being
  # bypassed at the network layer — agents could then mutate the
  # orchestrator-owned PR. That is a STOP, not a warning.
  local limit
  limit=$(vm "curl -s https://api.github.com/rate_limit | tr -d ' \n' | grep -o '\"core\":{\"limit\":[0-9]*' | grep -o '[0-9]*\$'" | tr -d '\r\n')
  if [ "$limit" = "60" ]; then
    note "github API from VM: anonymous (core limit 60) — OK, proxy is not wire-signing this sandbox"
  else
    note "github API from VM: AUTHENTICATED (core limit ${limit:-unknown})"
    note "  STOP: this sandbox carries a github service secret. Remove \`secrets: [github]\`"
    note "  from the operator entry in .sandbox/config.yaml and recreate, or agent"
    note "  subprocesses inherit GitHub write access at the network layer."
  fi

  note ""
  note "== agent-env leak assertion =="
  # The engine strips AGENT_FORBIDDEN_ENV plus every configured tokenEnvVar
  # from agent subprocesses. Assert the token is not simply exported VM-wide
  # into every shell, which would defeat it before the engine even runs.
  vm "env | grep -qE '^(GH_TOKEN|GITHUB_TOKEN)=' && echo 'WARN: GH_TOKEN/GITHUB_TOKEN exported VM-wide — unset it; the engine reads its own tokenEnvVar' || echo 'no ambient GH_TOKEN/GITHUB_TOKEN: OK'"

  note ""
  note "== state =="
  vm "ls -la '$STATE_DIR' 2>/dev/null | head -5 || echo 'state dir not created yet (first up will create it)'"
}

cmd_up() {
  if daemon_alive; then
    note "already running (pid $(daemon_pid)) — use 'down' then 'up' to restart"
    return 0
  fi
  # Stale lock from a VM stop (the process is gone, the lock dir is not):
  # bounded, explicit recovery — never a silent rm.
  if vm "[ -d '$LOCK_DIR' ]" >/dev/null 2>&1; then
    note "clearing a stale lock left by a stopped VM (no live daemon holds it)"
    vm "rm -rf '$LOCK_DIR'"
  fi
  vm "mkdir -p '$STATE_DIR' && mkdir '$LOCK_DIR'" \
    || die "another operatorctl holds the lock at $LOCK_DIR — SQLite is single-writer"

  # setsid + nohup so the daemon outlives this exec session. It does NOT
  # outlive a VM stop — `up` is the documented restart path.
  vm "cd '$HOME_DIR' && setsid nohup npx tsx engine/entry.ts >> '$LOG_FILE' 2>&1 < /dev/null & echo \$! > '$PID_FILE'"
  sleep 3
  if daemon_alive; then
    note "engine started (pid $(daemon_pid)); logs: operatorctl.sh logs -f"
  else
    vm "rm -rf '$LOCK_DIR'"
    note "engine failed to start — last log lines:"
    vm "tail -20 '$LOG_FILE' 2>/dev/null || echo '(no log)'"
    exit 1
  fi
}

cmd_down() {
  local pid; pid=$(daemon_pid)
  if [ -z "$pid" ] || ! daemon_alive; then
    note "not running"
    vm "rm -rf '$LOCK_DIR' '$PID_FILE'" || true
    return 0
  fi
  note "SIGTERM -> pid $pid; draining up to ${DRAIN_SECS}s (the engine finishes its in-flight cycle)"
  vm "kill -TERM '$pid'"
  local waited=0
  while [ "$waited" -lt "$DRAIN_SECS" ]; do
    daemon_alive || break
    sleep 5
    waited=$((waited + 5))
  done
  if daemon_alive; then
    # Never escalate silently. A second SIGTERM is the engine's own documented
    # "stop now" path; SIGKILL is left to the operator's explicit choice.
    note "still draining after ${DRAIN_SECS}s — sending a second SIGTERM (the engine treats it as force-stop)"
    vm "kill -TERM '$pid'" || true
    sleep 10
  fi
  vm "rm -rf '$LOCK_DIR' '$PID_FILE'" || true
  daemon_alive && note "WARNING: pid $pid still alive; inspect before stopping the VM" || note "engine stopped"
}

cmd_stop() {
  cmd_down
  note "stopping the VM (never interrupt this — an interrupted sbx operation poisons the sandbox name)"
  "$SBX" stop "$OPERATOR_SANDBOX"
}

cmd_status() {
  "$SBX" ls | awk -v n="$OPERATOR_SANDBOX" 'NR==1 || $1==n'
  note ""
  if daemon_alive; then
    note "daemon: RUNNING (pid $(daemon_pid))"
  else
    local pid; pid=$(daemon_pid)
    if [ -n "$pid" ]; then
      note "daemon: DEAD (stale pid $pid) — a VM stop does not preserve the process; run 'up'"
    else
      note "daemon: not started — run 'up'"
    fi
  fi
  note ""
  vm "tail -5 '$LOG_FILE' 2>/dev/null || echo '(no log yet)'"
}

cmd_logs() {
  local follow=0 lines=100
  while [ $# -gt 0 ]; do
    case "$1" in
      -f) follow=1 ;;
      *) lines="$1" ;;
    esac
    shift
  done
  if [ "$follow" = 1 ]; then
    "$SBX" exec -it "$OPERATOR_SANDBOX" bash -lc "tail -n $lines -f '$LOG_FILE'"
  else
    vm "tail -n $lines '$LOG_FILE' 2>/dev/null || echo '(no log yet)'"
  fi
}

cmd_once() {
  daemon_alive && die "the daemon is running — SQLite is single-writer; run 'down' first"
  local extra=""
  [ $# -gt 0 ] && extra=" $*"
  "$SBX" exec -it -w "$HOME_DIR" "$OPERATOR_SANDBOX" bash -lc "npx tsx engine/entry.ts --once${extra}"
}

cmd_shell() {
  "$SBX" exec -it -w "$HOME_DIR" "$OPERATOR_SANDBOX" bash
}

cmd_backup() {
  local out="${1:?usage: backup <out.db>}"
  # sqlite3 .backup is the only WAL-safe copy — plain cp of a .db without its
  # -wal/-shm sidecars yields a torn database.
  vm "command -v sqlite3 >/dev/null || sudo apt-get install -y -q sqlite3 >/dev/null 2>&1 || true"
  vm "sqlite3 '$STATE_DIR/state/operator.db' \".backup '/tmp/operator-backup.db'\"" \
    || die "backup failed inside the VM"
  "$SBX" exec "$OPERATOR_SANDBOX" bash -lc "cat /tmp/operator-backup.db" > "$out"
  vm "rm -f /tmp/operator-backup.db"
  note "wrote $out"
}

usage() { sed -n '/^# Usage:/,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }

cmd="${1:-help}"
shift || true
case "$cmd" in
  doctor)  cmd_doctor ;;
  up)      cmd_up ;;
  down)    cmd_down ;;
  stop)    cmd_stop ;;
  status)  cmd_status ;;
  logs)    cmd_logs "$@" ;;
  once)    cmd_once "$@" ;;
  shell)   cmd_shell ;;
  backup)  cmd_backup "$@" ;;
  version) printf 'operatorctl contract v%s\n' "$CONTRACT_VERSION" ;;
  help|--help|-h) usage ;;
  *) usage; die "unknown command \"$cmd\"" ;;
esac
