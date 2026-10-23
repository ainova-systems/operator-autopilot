# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| latest  | Yes — current release line |
| older   | No |

Only the current release line receives security fixes. Operator is pre-1.0; upgrade
to the latest release before reporting.

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

In scope: the runtime (`src/`), its CLI, and the service and container definitions under
`deploy/` and `Dockerfile`.

Operator runs a project's scripts and agent CLIs with the credentials of the host user, and holds
an Ainoflow key for its state. Findings that widen that blast radius - exposing the Ainoflow key
or a project secret, running an operation the manifest does not define, letting a trigger or a
result file inject a command, or making one project's runs act on another project's state - are
the highest-value reports.

Out of scope: vulnerabilities in the external agent CLIs themselves (report those to
their maintainers), and issues that require an already-compromised host or an operator
deliberately configuring a hostile repository.
