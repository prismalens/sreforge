# Security Policy

## Supported versions

sreforge is pre-1.0 and ships from a single line of development on `main`.
Security fixes land on `main` (and the latest tagged release); there are no
maintained release branches.

| Version | Supported |
| ------- | --------- |
| `main` / latest release | yes |
| older tags | no — please upgrade |

## Reporting a vulnerability

**Please do not report security issues through public GitHub issues.**

Use GitHub's private vulnerability reporting:

- Go to the repository's **Security** tab and choose
  **[Report a vulnerability](https://github.com/prismalens/sreforge/security/advisories/new)**.

If you cannot use that, email **sumitpatel.14may@gmail.com** with the details.

Please include:

- A description of the issue and its impact.
- Steps to reproduce or a proof of concept.
- The affected commit or release and your environment.
- Any suggested remediation, if you have one.

Do **not** include real secrets, tokens, or private content in your report.

## What to expect

- Acknowledgement within a few days.
- An assessment of severity and a fix plan for confirmed issues.
- Credit in the release notes if you would like it.

## Scope notes

sreforge is a local docker compose environment operated by a human. It
deliberately:

- keeps secrets out of the repository: `.secrets/` (the prismalens webhook
  token) and the `substrate/` checkout are gitignored and never committed;
- serves its dashboard on 127.0.0.1 only;
- pins dependencies via lockfiles, watched by Dependabot.

Reports that strengthen those guarantees, for example a path that leaks the
webhook token into tracked files, are especially valuable.
