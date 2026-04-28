# Security Policy

Thanks for helping keep Friday Studio and its users safe. This document
explains how to report a vulnerability and what to expect afterwards.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

Use one of the following private channels:

- **Preferred:** [GitHub private vulnerability reporting](https://github.com/friday-platform/friday-studio/security/advisories/new)
  — opens a confidential advisory only the maintainers can see.
- **Email:** [security@hellofriday.ai](mailto:security@hellofriday.ai).

Please include enough information for us to reproduce the issue:

- A description of the vulnerability and its impact
- Affected component(s) and version / commit SHA
- Step-by-step reproduction (proof-of-concept code or curl commands are
  ideal)
- Any logs, stack traces, or screenshots that help
- Whether the issue is already public or known elsewhere

If you found the issue while testing against a deployed instance you do not
own, please tell us so we can coordinate disclosure with the operator.

## What to expect

- **Acknowledgement** within **3 business days** of your report.
- **Initial assessment** (severity, affected versions, reproducibility)
  within **7 business days**.
- **Status updates** at least every **14 days** until the issue is resolved
  or closed.
- **Coordinated disclosure**: we'll agree on a disclosure timeline with you
  before publishing. Default is up to **90 days** from the initial report,
  shorter if a fix ships sooner, longer only by mutual agreement.

We will credit you in the published advisory and release notes unless you
ask to remain anonymous.

## Scope

In scope:

- The Friday Studio source code in this repository (daemon, CLI, web
  client, Go services, packages).
- Build and release artifacts produced from this repository (installers,
  Docker images, published packages).
- Default configuration shipped in this repository.

Out of scope:

- Vulnerabilities in third-party dependencies that are already publicly
  disclosed and tracked upstream — please report those to the upstream
  project. If a dependency vulnerability has a Friday-specific exploit
  path, that is in scope.
- Issues that require physical access to a user's machine, a compromised
  OS, or a malicious local user with admin rights.
- Self-inflicted misconfiguration of self-hosted instances (e.g. exposing
  the daemon to the public internet without authentication).
- Findings from automated scanners without a demonstrated exploit.
- Social engineering of maintainers or users.

## Supported versions

Friday Studio is pre-1.0. Security fixes are applied to the `main` branch
and shipped in the next release. We do not currently backport fixes to
older releases — please run a recent build.

| Version            | Supported          |
| ------------------ | ------------------ |
| `main` (latest)    | :white_check_mark: |
| Older releases     | :x:                |

## Safe harbor

We will not pursue legal action against researchers who:

- Make a good-faith effort to comply with this policy.
- Avoid privacy violations, destruction of data, and degradation of
  service to others.
- Only test against systems they own, or that they have explicit
  permission to test.
- Give us reasonable time to investigate and remediate before any public
  disclosure.

If in doubt about whether your testing falls within this policy, email
[security@hellofriday.ai](mailto:security@hellofriday.ai) and ask first —
we'd much rather have that conversation than not.
