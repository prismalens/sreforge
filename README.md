# SREForge

A contamination-controlled, event-triggered **evaluation harness for autonomous
SWE/SRE agents**. SREForge authors incidents on controlled substrates, hands an
agent a neutral on-call page, and grades the agent on whether its **deployed
fix actually resolves the incident** — verified behaviourally, under the
still-active fault. You cannot bluff a behavioural oracle.

📖 **Documentation:** <https://sreforge.sfun.cloud/>

## Why it's different

- **Closed-loop behavioural verification (the signature capability).** The fault
  stimulus keeps running while the fix is verified. An alert clears only because
  the deployed change works — not because the harness stopped poking the system.
  This is the anti-cheat: diff-matching is at most a hint, never the grade.
- **Contamination-free by construction.** v1 substrates are self-built, so there
  is no public solution to memorise. Adopted third-party apps get a de-tell pass
  before use.
- **Authored, reproducible incidents.** A determinism gate confirms the incident
  has actually reproduced before the agent is ever handed the page.
- **Honest, neutral framing.** The agent is never told it's in a harness.
- **Ambient-realism baseline.** SREForge stack deployments include an ambient-realism baseline representing background infrastructure activity, periodic system telemetry, and standard deployment updates.

## Taxonomy

Four axes:

| Axis | What | Example |
|------|------|---------|
| **engine** | the domain-agnostic harness | `core/` |
| **use-case** | a problem domain | `booklogr` |
| **stack** | a concrete deployable substrate | `flask-compose` |
| **scenario** | one authored incident on a stack | `latency-cache-stampede` |

Two scenario **profiles**: `incident` (live deploy + behavioural verify — the
focus of v1) and `patch` (DeepSWE-style pinned repo + hidden tests, deferred).

## Layout

```
core/                                  # @sreforge/core — the engine (TypeScript)
  src/{triggers,context,runner,deploy,verify,record,cleanup}/  conductor.ts
infra/forge/                           # shared Gitea + Actions runner (project sreforge-forge)
use-cases/
  booklogr/
    stacks/flask-compose/              # the substrate overlay: Flask API (gunicorn -w4)
      compose/docker-compose.yml       #   + Postgres + slow-upstream stub + Prometheus/
      compose/load.yml                 #   Alertmanager/Grafana; load.yml = isolated load plane
      observability/                   # prometheus.yml, alertmanager.yml, rules/
      load/booklogr-storm.js           # k6 constant-arrival-rate storm
      scripts/                         # up · down · arm-incident · confirm-fire · run-incident
    scenarios/
      latency-cache-stampede/          # the authored incident (scenario.toml, solution, oracle)
      db-pool-exhaustion-deploy/       # second scenario
      decoy-deploy-control/            # third scenario
      worker-cpu-starvation/           # fourth scenario (multi-alert storm; certification-pending)
mage/                                  # pointer to the external knowledge-base hub
```

The durable design knowledge lives in an external **mage** hub
(`sreforge-kb`); this repo's `AGENTS.md` explains how to navigate it.

## Scenarios and selection

The `booklogr` use-case ships four scenarios (each with a `README.md` in its `scenarios/<id>/` directory):
- `latency-cache-stampede`: A disabled search cache + storm causes p99 latency alerts.
- `db-pool-exhaustion-deploy`: A bad config deploy exhausts connection pools.
- `decoy-deploy-control`: A control scenario.
- `worker-cpu-starvation`: A full-library re-sort on the hot read path CPU-starves the workers, producing a multi-service alert storm (booklogr-api latency + book-metadata traffic collapse). **Certification-pending** (ADR-0026) — authored but not yet certified.

Select a scenario by passing the **`SCENARIO_ID=<id>`** variable to `pnpm forge` tasks. If omitted, the stack's Taskfile defaults it to `latency-cache-stampede`.

### Run it

Requires Docker (compose) + Node 18+. Run `pnpm install` once at the repo root,
then drive any use-case through the neutral dispatcher `pnpm forge <verb>
<use-case>` — the **verb** is use-case-neutral vocabulary, the **use-case** is a
parameter:

```sh
pnpm forge fresh    booklogr   # setup + up: import substrate, author regression, start the deploy plane
pnpm forge incident booklogr   # arm + run + verify: one graded run with the reference fix
pnpm forge down     booklogr   # tear down the deploy + load planes (the forge persists)
```

**Driving a real external SRE agent** (instead of the scripted reference fix):

```sh
pnpm forge fresh    booklogr            # first-time cold bring-up
pnpm forge agent-up booklogr            # arm the incident + bring up the sealed agent sandbox
#   Egress is DEFAULT-DENY: the box has zero external internet (closes the
#   retrieval hole). For a cloud-model agent, allow just its provider:
#     pnpm forge arm booklogr && pnpm forge agent booklogr EGRESS_ALLOWLIST=api.anthropic.com
# place the agent INTO the sandbox as the NON-root agent (it self-serves alerts; no docker):
DEPLOY_NETWORK=booklogr_default API_URL=http://booklogr-api:5000 \
  docker compose -p sreforge-agent -f infra/agent-sandbox/agent.yml \
  exec -u "$(id -u):$(id -g)" agent-shell sh
#   → agent investigates via $ALERTMANAGER_URL / $PROM_URL / $API_URL, edits /workspace, calls `submit` (a postmortem attachment is standard practice, but the `--rca` flag is optional)
pnpm forge run      booklogr RUNNER=external   # engine: sentinel → forge push → CI → merge → redeploy → grade
pnpm forge verify   booklogr            # boundary + de-tell + alert-pickup + egress probes
```

Lower-level entry points (each script self-resolves and still runs standalone):

```sh
cd use-cases/booklogr/stacks/flask-compose
bash scripts/smoke-positive.sh   # reference fix through the full conductor loop: must PASS
bash scripts/smoke-negative.sh   # a plausible-but-wrong fix: must NOT pass (ADR-0004 anti-cheat)
```

Endpoints once up: API `http://localhost:5000` · web `:5150` · Prometheus `:9090` ·
Alertmanager `:9093` · Grafana `:3002` · Gitea forge `:3000`.

## Status

**Current version: `0.0.2`** — v2 in progress (increments so far: the agent-sandbox
egress allowlist, the MCP telemetry seam + provider run-selection, the operator
control dashboard, and the automated alert-push trigger). v1 shipped as `0.0.1`.

v1 is validated end-to-end on the `booklogr` use case: the `core/` engine's
**Conductor** drives the full incident loop (trigger → context → run → CI gate →
merge → redeploy → behavioural verify → record → cleanup) against a live,
already-firing incident. The agent seam (`AgentRunner`) is currently exercised by
a scripted reference fix; wiring a real autonomous agent through it is the next
milestone. See `mage/` (the knowledge-base hub) for the full plan and decisions.

### Versioning

The version tracks roadmap milestones, not semver releases — one minor-patch step
per milestone:

| Version | Milestone | State |
|---|---|---|
| `0.0.1` | **v1** — prove the incident loop on an imported real app | shipped |
| `0.0.2` | **v2** — breadth + research depth (real-agent integration, RCA oracle, de-tell hard gates, more substrates) | in progress |

v2 is underway. Increments so far: the default-deny **agent-sandbox egress
allowlist** (closes the retrieval hole so a real external agent can be trusted in
the box), the read-only **MCP telemetry seam** + provider run-selection
(ADR-0023), the **operator control dashboard** (ADR-0024), and the **automated
alert-push trigger** — Alertmanager pushes the firing notification to the box and
the agent self-starts (`pnpm forge auto <use-case>`, ADR-0025).

<!-- live test, gh-workflows #183 #200: close, do not merge -->