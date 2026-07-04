---
path: "*"
schedule: daily
---

# Security Audit Rules

Project-specific security + supply-chain checks. Authoritative sources:
`intelligence/rules/typescript.md` (§Dependency Security),
`intelligence/rules/context.md`, and `intelligence/rules/test-project-names.md`.

## Git & branch safety
- Any force-push (`git push --force`, `--force-with-lease`, `+refspec`) — P1 blocker. Fast-forward only.
- Any push or PR head ref targeting `master` / `main` / `develop` — P1 blocker. Operator authors only `ai/<kind>/<id>` branches; merges to base are human-only.
- Branch create/checkout logic outside the `WorkspaceScope` primitive.

## Secrets & configuration
- Hardcoded tokens, API keys, or credentials in source, tests, fixtures, or CI workflows — P1. Tokens come from env vars (`.env.local`, gitignored) referenced via `tokenEnvVar` in `config/repos.yaml`.
- Environment-variable names must be role-based (e.g. `MANAGED_REPO_GH_TOKEN`), never project-name-prefixed — see `intelligence/rules/test-project-names.md`.
- Real customer / sandbox project names anywhere except `config/repos.yaml` (comments, fixtures, docs, CI, env/secret names, file names) — P2.

## Supply chain (dependencies)
- New runtime dependency from an untrusted / unmaintained (no commits in 12+ months) publisher, or with <1000 weekly downloads — P1. Trusted publishers only (see the approved-deps table).
- `npm audit` must be clean — zero-vulnerabilities policy. Native bindings (`better-sqlite3`) pinned to exact versions.
- Prefer Node.js built-ins over new npm packages.

## External input handling
- External / boundary data (agent output, GitHub API responses, YAML config) parsed without Zod validation, or agent output parsing not wrapped in try/catch with a typed `AgentError` — P2.
- Octokit list calls that assume a single page instead of `.paginate()` — P2.

## Command tooling
```
npm audit --omit=dev        # supply-chain check (expect zero vulnerabilities)
npm run lint                # eslint no-restricted-imports enforces boundaries
```
