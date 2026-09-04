# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.6.x   | Yes — current release line |
| < 0.6   | No |

Only the current release line receives security fixes. Operator is pre-1.0; upgrade
to the latest 0.6.x before reporting.

## Reporting a vulnerability

**Report privately through GitHub, not in a public issue.**

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability** to open a private advisory.
3. Include the affected version or commit, reproduction steps, and the impact you
   observed.

Private vulnerability reporting is enabled on this repository and is the only
channel for security reports. Please do not open a public issue, a pull request, or
a discussion thread for a suspected vulnerability — that discloses the problem before
a fix exists.

## What to expect

- **Acknowledgement** within 3 working days.
- **Initial assessment** — whether the report is accepted, and a severity — within
  10 working days.
- **Progress updates** on the advisory thread until the report is resolved or closed.
- Fixes land on the current release line; the advisory is published once a fixed
  version is available.

These are best-effort targets for a small maintainer team, not a contractual SLA.

## Scope

In scope: the engine (`engine/`), the shared packages (`packages/core`,
`packages/adapters`), the observability UI (`app/`), and the deployment manifests
under `deployment/`.

Operator is an autonomous orchestrator: it runs with a git host token that has repo
scope, executes an external agent CLI, and pushes branches and opens pull requests on
the repositories listed in `config/repos.yaml`. Findings that let an attacker widen
that blast radius — token exfiltration, escaping the managed workspace, injecting
instructions that reach the agent CLI, or pushing outside the configured repositories
— are the highest-value reports.

Out of scope: vulnerabilities in the external agent CLIs themselves (report those to
their maintainers), and issues that require an already-compromised host or an operator
deliberately configuring a hostile repository.
