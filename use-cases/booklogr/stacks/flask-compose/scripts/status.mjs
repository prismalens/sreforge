// status.mjs [--json]: what is running, which fault is on, what is firing. The dashboard reads --json.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STACK = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCENARIOS = resolve(STACK, "../../scenarios");
const WORK = join(STACK, "substrate/booklogr");
const run = (cmd, args) => {
	try {
		return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return "";
	}
};
const readText = (p) => (existsSync(p) ? readFileSync(p, "utf8").trim() : "");

function stack() {
	const out = run("docker", ["compose", "-f", join(STACK, "compose/docker-compose.yml"), "--profile", "load", "ps", "-a", "--format", "json"]);
	if (!out) return [];
	const rows = out.startsWith("[") ? JSON.parse(out) : out.split("\n").map((l) => JSON.parse(l));
	return rows.map((r) => ({ service: r.Service, state: r.State, health: r.Health || "" }));
}

function scenarios() {
	return readdirSync(SCENARIOS)
		.filter((id) => existsSync(join(SCENARIOS, id, "fault.env")))
		.map((id) => {
			const toml = readText(join(SCENARIOS, id, "scenario.toml"));
			const env = readText(join(SCENARIOS, id, "fault.env"));
			return {
				id,
				title: toml.match(/^title\s*=\s*"([^"]*)"/m)?.[1] ?? id,
				alert: env.match(/^ALERT=(.*)$/m)?.[1] ?? "",
				description: (toml.match(/^description\s*=\s*"""([\s\S]*?)"""/m)?.[1] ?? "")
					.replace(/\s+/g, " ")
					.trim()
					.split(/(?<=\.) /)[0],
			};
		});
}

async function alerts() {
	try {
		const res = await fetch("http://localhost:9093/api/v2/alerts?active=true&silenced=false&inhibited=false");
		return (await res.json()).map((a) => ({
			name: a.labels.alertname,
			service: a.labels.service ?? "",
			state: a.status?.state === "active" ? "firing" : a.status?.state,
			since: a.startsAt,
			summary: a.annotations?.summary ?? "",
		}));
	} catch {
		return [];
	}
}

// Alertmanager's own webhook counters: whether prismalens actually took the alerts.
async function delivery() {
	try {
		const text = await (await fetch("http://localhost:9093/metrics")).text();
		const sum = (name) =>
			text
				.split("\n")
				.filter((l) => l.startsWith(`${name}{`) && l.includes('integration="webhook"'))
				.reduce((n, l) => n + Number(l.split(" ").pop()), 0);
		return { sent: sum("alertmanager_notifications_total"), failed: sum("alertmanager_notifications_failed_total") };
	} catch {
		return { sent: 0, failed: 0 };
	}
}

const [faultId, faultSince] = readText(join(STACK, ".fault")).split(" ");
const status = {
	stack: stack(),
	fault: faultId ? { scenario: faultId, since: faultSince } : null,
	scenarios: scenarios(),
	alerts: await alerts(),
	substrate: { path: WORK, head: existsSync(WORK) ? run("git", ["-C", WORK, "log", "-1", "--format=%h %s"]) : "" },
	links: {
		app: "http://localhost:5150",
		api: "http://localhost:5000",
		prometheus: "http://localhost:9090",
		alertmanager: "http://localhost:9093",
		grafana: "http://localhost:3002",
	},
	prismalens: { webhook: readText(join(STACK, ".secrets/prismalens-url")), ...(await delivery()) },
};

if (process.argv.includes("--json")) {
	console.log(JSON.stringify(status));
} else {
	const up = status.stack.filter((s) => s.state === "running");
	console.log(`stack:     ${up.length ? up.map((s) => s.service).join(", ") : "down"}`);
	console.log(`fault:     ${status.fault ? `${status.fault.scenario} (on since ${status.fault.since})` : "none"}`);
	console.log(`firing:    ${status.alerts.map((a) => a.name).join(", ") || "nothing"}`);
	console.log(`code:      ${status.substrate.path} @ ${status.substrate.head || "not set up"}`);
	console.log(`prismalens webhook: ${status.prismalens.webhook || "not configured (task up writes it)"}`);
	console.log(`deliveries: ${status.prismalens.sent} sent, ${status.prismalens.failed} failed`);
	for (const [k, v] of Object.entries(status.links)) console.log(`${k.padEnd(10)} ${v}`);
}
