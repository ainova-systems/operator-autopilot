---
name: intelligence-add-rule
description: "Create new intelligence rule"
argument-hint: <name> [paths-glob]
---

# Add Rule

## Steps

1. **Determine rule name from domain** (the scope is required):
   - **Reuse the existing domain when one fits**: list `intelligence/rules/`. If a rule file covers the target area (e.g., `backend.md`, `frontend.md`), extend it. Introduce a new domain only when the scope is materially different from all existing rules.
   - **When no existing rule fits**, derive the filename from repo structure:
     - Single / root project → use the project codename from `intelligence/config.yaml` → `project.name` (e.g., `<codename>.md`)
     - Backend service / API component → `backend.md`
     - Frontend / web / UI component → `frontend.md`
     - Infrastructure, IaC, CI/CD, deployment → `devops.md`
     - Shared library / common / cross-cutting code → `core.md`
     - Test suites (e2e, integration) → `tests.md`
     - Always-loaded global context → `context.md`
   - If the repo is a monorepo with named components (e.g., `apps/billing`, `services/auth`), prefer the component name as the rule name (`billing.md`, `auth.md`).
   - **Rule filenames match the domain used by skills/agents.** If the scope is unclear, ask the user before proceeding.

2. **Check existing rules**: Read `intelligence/rules/` to detect overlapping scope — favor extending an existing rule over creating a new one.

3. **Determine scope**:
   - If paths glob provided — scoped rule with `paths:` frontmatter
   - If no paths — always-loaded rule (no `paths:` in frontmatter)

4. **Analyze codebase**: Read source files matching the scope to extract:
   - REQUIRED patterns (conventions consistently followed across the codebase — judgment calls expressed as positive defaults)
   - Invariants (true must-nots — safety, output format, security; not judgment calls)
   - Architecture patterns (layer dependencies, module structure)
   - Build and test commands specific to this scope
   - Anti-patterns observed in code, each paired with the positive replacement that should adopt instead

5. **Create rule**: Write `intelligence/rules/<name>.md`:
   ```yaml
   ---
   paths:
     - "<glob-pattern>"
   ---
   ```

6. **Write body** with sections: **REQUIRED** → **Invariants** → **Architecture** → **Build & Test** → **Examples** → **Patterns to recognize and replace** (optional)
   - Lead with REQUIRED (positive defaults) — the LLM follows the positive instruction first
   - Reserve **Invariants** for true must-nots — security, safety, output format. Use absolute language (MUST / NEVER) only here, never for judgment calls
   - **Patterns to recognize and replace** is reference documentation of anti-patterns paired with positive replacements — readers recognize the pattern, apply the replacement
   - Examples come from the actual codebase — reference real files
   - Every REQUIRED / Invariant / Pattern is backed by observed code

7. **Update config.yaml** if needed: Add source path to `sources.rules` if rule is in a new directory not yet listed.

8. **Run `/intelligence-sync`** to distribute to all enabled IDE targets.
