# Cache outage with a co-firing upstream-error alert

Sustained search traffic against the Booklogr API drives p99 request latency above the 300ms SLO and triggers the BooklogrApiLatencyP99High alert. A concurrent BookMetadataProviderErrorsElevated warning alert also fires on the book-metadata upstream service. The book-metadata upstream has an elevated error rate returning fast HTTP 503 responses, while uncached successful lookups encounter its normal 1200ms latency. The search-response cache is disabled in api/config.py, so incoming search requests miss the cache and block Gunicorn workers on slow upstream calls. Under a k6 constant-arrival-rate storm over a fixed 8-query working set, p99 climbs past 0.3s. The agent must triage the co-firing alert as non-causal and restore effective caching of /v1/books/search to clear the p99 latency breach.

## Switch it on

```bash
task fault -- red-herring-coalert on     # fires BooklogrApiLatencyP99High
task fault -- red-herring-coalert off
```

Load while on: k6 `booklogr-storm.js` at 25 requests/s.

## What changes in the booklogr checkout

Commits on top of `healthy`, newest last:

- "Disable response caching" by Andreas Backström, dated 2026-06-11 10:34:52 +0200 (`inject/disable-cache.sh`)

Runtime setting, not in git: `SEARCH_STUB_5XX_RATE=0.08`.

## Ground truth

- `verify/oracle.md`: the root cause, read by `tools/rca-judge`
- `solution/fix.patch`: the reference fix
