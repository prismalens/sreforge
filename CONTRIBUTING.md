# Contributing to sreforge

Thanks for your interest in sreforge, a running environment for testing
prismalens: booklogr, Prometheus and Alertmanager in docker compose, with faults
you switch on.

## Ground rules

- **`main` is protected.** Every change lands through a pull request with green
  CI. Direct pushes to `main` are not allowed (for anyone, including the
  maintainer).
- **Never commit secrets or the booklogr checkout.** `.secrets/` and
  `substrate/` are gitignored on purpose.
- Keep PRs focused. One logical change per PR makes review fast.

## Development setup

Requirements: docker, **Node >= 18** and **pnpm** (`corepack enable` selects the
pinned version). See the [README](README.md) to run the env.

```bash
pnpm install
pnpm test         # rules-lint, rca-judge and dashboard tests
pnpm rules-lint   # every alert rule carries a service label
```

## Making a change

1. **Branch** off `main`: `git checkout -b fix/short-description`.
2. Make the change. Add or update tests where it makes sense.
3. Make sure `pnpm test` passes locally.
4. **Commit** using [Conventional Commits](https://www.conventionalcommits.org/):
   `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `ci:`, `perf:`.
   The PR *title* must also be a conventional commit — it becomes the squash
   commit subject and is linted by CI.
5. **Open a PR** against `main`. CI must be green before it can merge.

## Knowledge base (for agents)

This repo's durable design notes live in an external, maintainer-private
knowledge hub; [AGENTS.md](AGENTS.md) explains how AI coding agents should work
here. External contributors don't need the hub — the code, this guide, and the
in-repo READMEs are self-contained.

## Code style

- Small, cohesive files (prefer many small files over few large ones).
- Explicit error handling; fail fast at boundaries with clear messages.
- No `console.log` debris and no hardcoded secrets.

## Reporting bugs and requesting features

Use the issue templates. For anything security-sensitive, **do not open a public
issue** — see [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
