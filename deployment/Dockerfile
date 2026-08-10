# syntax=docker/dockerfile:1

# Operator image — the always-on daemon and the observability/setup UI.
#
# Self-contained: Node.js + git + GitHub CLI + ripgrep + the agent CLIs
# (Claude Code for the analysis/review roles, Cursor Agent for the
# code-writing roles — see engine/content/defaults/agents.yaml). No external
# base-image coupling, so the image is reproducible from this repository alone.
#
# One image, two entrypoints: the default runs the engine; the `operator-app`
# service in docker-compose.yml overrides it to serve the Next.js app from the
# build produced below. Two images would double the CLI install layers for no
# gain — both processes need the same source tree and the same state volume.
#
# Build (from repo root):
#   docker build -f deployment/Dockerfile -t operator-engine:local .
# Run:
#   see deployment/docker-compose.yml

FROM node:24-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# Runtime system deps:
#   git                      — the engine shells out to git inside workspaces
#   gh                       — GitHub CLI for PR operations
#   ripgrep                  — required by cursor-agent (it shells out to `rg`
#                              for codebase search; it refuses to run without it)
#   build-essential, python3 — node-gyp fallback for the better-sqlite3 native
#                              binding when no prebuilt binary matches the host
#   curl, gnupg, ca-certs    — needed to add the gh apt repository
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git ca-certificates curl gnupg build-essential python3 ripgrep \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Agent CLIs. Claude Code serves the analysis/review roles; Cursor Agent (added
# below, per-user) serves the code-writing roles. Swap or extend providers via
# engine/content/defaults/agents.yaml.
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# Install dependencies first for layer caching. `npm ci` must install dev
# dependencies too — the engine runs TypeScript directly through tsx (no build
# step), so tsx + typescript are runtime requirements. NODE_ENV is therefore
# left unset until after the install.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/adapters/package.json packages/adapters/package.json
COPY app/package.json app/package.json
RUN npm ci

# Copy the rest of the source tree.
COPY . .

# Drop privileges. The state volume is owned by this uid at runtime.
# The Debian base already ships an `operator` group, so reuse it via -g instead
# of letting useradd try (and fail) to create a colliding same-name group.
RUN useradd -m -u 10001 -g operator operator && chown -R operator:operator /app

# Create the state mountpoint owned by that user, while still root.
#
# Docker initialises a NEW named volume from whatever the image has at the
# mount path — including its ownership. Without this directory the volume is
# created root-owned and the unprivileged process cannot even `mkdir
# /var/lib/operator/state`, so a fresh `docker compose up` fails on first
# start. An existing volume keeps its current ownership: fix one in place with
#   docker run --rm -v operator-state:/v alpine chown -R 10001:37 /v
RUN mkdir -p /var/lib/operator && chown operator:operator /var/lib/operator

USER operator

# Cursor Agent CLI — installed as the operator user so the launcher's absolute
# paths resolve under this HOME at runtime (the official installer hard-codes
# $HOME/.local with no install-dir override). HOME must be set explicitly:
# `USER` alone does not change $HOME in Docker, and the installer + the runtime
# CLI both key off it (~/.local/bin, ~/.cursor). Auth is provided at runtime via
# CURSOR_API_KEY (see docker-compose.yml), not baked into the image.
ENV HOME=/home/operator
RUN curl https://cursor.com/install -fsS | bash
ENV PATH="/home/operator/.local/bin:${PATH}"

# Pre-build the Next.js app so the `operator-app` service can serve it with
# `next start`. Built as the operator user so `app/.next` is writable at
# runtime. The engine itself never touches this output.
RUN npm run build --workspace @operator/app

ENV NODE_ENV=production \
    LOG_LEVEL=info \
    NO_STATUS_LINE=1

# Daemon mode (no --once): the internal scheduler drives cycles on the
# configured interval; SIGTERM triggers a graceful drain (see entry.ts).
ENTRYPOINT ["npx", "tsx", "engine/entry.ts"]
