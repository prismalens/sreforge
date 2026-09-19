# booklogr rig scripts

These scripts bring up the rig and run one graded incident. They run in a fixed
**phase sequence**; most are **entry-points** you invoke, a few are **sub-steps**
called by an orchestrator, and two are **sourced helpers**. The flat directory
hides that structure — this file (and the `Taskfile.yml` one level up) restores it.

> None of these are visible to the agent. The agent clones `substrate/booklogr`
> into `.run-workspace/booklogr`; `scripts/` is a sibling and never enters
> `/workspace`. So this is purely operator ergonomics — reorganise freely.

## Run via forge (recommended)

The lifecycle is a runnable table-of-contents in `../Taskfile.yml`
([go-task](https://taskfile.dev)), driven through the repo's neutral dispatcher
`pnpm forge <verb> <use-case>` — the **verb** is use-case-neutral, the
**use-case** is a parameter. `task` is a **pinned devDependency** (`@go-task/cli`
in the root `package.json`), not a global install — so run `pnpm install` once at
the repo root, then:

```sh
pnpm forge menu     booklogr   # the phase menu (task --list)
pnpm forge setup    booklogr   # once:    import substrate + author regression
pnpm forge up       booklogr   # session: bring up the deploy plane
pnpm forge quiesce  booklogr   # run:     quiesce observability plane before arm (#74)
pnpm forge arm      booklogr   # run:     reset to baseline, start storm, confirm alert fires
pnpm forge agent    booklogr   # run:     clean /workspace clone + bring up the sandbox
pnpm forge run      booklogr   # run:     drive the incident end-to-end  (append RUNNER=external for the real-agent loop)
pnpm forge verify   booklogr   # any:     boundary + de-tell + alert-pickup probes, in PARALLEL
pnpm forge down     booklogr   # end:     tear down deploy + load planes
pnpm forge smoke    booklogr   # CI:      positive (reference fix passes) + negative (anti-cheat holds)

# Composites — one command, several phases:
pnpm forge fresh    booklogr   # setup + up                              (first-time cold bring-up)
pnpm forge agent-up booklogr   # arm + agent                            (ready to exec a real agent in)
pnpm forge incident booklogr   # arm + run + verify                     (one graded run on an up stack)
pnpm forge e2e      booklogr   # setup + up + arm + run + verify + down (cold-start -> teardown)

# For raw task flags (dry-run / watch / list), call the binary directly:
pnpm exec task --dir use-cases/booklogr/stacks/flask-compose -n run     # -n = dry-run
```

Two things the runner adds over bare scripts: `build-core` is **skipped when
core's sources are unchanged** (change-detection), and `verify` runs its three
probes **concurrently** (parallelism). The root `package.json` allowlists
`@go-task/cli` under `pnpm.onlyBuiltDependencies` so its install step (which
downloads the Task binary) is permitted under pnpm's default script blocking.

## Phase order & roles

| Phase | When | Entry-point | Sub-step (called by ↑) | Helper |
|---|---|---|---|---|
| **build** | on `run` | — | `run-incident.mjs` builds via `core/` | — |
| **setup** | once | `import-substrate.sh`, `inject-regression.sh` | | |
| **bring-up** | per session | `up.sh` | | |
| **quiesce** | pre-arm | `quiesce.sh` | `confirm-quiesced.mjs` | |
| **arm** | per run | `arm-incident.sh` | `confirm-fire.mjs` | |
| **agent** | per run | `prepare-agent-workspace.sh` | `preflight-agy.sh` (pre-flight for `agent-agy.sh`) | |
| **run** | per run | `run-incident.mjs` | `confirm-runner.mjs` (pre-flight), `warm-cache.sh` (readiness gate) | |
| **verify** | any time | `verify-boundary.sh`, `verify-alert-pickup.sh`, `verify-detell.sh`, `verify-clear.mjs` | | |
| **teardown** | end | `down.sh` | | |
| **smoke** | CI/e2e | `smoke-positive.sh`, `smoke-negative.sh` | (each re-arms, then runs) | |
| **diag** | any time | `status.mjs` | | |
| **—** | — | | | `lib-deploy.sh`, `lib.mjs` (sourced, never run directly) |

> Note: `arm-regress.sh` reconciles the persisted Postgres DB revision against the incoming scenario's migration tree and resets the `booklogr_pgdata` volume when it is foreign (#79), then seeds post-deploy if the scenario seeds.

`fixtures/no-op-fix.patch` is data (the deliberately-wrong fix the negative smoke
asserts against), not a script.

## Run standalone

Every script self-resolves its own paths, so you can still run any of them directly
from anywhere, e.g. `bash scripts/arm-incident.sh`. The one thing the Task runner
does for you that you must do by hand standalone: **load `.env`** before
`run-incident.mjs` (it reads `GITEA_TOKEN` etc. from the environment):

```sh
set -a; . ./.env; set +a
node scripts/run-incident.mjs --run-id my-run        # RUNNER=external for the real agent
```

The `smoke-*.sh` scripts already source `.env` themselves, so they need no setup.

`verify-clear.mjs` can also be run standalone to verify sustained alert clearance:

```sh
node scripts/verify-clear.mjs --alert=BooklogrApiLatencyP99High --sustain=360 --timeout=600
```

- `--sustain`: Seconds the alert must stay cleared under load (defaults to `360`).
- `--timeout`: Maximum seconds allowed for the alert to clear (defaults to `600`).

`confirm-runner.mjs` runs pre-flight before incident execution:
1. Container check (`sreforge-runner` container must be running).
2. Gitea API registration authority (`GET /api/v1/admin/actions/runners` using `GITEA_ADMIN_USER`/`GITEA_ADMIN_PASSWORD` from `.env`); passes only if at least one runner is `online` and `disabled !== true`.
3. Log matching fallback (`declare successfully` / `runner registered successfully` in container logs) used only when the Gitea API is unreachable, emitting a non-authoritative warning. Exit code is `86` if not running or unregistered.

`preflight-agy.sh` runs fast preflight checks before the agy agent driver launches (srt on PATH and runnable, agy auth/quota, WSL NAT mode, and provider resolvable). Supports `--skip-probe` to bypass the live agy model probe (used in `doctor.mjs`).


## When use-cases multiply

This `Taskfile.yml` is stack-local on purpose, and the neutral dispatcher already
scales: a second use-case is `pnpm forge <verb> rssmonster` with **no new
wiring** — `tools/usecase.mjs` resolves `<use-case>[:<stack>]` to its stack dir
and runs the same phase verbs here. A use-case with more than one stack is
addressed as `pnpm forge run booklogr:flask-compose`. The phase *values* that are
booklogr-specific (alert name, service, repo) still live in this stack's scripts;
lifting those into a per-use-case config is the natural next step when the second
stack lands. The repo-wide *build* graph (Turborepo/Nx) is a separate seam from
this *lifecycle* layer.
