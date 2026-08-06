# syntax=docker/dockerfile:1

# Operator Engine — sandbox profile (Docker Sandboxes / `sbx` microVM).
#
# This is the FIFTH deployment mode (see ../../docs/deployment.md). It exists
# for one reason the other four cannot serve: the engine runs the managed
# repo's own `scripts.init` and `scripts.verify` in ITS OWN environment, so a
# managed repo whose toolchain is not Node cannot pass verify in the stock
# image. Here the engine is layered ON TOP of the project's existing sandbox
# image, so the project's toolchain IS the engine's toolchain — no fork of
# ../Dockerfile, no drift.
#
# The self-contained property of ../Dockerfile is deliberately NOT copied
# here: that image must stay reproducible from this repository alone. This
# one is explicitly derived, and the base is supplied by the adopting project.
#
# Build ARG contract:
#   OPERATOR_BASE_IMAGE  the project's own sandbox image tag, i.e. whatever
#                        `.sandbox/config.yaml` derives from its Dockerfile
#                        (`<project>:<dockerfile-stem>`, e.g. `myrepo:claude`).
#                        That image must itself descend from a
#                        `docker/sandbox-templates:<flavor>` base, which is
#                        Docker Sandboxes' own requirement — it preserves the
#                        non-root `agent` user (uid 1000), passwordless sudo,
#                        and the proxy env the credential proxy needs.
#   OPERATOR_REF         git ref of this repository to install (tag/branch/SHA).
#
# Build + load (host, from this repository's root) — or just use operatorctl.sh:
#   docker build --pull -f deployment/sandbox/operator.Dockerfile \
#     --build-arg OPERATOR_BASE_IMAGE=myrepo:claude \
#     -t myrepo:operator deployment/sandbox
#   docker save myrepo:operator -o operator.tar && sbx template load operator.tar
#
# Verified against sbx v0.31.x on Windows 11, 2026-08-06.

ARG OPERATOR_BASE_IMAGE
FROM ${OPERATOR_BASE_IMAGE}

USER root
ARG DEBIAN_FRONTEND=noninteractive

# Node 24 — package.json `engines` requires >=24.0.0, while the current
# `claude-code-docker` base ships Node 22 (measured 22.22.1). NodeSource
# installs to /usr/bin and takes PATH precedence over the base's Node, so the
# project's own Node-based tooling keeps working through the same binary.
#
# gh / ripgrep / build tooling: the base may already carry them (the measured
# claude-code-docker base had gh 2.46 and ripgrep 15.1), so this layer is
# idempotent by construction — apt skips what is already present.
#   git            — the engine shells out to git inside workspaces
#   gh             — GitHub CLI: the engine clones through it
#   ripgrep        — required by cursor-agent; harmless otherwise
#   build-essential, python3 — node-gyp fallback for better-sqlite3 when no
#                    prebuilt binary matches this base's glibc/ABI
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y --no-install-recommends \
        nodejs git gh ripgrep build-essential python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Engine source. Installed from a pinned ref rather than COPY --from a
# published image: a prebuilt node_modules carries a better-sqlite3 binary
# built against a different base, and that ABI pairing would have to be
# maintained against every nightly rebuild of both images. Building here costs
# one npm ci and owes nothing to any registry.
#
# `npm ci` must include dev dependencies — the engine runs TypeScript directly
# through tsx (no build step), so tsx + typescript are runtime requirements.
ARG OPERATOR_REF=master
ARG OPERATOR_REPO=https://github.com/ainova-systems/operator-autopilot
RUN git clone --depth 1 --branch "${OPERATOR_REF}" "${OPERATOR_REPO}" /opt/operator \
    && chown -R agent:agent /opt/operator

USER agent
WORKDIR /opt/operator
RUN npm ci

# Cursor Agent — the shipped agents.yaml routes the code-writing roles to it.
# Installed as `agent` because the official installer hard-codes $HOME/.local
# with no install-dir override. Omit CURSOR_API_KEY and run the claude-only
# preset instead if you want a single-vendor deployment (see README.md).
RUN curl https://cursor.com/install -fsS | bash
ENV PATH="/home/agent/.local/bin:${PATH}"

# State lives on the sandbox's own disk, never on a host share: the engine's
# SQLite runs in WAL mode and WAL over a 9p/virtio-fs share is a corruption
# class, not a performance note. `sbx stop` preserves this; `sbx rm` does not
# — see README.md "What survives what".
ENV OPERATOR_DIR=/home/agent/operator-state \
    WORKSPACE_BASE_DIR=/home/agent/operator-state/workspaces \
    NODE_ENV=production \
    LOG_LEVEL=info \
    NO_STATUS_LINE=1

# No ENTRYPOINT: an sbx sandbox is a long-lived microVM, not a container the
# runtime starts a process in. operatorctl.sh drives the daemon lifecycle
# inside it (sbx exec), because a detached process does NOT survive
# stop/resume — measured 2026-08-06, see README.md.
