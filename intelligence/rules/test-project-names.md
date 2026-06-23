# Test Project Name Hygiene

> **The only place a real test/client project name may appear in this repository is the bootstrap test config (`config/repos.yaml`).** Everywhere else uses generic placeholders so the operator codebase reads as a product, not as the artifact of one customer's deployment.

This rule applies to source files (`engine/`, `packages/`, `app/`), tests, comments, docstrings, examples, fixtures, documentation (`docs/**` including archives), intelligence content (`intelligence/**`), CI workflows (`.github/**`), and dev scripts (`dev/**`).

## FORBIDDEN

- **🚨 Naming a real customer / sandbox project in code, comments, tests, fixtures, docs, intelligence files, CI workflows, dev scripts, env-var names, secret names, file names, or directory names.** This includes every case variant — `<name>` / `<Name>` / `<NAME>` — of any project used as a test bed.
- **🚨 Embedding the project name in fixture string content** such as csproj paths, error message samples, repo slugs, or PR body excerpts. Replace with generic equivalents (`Sample`, `repo`, `owner/<repo-id>`).
- **🚨 Embedding the project name in environment variable names** (e.g. `<NAME>_GH_TOKEN`). Use a role-based name like `MANAGED_REPO_GH_TOKEN`. The bootstrap config and CI workflow must agree on the role-based name; the actual GitHub secret can be renamed by the operator once.
- **Attributing observations to a real project in comments** ("Discovered on `<customer>` T20260411…", "live `<customer>` cycles show…"). Drop the attribution; keep the technical content. Commit messages already carry the context for anyone who needs the history.
- **Project-name-prefixed file names** (e.g. `migrate-<customer>-data.mjs`). Use the role the file plays (`migrate-data.mjs`, `normalize-status.mjs`).

## REQUIRED

- **Generic placeholders in fixtures and examples.** Tests use `repoId: "sample"`, `projectId: "sample"`, `PROJECT_NAME: "SAMPLE"`, `owner/sample`, fixture-content paths under `Source/Backend/Sample/`.
- **`<repo-id>` placeholder** inside code blocks / backticks in docs and help text (`--repo <repo-id>`). In prose, prefer "a managed repo" or "the sample demo config" — never use the literal customer name.
- **Single allowed exception**: `config/repos.yaml` (the instance repo binding — gitignored and local-only; the committed generic template is `config/repos.yaml.example`). This file is the one place where the real repo identifier, GitHub slug, and any per-repo overrides live. Everything else stays neutral.

## Why

Mixing customer / sandbox project names into the engine codebase leaks deployment specifics into a product that is meant to run for many repos and customers. It also creates churn the day the test project changes — every comment, fixture, and doc reference becomes wrong at once. Keep the codebase neutral; let the bootstrap config carry the one-off binding.

## How to enforce

- New code review: any new occurrence of a customer / sandbox name outside `config/repos.yaml` is a blocker.
- Pre-commit search (recommended): `git diff --cached -- ':!config/repos.yaml' | grep -i '<known-customer-names>'` should return no matches.
- When adopting the operator for a new test bed, only `config/repos.yaml` changes. The codebase stays as-is.
