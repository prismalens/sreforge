# booklogr baseline instrumentation

`apply.py` adds Prometheus metrics to the booklogr substrate **at import time**,
as a normal commit on the imported baseline. It is the harness's only edit to
the substrate that is *not* an authored fault — it's the honest observability a
real team adds so the service can be operated.

## What it adds

| File | Change |
|------|--------|
| `pyproject.toml` | `prometheus-flask-exporter = "^0.23.2"` dependency |
| `api/app.py` | `GunicornPrometheusMetrics(app)` on the module-level app |
| `gunicorn.conf.py` (new) | `when_ready` / `child_exit` hooks → multiprocess metrics on `:9090` |
| `entrypoint.sh` | sets `PROMETHEUS_MULTIPROC_DIR`, runs gunicorn with the config file |
| `Dockerfile` | copies `gunicorn.conf.py` into the image; `EXPOSE 9090` |

## Why multiprocess mode

booklogr runs `gunicorn -w 4`. With multiple workers, each process keeps its own
in-memory registry, so scraping a per-worker `/metrics` returns one random
worker's numbers. prometheus-flask-exporter's multiprocess mode aggregates all
workers via a shared dir (`PROMETHEUS_MULTIPROC_DIR`) and serves one consistent
`/metrics` from the gunicorn master on a **dedicated port (9090)**, separate
from the app's request port (5000). Prometheus scrapes `booklogr-api:9090`.

This is the standard, correct way to instrument a multi-worker gunicorn service
— which is exactly why it reads as real engineering rather than staging. The
exporter auto-instruments **every** route uniformly (`flask_http_request_*`); it
is not tuned to any one endpoint.

## Properties

- **Idempotent** — safe to re-run; each edit is guarded by a marker check, and a
  missing anchor fails loudly rather than writing a half-applied file.
- **Uniform** — the exporter auto-instruments every route via its defaults;
  nothing is tuned to a specific endpoint.

## Usage

```bash
python3 apply.py <substrate-checkout-dir>
```

Invoked by `scripts/setup.sh` against the fresh checkout before the `healthy` branch is cut.
