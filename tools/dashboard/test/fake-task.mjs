// Stand-in for `pnpm exec task --silent`: echoes its argv, prints a fixed status, sleeps FAKE_DELAY_MS on other verbs.
const args = process.argv.slice(2);
const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();

if (args[0] === "status") {
  const svc = (service, health = "healthy") => ({ service, state: "running", health });
  process.stdout.write(JSON.stringify({
    stack: [svc("booklogr-api"), svc("booklogr-web"), svc("postgres"), svc("stub-upstream"), svc("prometheus", ""), svc("alertmanager", ""), svc("grafana", ""), svc("k6", "")],
    fault: { scenario: "worker-cpu-starvation", since: ago(7) },
    scenarios: [
      { id: "worker-cpu-starvation", title: "Worker CPU starvation", alert: "BooklogrApiLatencyP99High", description: "Gunicorn runs with one worker, so requests queue behind each other under the k6 load and p99 latency climbs past the SLO." },
      { id: "db-pool-exhaustion", title: "Database pool exhaustion", alert: "BooklogrDbPoolSaturated", description: "The SQLAlchemy pool is capped at two connections; list endpoints hold them across a slow query and the rest time out." },
      { id: "upstream-timeout", title: "Upstream timeout", alert: "BooklogrUpstreamErrorRateHigh", description: "The stub upstream adds a 5 second delay and the API client has no timeout, so book lookups fail with 504s." },
    ],
    alerts: [
      { name: "BooklogrApiLatencyP99High", service: "booklogr-api", state: "firing", since: ago(4), summary: "p99 latency on /api/books is 2.4s (SLO 500ms)" },
    ],
    code: [
      { service: "booklogr-api", path: "/home/dev/sreforge/substrate/booklogr", head: "abc1234 Order library list by shelf position" },
      { service: "book-metadata", path: "/home/dev/sreforge/substrate/book-metadata", head: "def5678 Book metadata service" },
    ],
    links: { app: "http://localhost:5150", api: "http://localhost:5000", prometheus: "http://localhost:9090", alertmanager: "http://localhost:9093", grafana: "http://localhost:3002" },
    receiver: { url: "http://host.docker.internal:3001/api/webhooks/prometheus", sent: 2, failed: 0 },
  }));
} else {
  console.log(`fake task ${args.join(" ")}`);
  setTimeout(() => console.log("done"), Number(process.env.FAKE_DELAY_MS || 0));
}
