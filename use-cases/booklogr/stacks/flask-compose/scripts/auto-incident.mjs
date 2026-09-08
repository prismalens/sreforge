#!/usr/bin/env node
// =============================================================================
// auto-incident.mjs — Phase ③ AUTOMATION (ADR-0025): one automated incident
// cycle, self-triggered by the alert push. No resident agent, no harness
// daemon — the use-case's Alertmanager POSTs the firing notification to the
// (per-incident) box, and everything here is verb sequencing:
//
//   1. arm regress     task arm-regress      (regress substrate/forge → app
//                                             healthy, load quiesced; BEFORE the
//                                             clone so its base-sha matches, #22)
//   2. sandbox up      task agent            (clone at armed head; PROVIDER/MCP opt-ins)
//   3. listener up     webhook-wait.mjs      (BEFORE fire — the box "registers")
//   4. arm fire        task arm-fire         (re-load + confirm-fire → AM pushes)
//   5. agent           $AGENT_CMD            (kickoff = the symptom-level payload,
//                                             via WEBHOOK_PAYLOAD; reasoning
//                                             host-side — reasoning-in-box is a
//                                             separate deferred increment)
//   6. grade           task run RUNNER=external  (blocks on the submit sentinel)
//
// AGENT_CMD is a CONFIGURABLE command (harness-agnostic, ADR-0001) run with
// cwd = this stack; default = the reference Ollama driver. The engine is
// untouched: the conductor's one-shot trigger poll stands (the alert is firing
// when `run` starts) and grading is the existing external-runner tail.
//
// Same-session repeats are DEV-MODE (Prometheus history carries the previous
// incident — a repeat-scenario tell); official scoring uses a cold session.
// =============================================================================
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	assembleT0Bundle,
	renderT0Bundle,
} from "../../../../../core/dist/context/t0-bundle.js";
import {
	formatBanner,
	resolveConfig,
} from "../../../../../tools/transcript/driver-harness.mjs";
import { parseTriageFeed } from "./lib-storm.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STACK = resolve(HERE, "..");
const REPO_ROOT = resolve(STACK, "../../../..");
const env = process.env;

let runId = env.RUN_ID;
const runIdIdx = process.argv.indexOf("--run-id");
if (runIdIdx !== -1 && process.argv.length > runIdIdx + 1) {
	runId = process.argv[runIdIdx + 1];
}
const idArg = process.argv.find((a) => a.startsWith("id="));
if (idArg) {
	runId = idArg.slice(3);
}
if (!runId) {
	runId = `run-${Date.now()}`;
}

const AGENT_CMD = env.AGENT_CMD || "node scripts/agent-ollama.mjs";
const WEBHOOK_PORT = Number(env.WEBHOOK_PORT || 8080);

const TASK_BIN = (() => {
	const local = resolve(REPO_ROOT, "node_modules", ".bin", "task");
	return existsSync(local) ? local : "task";
})();

const RESOLVED = resolveConfig(env);
console.log(formatBanner(RESOLVED));

if (!env.AGENT_CMD && RESOLVED.runner === "external") {
	console.error(
		"auto: RUNNER=external with no AGENT_CMD — the run would bank a record attributed to a driver nobody chose. Set AGENT_CMD, or run with RUNNER=scripted.",
	);
	process.exit(78);
}

// ── preflight: the CI runner must be running AND registered with Gitea before arm.
const confirmRunnerRes = spawnSync(
	process.execPath,
	[resolve(HERE, "confirm-runner.mjs")],
	{
		stdio: "inherit",
		env,
	},
);
if (confirmRunnerRes.status !== 0) {
	const code = confirmRunnerRes.status ?? 86;
	console.error(
		`auto: runner pre-flight check failed (exit ${code}) — aborting before arming.`,
	);
	process.exit(code);
}

function task(name, extra = []) {
	console.log(`\nauto ── task ${name} ${extra.join(" ")}`.trimEnd());
	const res = spawnSync(TASK_BIN, ["--dir", STACK, name, ...extra], {
		stdio: "inherit",
		env,
	});
	if (res.status !== 0) {
		console.error(
			`auto: task ${name} failed (exit ${res.status ?? 1}) — aborting.`,
		);
		process.exit(res.status ?? 1);
	}
}

// Forward the run's opt-ins to `task agent` as task vars (PROVIDER=… MCP=…).
const optIns = ["PROVIDER", "MCP", "EGRESS_ALLOWLIST", "WEBHOOK_STORM_WINDOW_S"]
	.filter((k) => env[k])
	.map((k) => `${k}=${env[k]}`);

// ── 1 · arm PHASE 1 (regress) BEFORE the clone. The /workspace clone below reads
// the LOCAL substrate at its current HEAD, and modes 2/3 apply the fault DURING
// arm — so regressing first makes the clone's base-sha match the armed head
// (else the external-agent-runner base-sha assert fails). Fire is deferred to
// PHASE 2 (after the listener is up) so the Alertmanager push is caught.
task("arm-regress");

// ── 2 · sandbox up (fresh clone + force-recreate: per-incident by construction)
task("agent", optIns);

// ── 3 · listener up BEFORE the alert fires — the box must be reachable when AM notifies.
console.log(`\nauto ── webhook listener (in-box, :${WEBHOOK_PORT})`);
const listener = spawn("node", [resolve(HERE, "webhook-wait.mjs")], {
	stdio: ["ignore", "pipe", "inherit"],
	env,
});
let payloadJson = "";
listener.stdout.on("data", (d) => (payloadJson += d));
const listenerDone = new Promise((res_) => listener.on("close", res_));

// Wait until the port is actually bound (in-box netstat) so arm cannot race it.
let bound = false;
for (let i = 0; i < 20 && !bound; i++) {
	try {
		execFileSync(
			"docker",
			[
				"exec",
				"agent-shell",
				"sh",
				"-c",
				`netstat -tln 2>/dev/null | grep -q ':${WEBHOOK_PORT} '`,
			],
			{ stdio: "ignore" },
		);
		bound = true;
	} catch {
		await new Promise((r) => setTimeout(r, 500));
	}
}
if (!bound)
	console.error(
		"auto: WARN — could not confirm the listener bound; continuing.",
	);

// ── 4 · arm PHASE 2 (fire): re-apply load + confirm-fire. Alertmanager pushes
// ~group_wait after fire — the listener (now up) catches it.
task("arm-fire");

// ── 5 · the push: block on the notification, then hand it to the agent driver.
const listenerExit = await listenerDone;
if (listenerExit !== 0 || !payloadJson) {
	console.error(
		`auto: no webhook notification (listener exit ${listenerExit}) — aborting before the agent.`,
	);
	process.exit(listenerExit || 1);
}
// Abort through the same diagnostic path as an absent notification: a truncated
// or malformed capture must not surface as a bare stack trace, and must not let
// the run proceed to the agent on a payload we could not read.
let payload;
try {
	payload = JSON.parse(payloadJson);
} catch (e) {
	console.error(
		`auto: webhook payload was not valid JSON (${e.message}) — aborting before the agent.`,
	);
	process.exit(1);
}
let t0BundleJson = "";
if (payload.schema_version === "storm-capture.v1") {
	const slackTriage = [];
	const triageFeedPath = env.TRIAGE_FEED;
	if (triageFeedPath && existsSync(triageFeedPath)) {
		try {
			const feedStr = readFileSync(triageFeedPath, "utf8");
			slackTriage.push(...parseTriageFeed(feedStr));
		} catch (e) {
			console.error(
				`auto: failed to parse TRIAGE_FEED at ${triageFeedPath}: ${e.message}`,
			);
		}
	}

	const signals = (payload.alerts || []).map((a) => {
		const labels = a.labels || {};
		return {
			alertName: labels.alertname || "UnknownAlert",
			severity: labels.severity,
			labels,
			annotations: a.annotations || {},
			firedAt: a.startsAt || new Date().toISOString(),
		};
	});

	if (signals.length > 0) {
		const trigger = {
			source: "multi-alert",
			alertName: signals[0].alertName,
			severity: signals[0].severity,
			labels: signals[0].labels,
			annotations: signals[0].annotations,
			firedAt: signals[0].firedAt,
			signals,
		};
		const bundle = assembleT0Bundle({ runId, trigger, slackTriage });
		t0BundleJson = renderT0Bundle(bundle);
	}
}

const names = [
	...new Set(
		(payload.alerts || []).map((a) => a?.labels?.alertname).filter(Boolean),
	),
];
console.log(
	`\nauto ── 🔔 alert push received [${names.join(", ")}] → launching agent`,
);
console.log(`auto ── agent: ${AGENT_CMD}`);

// SECURITY: the agent must never inherit forge credentials (GITEA_TOKEN etc.).
// Pass only the minimal env needed for the driver to function. Drivers that need
// extra vars (e.g. OLLAMA_API_KEY) load the stack .env themselves; if a driver
// cannot do that, add names to AGENT_ENV_ALLOWLIST (comma-separated).
// Tuning knobs (AGENT_WINDOW, AGENT_OUT_MAX, …) MUST be listed here (or in
// AGENT_ENV_ALLOWLIST) or they are silently dropped before reaching the box.
const AGENT_ENV_DEFAULT = [
	"PATH",
	"HOME",
	"USER",
	"SHELL",
	"TMPDIR",
	"LANG",
	"TERM",
	"WEBHOOK_PAYLOAD",
	"T0_BUNDLE",
	"WEBHOOK_PORT",
	"AGENT_UID",
	"AGENT_GID",
	"AGENT_WINDOW",
	"AGENT_OUT_MAX",
	"AGENT_DEGRADE_THRESHOLD",
	"AGENT_WINDOW_FLOOR",
	"AGENT_OUT_MAX_FLOOR",
	"AGENT_MAX_DEGRADATIONS",
	"RUN_ID",
	"AGY_MODEL",
	"PROVIDER",
	"SREFORGE_EXPECTED_HARNESS",
];
const extraNames = (env.AGENT_ENV_ALLOWLIST || "")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);
const allowedNames = new Set([...AGENT_ENV_DEFAULT, ...extraNames]);

// Host-side control-plane vars: consumed here / in run-incident.mjs to steer the
// run, never meant to reach the box. Excluded from the drop-warning so it only
// flags genuine tuning knobs an operator meant to forward.
const AGENT_CONTROL_PLANE = new Set([
	"AGENT_CMD",
	"AGENT_ENV_ALLOWLIST",
	"AGENT_MODE",
	"AGENT_WORKSPACE",
	"AGENT_LOG",
	"AGENT_PROM_URL",
	"AGENT_API_URL",
	"AGENT_GRAFANA_URL",
	"AGENT_ALERTMANAGER_URL",
]);

// Warn (don't silently drop) if an AGENT_*/AGY_* tuning knob is set but not allowlisted.
for (const k of Object.keys(env)) {
	if (
		/AGY|AGENT/.test(k) &&
		!allowedNames.has(k) &&
		!AGENT_CONTROL_PLANE.has(k)
	) {
		console.error(
			`auto: WARN — ${k} is set but not in AGENT_ENV_ALLOWLIST — it will NOT reach the agent box.`,
		);
	}
}

const agentEnv = {};
for (const k of allowedNames) {
	if (k in env) agentEnv[k] = env[k];
}
agentEnv.WEBHOOK_PAYLOAD = payloadJson;
if (t0BundleJson) {
	agentEnv.T0_BUNDLE = t0BundleJson;
}
agentEnv.RUN_ID = runId;
if (RESOLVED.harness) {
	agentEnv.SREFORGE_EXPECTED_HARNESS = RESOLVED.harness;
}

// Clear any handoff left by a previous cycle: a stale transcript picked up by
// this run would be filed as this run's evidence (the run-id check in the
// recorder is the second line of defence).
const transcriptPath = resolve(
	STACK,
	".run-workspace",
	"agent-transcript.json",
);
if (existsSync(transcriptPath)) {
	rmSync(transcriptPath);
}
const rcaPath = resolve(STACK, ".run-workspace", "agent-rca.json");
if (existsSync(rcaPath)) {
	rmSync(rcaPath);
}

const agent = spawnSync("sh", ["-c", AGENT_CMD], {
	stdio: "inherit",
	cwd: STACK,
	env: agentEnv,
});
if (agent.status !== 0) {
	console.error(
		`auto: agent driver exited ${agent.status ?? 1} without a submit — nothing to grade.`,
	);
	process.exit(agent.status ?? 1);
}

// ── 6 · grade (the external runner picks the submit sentinel up immediately).
// `id=` is the run recipe's documented var (Taskfile: RUN_ID: '{{.id}}') — do
// not pass RUN_ID= here, it is not the recipe's interface.
task("run", ["RUNNER=external", `id=${runId}`]);
console.log("\nauto ── cycle complete (armed → pushed → agent → graded).");
