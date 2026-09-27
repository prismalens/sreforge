// wait-alert.mjs <alertname> [timeout-seconds]: exit 0 once Prometheus reports the alert firing.
const [alert, timeoutArg = "300"] = process.argv.slice(2);
const prom = process.env.PROM_URL || "http://localhost:9090";
const deadline = Date.now() + Number(timeoutArg) * 1000;
const started = Date.now();

while (Date.now() < deadline) {
	const elapsed = Math.round((Date.now() - started) / 1000);
	try {
		const res = await fetch(`${prom}/api/v1/alerts`);
		const alerts = (await res.json())?.data?.alerts ?? [];
		const hit = alerts.find((a) => a.labels?.alertname === alert);
		if (hit?.state === "firing") {
			console.log(`${alert} is firing (after ${elapsed}s)`);
			process.exit(0);
		}
		console.log(`${elapsed}s: ${alert} ${hit?.state ?? "not yet pending"}`);
	} catch (e) {
		console.log(`${elapsed}s: prometheus not ready (${e.message})`);
	}
	await new Promise((r) => setTimeout(r, 5000));
}
console.error(`${alert} did not fire within ${timeoutArg}s`);
process.exit(1);
