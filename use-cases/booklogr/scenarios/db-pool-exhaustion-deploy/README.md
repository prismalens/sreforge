# DB pool exhaustion blocks workers on uncached reads

A recent deploy-time configuration change reduces the SQLAlchemy database connection pool to a single connection and switches the Gunicorn worker model to threaded (gthread, threads=8). The uncached `/v1/books` library list route hits Postgres on every request. Under moderate library-read load, concurrent request threads within a worker process pile up on that process's single database connection, serializing all uncached reads. As threads block on database I/O, the workers become starved, causing even cached endpoints like `/v1/books/search` to queue and time out. This drives p99 request latency above the 300ms SLO and triggers the BooklogrApiLatencyP99High alert. The fix must restore a sufficient database connection pool size so that database reads can proceed concurrently and Gunicorn workers do not back up.

## Switch it on

```bash
task fault -- db-pool-exhaustion-deploy on     # fires BooklogrApiLatencyP99High
task fault -- db-pool-exhaustion-deploy off
```

Load while on: k6 `booklogr-storm-mixed.js` at 25 requests/s, library seeded to 150,000 books.

## What changes in the booklogr checkout

Commits on top of `healthy`, newest last:

- "Reduce DB connection footprint" by Andreas Backström, dated at switch-on time (`inject/fault.patch`)

## Ground truth

- `verify/oracle.md`: the root cause, read by `tools/rca-judge`
- `solution/fix.patch`: the reference fix
