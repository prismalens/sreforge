# Compound latency: DB-pool contention + full-library re-sort, delivered across two deploys

Two independent performance regressions drive p99 API latency over the 300ms SLO under library-list storm load. First, an older configuration commit reduced the SQLAlchemy database connection pool to size 1 with gthread workers. Second, a recent application-code commit replaced DB-side pagination with in-memory Python sort and NFKD unicode normalization over all 150k library items. Either fault alone is sufficient to breach the SLO. Reverting only the recent hot commit leaves the alert firing due to the older config bottleneck; only reverting both commits clears the alert.

## Switch it on

```bash
task fault -- compound-latency-pool-and-sort on     # fires BooklogrApiLatencyP99High
task fault -- compound-latency-pool-and-sort off
```

Load while on: k6 `booklogr-storm-mixed.js` at 50 requests/s, library seeded to 150,000 books.

## What changes in the booklogr checkout

Commits on top of `healthy`, newest last:

- "Reduce DB connection footprint" by Andreas Backström, dated 6 days ago (`inject/fault-1-config.patch`)
- "Order library list by shelf position" by Tomás Rivera, dated at switch-on time (`inject/fault-2-sort.patch`)

## Ground truth

- `verify/oracle.md`: the root cause, read by `tools/rca-judge`
- `solution/fix.patch`: the reference fix
