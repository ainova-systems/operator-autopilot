---
name: intelligence-add-agent
description: "Create new specialized agent"
argument-hint: <domain> [description]
---

# Add Agent

## Steps

1. **Determine domain prefix** (the scope is required):
   - **Reuse the existing domain when one fits**: list `intelligence/agents/` and `intelligence/skills/`. If a domain prefix is already established for the target area (`backend-`, `frontend-`, `devops-`), use it. Introduce a new domain only when the scope is materially different from all existing ones.
   - **When no existing domain fits**, derive from repo structure:
     - Single / root project → use the project codename from `intelligence/config.yaml` → `project.name`
     - Backend service / API component → `backend-`
     - Frontend / web / UI component → `frontend-`
     - Infrastructure, IaC, CI/CD, deployment → `devops-`
     - Shared library / common / cross-cutting code → `core-`
     - Test suites (e2e, integration) → `tests-`
     - Tool-internal (intelligence-sync itself) → `intelligence-`
   - If the repo is a monorepo with named components (e.g., `apps/billing`, `services/auth`), prefer the component name as the domain (`billing-`, `auth-`).
   - **Every agent needs a domain prefix.** If the scope is unclear, ask the user before proceeding.

2. **Check existing agents**: Read `intelligence/agents/` to avoid duplicates. If an agent for this domain exists, ask user whether to update it instead.

3. **Determine tier and access**:
   - Developer agents: `tier: heavy`, `access: full`
   - Reviewer/validator agents: `tier: standard`, `access: readonly`
   - Simple lookup agents: `tier: light`, `access: readonly`

4. **Analyze codebase**: Read source files in the domain's directory to determine:
   - Technology stack and frameworks
   - Architecture patterns
   - Build and test commands
   - Key conventions and forbidden patterns

5. **Create agent**: Write `intelligence/agents/<domain>-<role>.md` with frontmatter:
   ```yaml
   ---
   name: <domain>-<role>
   description: "<when to use this agent — IDEs use this to suggest the agent>"
   tier: heavy|standard|light
   access: full|readonly
   skills:
     - <existing-skills-for-this-domain>
   ---
   ```

   **YAML safety (required):** **always wrap `description` (and any other free-text string field) in double quotes**, regardless of content. Codex CLI uses strict YAML — an unquoted colon, leading hyphen, or word that parses as boolean (`yes`, `no`, `true`) silently breaks the agent. Quoting unconditionally prevents the entire class of bug. If the value itself contains a double quote, escape it as `\"` or wrap it in single quotes so an inner quote does not terminate the scalar early.

6. **Write body** with sections: **Expertise** -> **Before Any Task** -> **Build & Verify**
   - "Before Any Task" must reference: `Read intelligence/rules/<domain>.md before starting`
   - All content must come from actual codebase analysis

7. **Link existing skills**: Find skills in `intelligence/skills/` matching this domain prefix and add them to the agent's `skills:` frontmatter.

8. **Run `/intelligence-sync`** to distribute to all enabled IDE targets.
