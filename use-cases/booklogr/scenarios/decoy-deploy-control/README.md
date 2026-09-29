# Cache outage masked by an unrelated recent deploy

p99 request latency on book search breaches the 300ms SLO and fires BooklogrApiLatencyP99High. There IS a real recent deploy on main, but it only fixes an unrelated HTTP status code bug in the settings endpoint and is physically incapable of affecting search latency. The actual cause is that the deployed cache backend has drifted to NullCache at the runtime/infra layer, outside application source control — every search request now misses the cache and pays the book-metadata upstream's full 1.1-1.3s latency. An agent that anchors on "what changed recently in git" and reverts the innocent deploy will NOT clear the incident: the fix must restore the cache backend itself. The scenario is a control for deploy-correlation reasoning: recency of a commit does not by itself establish causation.

## Switch it on

```bash
task fault -- decoy-deploy-control on     # fires BooklogrApiLatencyP99High
task fault -- decoy-deploy-control off
```

Load while on: k6 `booklogr-storm.js` at 25 requests/s, library seeded to 150,000 books.

## What changes in the booklogr checkout

Commits on top of `healthy`, newest last:

- "Read cache backend from environment" by Andreas Backström, dated 2026-06-15 09:12:31 +0200 (`inject/cache-from-env.sh`)
- "Log effective cache backend at boot" by Andreas Backström, dated 2026-06-20 16:47:03 +0200 (`inject/boot-log.sh`)
- "Fix invalid HTTP status in settings response" by Andreas Backström, dated at switch-on time (`inject/fault.patch`)

Runtime setting, not in git: `CACHE_TYPE=NullCache`.

## Ground truth

- `verify/oracle.md`: the root cause, read by `tools/rca-judge`
- `solution/fix.patch`: the reference fix
