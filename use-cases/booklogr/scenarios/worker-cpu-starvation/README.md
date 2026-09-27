# Worker pool CPU-starved by full-library re-sort on the hot read path

A recent deploy-time change to the `/v1/books` library-list route replaced the database-side ORDER BY + LIMIT/OFFSET pagination with an in-application "shelf ordering" pass: it now materializes the owner's ENTIRE library (150k seeded rows) as ORM objects and Unicode-normalizes + sorts them in Python on every request before slicing out the requested page. The work is CPU-bound (ORM hydration of the full result set plus a per-row article-insensitive / accent-folded sort key), so under the constant-arrival-rate library-read storm all four Gunicorn workers saturate their CPU. Once the workers are pinned, EVERY endpoint queues at accept — including cached routes like `/v1/books/search` and book-detail lookups — so p99 request latency climbs well past the 300ms SLO and fires BooklogrApiLatencyP99High. Because the starved API can no longer drive its normal call volume to the book-metadata provider, that downstream service's inbound request traffic collapses, firing a second, cross-service signal (service=book-metadata). Grouping these signals into a single incident with a shared cause is the point of this scenario. The fix must stop the per-request full-library re-sort so the read path returns to database-side pagination and the workers are no longer CPU-starved.

## Switch it on

```bash
task fault -- worker-cpu-starvation on     # fires BooklogrApiLatencyP99High
task fault -- worker-cpu-starvation off
```

Load while on: k6 `booklogr-storm-browse-mixed.js` at 50 requests/s, library seeded to 150,000 books.

## What changes in the booklogr checkout

Commits on top of `healthy`, newest last:

- "Order library list by shelf position" by Tomás Rivera, dated at switch-on time (`inject/fault.patch`)

## Ground truth

- `verify/oracle.md`: the root cause, read by `tools/rca-judge`
- `solution/fix.patch`: the reference fix
