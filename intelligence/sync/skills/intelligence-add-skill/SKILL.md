---
name: intelligence-add-skill
description: "Create new skill"
argument-hint: <domain> <verb-noun> [description]
---

# Add Skill

## Steps

1. **Determine domain prefix** (the scope is required):
   - **Reuse the existing domain when one fits**: list `intelligence/skills/` and `intelligence/agents/`. If a domain prefix is already established for the target area (`backend-`, `frontend-`, `devops-`), use it. Introduce a new domain only when the scope is materially different from all existing ones.
   - **When no existing domain fits**, derive from repo structure:
     - Single / root project → use the project codename from `intelligence/config.yaml` → `project.name`
     - Backend service / API component → `backend-`
     - Frontend / web / UI component → `frontend-`
     - Infrastructure, IaC, CI/CD, deployment → `devops-`
     - Shared library / common / cross-cutting code → `core-`
     - Test suites (e2e, integration) → `tests-`
     - Tool-internal (intelligence-sync itself) → `intelligence-`
   - If the repo is a monorepo with named components (e.g., `apps/billing`, `services/auth`), prefer the component name as the domain (`billing-`, `auth-`).
   - **Every skill needs a domain prefix.** If the scope is unclear, ask the user before proceeding.

2. **Determine naming**: Build full name as `<domain>-<verb>-<noun>` using convention:
   - `add-` — creates a single artifact (atomic)
   - `create-` — orchestrates multiple `add-` skills (MUST use `create-`, never `add-`)
   - `update-` — modifies existing files across stack
   - `run-` — executes an operation (tests, build, sync)
   - `review-` — read-only analysis

3. **Check for existing agent**: Find an agent in `intelligence/agents/` matching the domain
   - If found — this skill will be linked to that agent
   - If not — ask user whether to create a new agent via `/intelligence-add-agent` first

4. **Analyze codebase patterns**: Read existing implementations to extract the repeatable steps this skill should automate. Each step must come from actual code patterns, not generic knowledge.

5. **Create skill**: Write `intelligence/skills/<full-name>/SKILL.md` with frontmatter:
   ```yaml
   ---
   name: <full-name>
   description: "<what it does and when to use>"
   argument-hint: "<expected arguments>"
   agent: <matching-agent-name>
   ---
   ```

   **YAML safety (required):** **always wrap `description`, `argument-hint` and any other free-text string value in double quotes**, regardless of content. Codex CLI uses strict YAML — an unquoted colon in `description: Build retrospective: monthly` parses as a nested mapping and the skill is rejected at startup. Quoting unconditionally removes the whole class of bug and makes lint trivial. If the value itself contains a double quote, escape it as `\"` or wrap the whole value in single quotes — e.g. `description: 'Use as a quick "what do we have" view'` — so an inner quote does not terminate the scalar early.

6. **Write steps**: Numbered, concrete, executable. Include verification (build/test) at the end. For orchestrators — reference atomic skills by name.

7. **Update agent**: Add skill name to the `skills:` list in the matching agent's frontmatter.

8. **Run `/intelligence-sync`** to distribute to all enabled IDE targets.
