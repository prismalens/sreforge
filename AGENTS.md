# AGENTS.md

Instructions for AI coding agents working in this repository.

<!-- BEGIN mage -->
## mage knowledge base (external hub)

This repository's durable knowledge lives in an external **mage hub** at
`/home/sumit/.mage/hubs/github.com/prismalens/sreforge-kb`, where this repo is the **sreforge** project. mage is a portable,
file-based knowledge base of notes — insight, procedure, and pointers (not
copies of sources) — navigable as an Obsidian graph.

**Before non-trivial work in this repo:**

1. Read the hub index first: `/home/sumit/.mage/hubs/github.com/prismalens/sreforge-kb/INDEX.md` — find the **sreforge** wing (its
   notes are grouped there; in a large hub the wing links out to its own
   `/home/sumit/.mage/hubs/github.com/prismalens/sreforge-kb/_index.sreforge.md`). One line per note: type · title · keywords · → link. Open
   only the notes the task touches; don't read everything.
2. Skim `/home/sumit/.mage/hubs/github.com/prismalens/sreforge-kb/decisions/` for the hub's governing decisions.
3. Treat notes as point-in-time. If a note is `status: stale-suspect`, or its
   `last_reviewed` / `provenance.commit` looks old, verify it against the
   current code before relying on it.

**After you learn something durable** — an interface detail, a gotcha, how two
services couple, a faster path to a source — capture it with `mage:learn` into
the hub. Capture the reusable *insight + procedure + pointers*, never a copy.

**Commit hygiene:** mage never commits for you. It suggests `git` commands; you
run them.
<!-- END mage -->

## Scenarios and alert rules

Every alert rule under `observability/rules/*.yml` carries a `service` label; `pnpm rules-lint` enforces it in CI.
A scenario is a folder under `use-cases/booklogr/scenarios/` with a `fault.env`; `scripts/fault.sh` is the only thing that reads it.
