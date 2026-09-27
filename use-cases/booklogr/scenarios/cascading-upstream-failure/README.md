# Library listing latency after a schema-cleanup deploy

A recent deploy shipped a database "schema cleanup" migration that dropped a composite index (owner_id, lower(title)) backing the default library listing. The uncached GET /v1/books route sorts each owner's library by title; without the index Postgres reverts to a full sequential scan plus top-N sort of the entire library on every request. Under normal library-read load this saturates database/worker CPU and drives p99 request latency above the 300ms SLO, tripping BooklogrApiLatencyP99High. Symptoms present as broad API slowness (the library page spins, search lags) rather than pointing at the database schema. The fix must restore an index that serves the owner-scoped, title-ordered listing so the read path no longer scans and sorts the whole table.

## Switch it on

```bash
task fault -- cascading-upstream-failure on     # fires BooklogrApiLatencyP99High
task fault -- cascading-upstream-failure off
```

Load while on: k6 `booklogr-storm-shelf.js` at 50 requests/s, library seeded to 300,000 books.

## What changes in the booklogr checkout

Commits on top of `healthy`, newest last:

- "Schema cleanup: drop unused books title index" by Andreas Backström, dated at switch-on time (`inject/fault.patch`)

## Ground truth

- `verify/oracle.md`: the root cause, read by `tools/rca-judge`
- `solution/fix.patch`: the reference fix
