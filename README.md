# sreforge

A running environment for testing [prismalens](https://github.com/prismalens/prismalens). It runs a real app, booklogr (Flask, React, Postgres), with Prometheus, Alertmanager and Grafana, all in docker compose. You switch a fault on, a real alert fires, and Alertmanager posts it to prismalens.

## Run it

Needs docker, Node 18+ and pnpm.

```bash
pnpm install
pnpm exec task up                                  # first run clones booklogr, takes a few minutes
pnpm exec task fault -- worker-cpu-starvation on   # commits the fault, redeploys, starts load, waits for the alert
pnpm exec task status
pnpm exec task fault -- worker-cpu-starvation off  # back to healthy, fresh database
pnpm exec task down
pnpm exec task dashboard                           # the same controls on http://127.0.0.1:7420
```

One fault is on at a time. Turning one on turns the current one off first.

## What runs

| Service | Where |
|---|---|
| booklogr app / API | http://localhost:5150 / http://localhost:5000 |
| Prometheus | http://localhost:9090 |
| Alertmanager | http://localhost:9093 |
| Grafana | http://localhost:3002 (anonymous viewer) |
| k6 load | only while a fault is on |

## Point an agent at it

An agent under test gets what a real one gets: the alert, the code, and the telemetry endpoints above. It never reads anything under `use-cases/*/scenarios/`, which hold the answers.

**Alerts.** Alertmanager sends every alert to one receiver. Set these before `task up`:

| Variable | Default |
|---|---|
| `AGENT_WEBHOOK_URL` | `http://host.docker.internal:3001/api/webhooks/prometheus` (prismalens `pl up`) |
| `AGENT_WEBHOOK_TOKEN`, or `AGENT_WEBHOOK_TOKEN_FILE` | none; sent as `Authorization: Bearer <token>` |

`task status` shows Alertmanager's own count of webhook deliveries sent and failed.

**Code.** Each alert carries a `service` label, and each service has its own git repo, outside sreforge. Register each one with the agent by this folder, never by a folder inside sreforge, whose top level holds every scenario's answer:

| `service` label | Code |
|---|---|
| `booklogr-api` | `use-cases/booklogr/stacks/flask-compose/substrate/booklogr`: booklogr's real history. `healthy` is the clean branch; a fault's commits sit on `main` above it. |
| `book-metadata` | `use-cases/booklogr/stacks/flask-compose/substrate/book-metadata` |

`task status` prints both paths.

**prismalens.** `pl doctor` prints the token file under "Webhook token"; pass it as `AGENT_WEBHOOK_TOKEN_FILE`. Create one prismalens service per row above, named exactly as the label, with the folder as its code. Two settings on the prismalens side let the container reach it:

- `pl up` binds 127.0.0.1 by default. Start it with `--host 0.0.0.0` (or `PRISMALENS_HOST=0.0.0.0`).
- prismalens rejects Host headers it doesn't know, with a 403. Set `PRISMALENS_ALLOWED_HOSTS=host.docker.internal`, or put the host-gateway IP in `AGENT_WEBHOOK_URL`.

Grouping is `group_by: ['alertname', 'service']`, so each delivery carries one alert name. Alertmanager keeps running across fault switches; only `task down` restarts it.

## Scenarios

Each folder under `use-cases/booklogr/scenarios/` is one fault:

- `fault.env`: what `task fault` commits, the runtime setting, the load
- `README.md`: what breaks
- `verify/oracle.md` and `solution/fix.patch`: ground truth for grading

| Scenario | What breaks |
|---|---|
| `latency-cache-stampede` | response cache disabled; search piles up on a slow upstream |
| `red-herring-coalert` | the same, plus an unrelated upstream 5xx rate |
| `decoy-deploy-control` | cache backend drifted at runtime; the newest commit is innocent |
| `db-pool-exhaustion-deploy` | a deploy shrinks the DB pool to one connection |
| `worker-cpu-starvation` | a deploy sorts the whole library in Python on every request |
| `cascading-upstream-failure` | a migration drops the index behind the library listing |
| `compound-latency-pool-and-sort` | two regressions from two authors, days apart |

To add one, copy a folder, write its `fault.env` and `inject/` changes, and give it a `scenario.toml` title.

## Grading

`tools/rca-judge` scores an RCA against a scenario's `verify/oracle.md`. There is no run engine. Grading whole runs is planned as Harbor tasks (see the eval-layer issue).

## Checks

`pnpm test` runs the tests. `pnpm rules-lint` checks that every alert rule carries a `service` label.
