# Cache stampede on book search under storm load

Sustained search traffic against the Booklogr API drives p99 request latency above the 300ms SLO and triggers the BooklogrApiLatencyP99High alert. The book-metadata upstream introduces deterministic high latency (1200ms) for each uncached request. The search-response cache is disabled in api/config.py, so every incoming search request misses the cache and blocks a Gunicorn worker on a slow upstream call. Under a k6 constant-arrival-rate storm over a small fixed query set the four workers (gunicorn -w 4) back up rapidly and p99 climbs well past 0.3s. The fix must restore effective caching of /v1/books/search so that repeated queries in the working set hit the cache and p99 clears under threshold while the load is still running.

## Switch it on

```bash
task fault -- latency-cache-stampede on     # fires BooklogrApiLatencyP99High
task fault -- latency-cache-stampede off
```

Load while on: k6 `booklogr-storm.js` at 25 requests/s.

## What changes in the booklogr checkout

Commits on top of `healthy`, newest last:

- "Disable response caching" by Andreas Backström, dated 2026-06-11 10:34:52 +0200 (`inject/disable-cache.sh`)

## Ground truth

- `verify/oracle.md`: the root cause, read by `tools/rca-judge`
- `solution/fix.patch`: the reference fix
