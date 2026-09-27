<!--
Thanks for contributing to sreforge! main is protected: every change lands via a
pull request with green CI. Keep PRs focused and small where you can.
-->

## What & why

<!-- What does this change do, and what problem does it solve? -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / internal
- [ ] Docs
- [ ] Build / CI / chore

## Checklist

- [ ] `core` builds (`cd core && pnpm build`) and any relevant tests pass locally
- [ ] No secrets or tokens committed; `.env` / `substrate/` left gitignored
- [ ] Did not modify the substrate under `use-cases/**` (it's the system under test)
- [ ] PR title follows Conventional Commits (`feat:`, `fix:`, `docs:`, ...)
- [ ] Docs / README updated if behavior changed

## Docs

- [ ] Docs updated for every changed operator/agent-facing surface (or none affected — explain)
- [ ] New/changed verbs, flags, env vars reflected in cli.md / relevant guide

## Related issues

<!-- e.g. Closes #123 -->
