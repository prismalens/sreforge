#!/usr/bin/env node

// run-incident.mjs — drive ONE booklogr incident run end-to-end through the
// SREForge engine, with a scripted reference fix standing in for the agent
// (M5 is parked). This is the conductor automation for the latency-cache-stampede
// scenario: it wires the booklogr-specific config into the domain-agnostic
// @sreforge/core Conductor and runs:
//
//   trigger(Prometheus alert firing) -> assemble brief -> ReferenceFixRunner
//   (apply solution/fix.patch, branch, push, open PR) -> GiteaCiGate (poll the
//   forge Actions run for HEAD) -> GiteaAutoMerge (merge the PR) ->
//   ComposeCdDeployer (rebuild+swap booklogr-api) -> MitigationOracle (clear +
//   sustained-clear under STILL-ACTIVE storm) -> FileRunRecorder (ingest
//   transcript/RCA handoffs, capture full/pruned records).
//
// PRECONDITION: the incident must already be live (regressed deploy + storm +
// the alert FIRING). Arm it first (inject-regression.sh + up + k6 + confirm-fire).
// The conductor's trigger.poll() throws if the alert is not firing at t=0.
//
// Config comes from the environment (source .env first). Override the fix for a
// negative/anti-cheat run with --patch / --message.
//
// Usage:
//   set -a; source ../../.env; set +a            # GITEA_TOKEN, owner/repo, urls
//   node run-incident.mjs                          # positive: reference fix
//   node run-incident.mjs --patch /abs/bad.patch --message "WIP" --scenario-id neg
//   node run-incident.mjs --run-id r1 --record-dir /tmp/rec --pruned-record-dir /tmp/pruned --full-store-dir /tmp/full

import fs from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	ComposeCdDeployer,
	ComposeCleanup,
	ExternalAgentRunner,
	FileRunRecorder,
	GiteaAutoMerge,
	GiteaCiGate,
	GiteaClient,
	IncidentPageRenderer,
	MitigationOracle,
	PrometheusAlertProbe,
	PrometheusAlertTrigger,
	ReferenceFixRunner,
	runIncident,
} from "../../../../../core/dist/index.js";
import { PRIMARY_ALERT } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STACK = resolve(HERE, ".."); // .../stacks/flask-compose
const REPO_ROOT = resolve(STACK, "../../../.."); // repo root

// ---- tiny arg parser ------------------------------------------------------
function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// ---- config (env with localhost defaults) ---------------------------------
const env = process.env;
const GITEA_URL = env.GITEA_URL || "http://localhost:3000";
const TOKEN = env.GITEA_TOKEN;
const OWNER = env.GITEA_REPO_OWNER || "booklogr";
const REPO = env.GITEA_REPO_NAME || "booklogr";
const PROM_URL = env.PROM_URL || "http://localhost:9090";
// BINDING to the scenario's scenario.toml `[expected] alert`. auto-incident.mjs
// resolves the kickoff alert through this exact expression (env.ALERT, else
// PRIMARY_ALERT) — one source, so the alert the agent is paged on and the alert
// the oracle grades cannot drift apart (#107).
const ALERT = env.ALERT || PRIMARY_ALERT;
const SERVICE = env.SERVICE || "booklogr-api";
const PROJECT = env.COMPOSE_PROJECT || "booklogr";
// Deploy from a NEUTRAL symlink so docker-inspect project labels don't leak the
// harness path (mirrors scripts/lib-deploy.sh). The symlink target is invisible
// to the agent; only the neutral path appears in com.docker.compose.project.*.
function resolveDeployDir(stack) {
	for (const c of [
		process.env.SREFORGE_DEPLOY_DIR,
		"/srv/booklogr",
		join(homedir(), "srv/booklogr"),
	].filter(Boolean)) {
		try {
			fs.mkdirSync(dirname(c), { recursive: true });
			try {
				fs.symlinkSync(stack, c);
			} catch (e) {
				if (e.code !== "EEXIST") throw e;
			}
			if (fs.realpathSync(c) === fs.realpathSync(stack)) return c;
		} catch {
			/* try next candidate */
		}
	}
	return stack;
}
const COMPOSE_FILE = resolve(
	resolveDeployDir(STACK),
	"compose/docker-compose.yml",
);
const WORKSPACE = resolve(STACK, "substrate/booklogr");
// Local branch, not origin/baseline: the baseline anchor is kept host-side only
// so the agent-visible forge never carries a `baseline` branch (de-tell). The
// cleanup's `git reset --hard <ref>` resolves it from the local workspace.
const BASELINE_REF = env.BASELINE_REF || "baseline";

if (!TOKEN) {
	console.error(
		"FATAL: GITEA_TOKEN is not set. Run `set -a; source .env; set +a` first.",
	);
	process.exit(2);
}

const runId = arg("run-id", env.RUN_ID || `run-${Date.now()}`);
const scenarioId = arg(
	"scenario-id",
	env.SCENARIO_ID || "latency-cache-stampede",
);
const patchPath = resolve(
	arg(
		"patch",
		env.FIX_PATCH ||
			join(
				REPO_ROOT,
				`use-cases/booklogr/scenarios/${scenarioId}/solution/fix.patch`,
			),
	),
);
const commitMessage = arg(
	"message",
	env.FIX_MESSAGE || "Restore response cache for book search",
);
const recordDir = resolve(arg("record-dir", join(STACK, "runs")));
const prunedRecordDir = arg(
	"pruned-record-dir",
	resolve(REPO_ROOT, `use-cases/booklogr/scenarios/${scenarioId}/records`),
);
const fullStoreDir = arg("full-store-dir", undefined);

// Pass threshold 0.85 separates a valid sustained clear (>=0.90) from a fix that
// clears briefly but does not survive the active storm (<=0.80) — the three hard
// signals (ci 0.25 + cleared 0.35 + sustained 0.20 = 0.80) plus a sliver of the
// soft credit (time-to-clear / no-new-alerts) are required to pass.
// The sustained window (360s) must exceed the substrate cache TTL (CACHE_DEFAULT_TIMEOUT=300s) so a cache-masked mitigation re-fires before it is credited — see #66.
const PASS_THRESHOLD = Number(env.PASS_THRESHOLD || 0.85);
const MAX_CLEAR_SECONDS = Number(env.MAX_CLEAR_SECONDS || 600);
const SUSTAINED_CLEAR_SECONDS = Number(env.SUSTAINED_CLEAR_SECONDS || 360);

// Services whose alerts count toward no_new_alerts. Precedence:
//   env SCOPE_SERVICES (comma list)  >  scenario.toml `services = [...]`  >  [SERVICE].
// scenario.toml is the human source of truth; SERVICE is the primary-service default.
function resolveScopeServices(scenarioId, primaryService) {
	const fromEnv = env.SCOPE_SERVICES;
	if (fromEnv && fromEnv.trim()) {
		return fromEnv
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	}
	try {
		const tomlPath = join(
			REPO_ROOT,
			`use-cases/booklogr/scenarios/${scenarioId}/scenario.toml`,
		);
		const toml = fs.readFileSync(tomlPath, "utf8");
		const m = toml.match(/^\s*services\s*=\s*\[([^\]]*)\]/m);
		if (m) {
			const list = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
			if (list.length) return list;
		}
	} catch {
		/* fall through to default */
	}
	return [primaryService];
}
const SCOPE_SERVICES = resolveScopeServices(scenarioId, SERVICE);

const client = new GiteaClient({
	baseUrl: GITEA_URL,
	token: TOKEN,
	owner: OWNER,
	repo: REPO,
});

// ---- runner mode (OPT-IN; default = scripted, fully backward compatible) ----
// scripted (default): ReferenceFixRunner replays the canned solution/fix.patch.
// external           : ExternalAgentRunner picks up a REAL agent's submission from
//                      the de-tell'd clean workspace (.run-workspace/booklogr, the
//                      host side of the sandbox /workspace mount) — it waits for the
//                      submit sentinel, captures the agent's diff, and replays it onto
//                      the forge substrate exactly as the scripted runner replays a
//                      patch. Both flags are accepted (AGENT_MODE per design, RUNNER
//                      per the task) so either spelling works.
const AGENT_MODE = (env.AGENT_MODE || env.RUNNER || "scripted").toLowerCase();
const CLEAN_WORKSPACE = resolve(STACK, ".run-workspace/booklogr");

// ---- agent-facing endpoints (in-network DNS, NOT the host-published ports) ----
// The agent runs INSIDE the deploy network (booklogr_default), so it reaches the
// observability stack and the service by their compose service DNS names. From the
// sandbox, `localhost` is the sandbox itself — the host PROM_URL/ALERTMANAGER_URL
// above are the ENGINE's view (trigger + oracle probe from the host) and are not
// reachable by the agent. Internal ports also differ from published ones (grafana
// is 3000 inside the network, 3002 on the host), so this is a distinct view, not a
// hostname swap. The agent picks the firing alerts up from alertmanager itself.
const AGENT_ALERTMANAGER_URL =
	env.AGENT_ALERTMANAGER_URL || "http://alertmanager:9093";
const AGENT_PROM_URL = env.AGENT_PROM_URL || "http://prometheus:9090";
const AGENT_GRAFANA_URL = env.AGENT_GRAFANA_URL || "http://grafana:3000";
const AGENT_API_URL = env.AGENT_API_URL || "http://booklogr-api:5000";
// Where the source is mounted INSIDE the sandbox (agent.yml mounts the clean clone
// at /workspace). Distinct from WORKSPACE, the host substrate the engine operates on.
const AGENT_WORKSPACE = env.AGENT_WORKSPACE || "/workspace";

// Both runners author the substrate fix commit under the project's own identity,
// consistent with the rest of the forge history.
const AUTHOR_NAME = "Andreas Backström";
const AUTHOR_EMAIL = "mozzo242@gmail.com";

const runner =
	AGENT_MODE === "external"
		? new ExternalAgentRunner({
				client,
				// The agent edits the CLEAN clone; the runner replays its diff onto the
				// substrate (config.agentContext.runWorkspace.path, unchanged below).
				cleanWorkspacePath: CLEAN_WORKSPACE,
				branch: `fix/${runId}`,
				base: "main",
				commitMessage,
				authorName: AUTHOR_NAME,
				authorEmail: AUTHOR_EMAIL,
			})
		: new ReferenceFixRunner({
				client,
				patchPath,
				branch: `fix/${runId}`,
				base: "main",
				commitMessage,
				authorName: AUTHOR_NAME,
				authorEmail: AUTHOR_EMAIL,
			});

const deps = {
	trigger: new PrometheusAlertTrigger({
		prometheusUrl: PROM_URL,
		alertName: ALERT,
	}),
	page: new IncidentPageRenderer(),
	runner,
	ciGate: new GiteaCiGate({
		client,
		pollIntervalMs: 5_000,
		timeoutMs: 600_000,
	}),
	autoMerge: new GiteaAutoMerge({ client }),
	deployer: new ComposeCdDeployer({
		composeFile: COMPOSE_FILE,
		projectName: PROJECT,
		timeoutMs: 300_000,
		// Readiness-gated rollout — OPT-IN via READINESS_GATE=on (default OFF = the
		// historical deploy-directly-into-the-live-storm behavior, which lets the cache
		// warm gradually under steady load and is what passed historically). When on:
		// drain the storm off booklogr-api while the fixed build comes up COLD (so its
		// healthcheck passes before the flood hits a cold cache), warm the cache (storm's
		// fixed query set) once healthy, then resume the storm so the oracle still grades
		// under STILL-ACTIVE load (ADR-0004). The gate provably fixes the deploy health race on
		// a SLOW box, but draining-then-resuming slams the full storm onto a cold cache at
		// once; for booklogr's per-WORKER in-process SimpleCache the front-door warm-up
		// reaches only some gunicorn workers, so the resumed burst can stampede the upstream
		// worse than gradual warming — so it is opt-in, not the default.
		...((env.READINESS_GATE || "off").toLowerCase() === "on"
			? {
					quiesceCmd: { command: "docker", args: ["stop", "edge-client"] },
					warmCmd: { command: "bash", args: [join(HERE, "warm-cache.sh")] },
					resumeCmd: { command: "docker", args: ["start", "edge-client"] },
				}
			: {}),
	}),
	oracle: new MitigationOracle({
		probe: new PrometheusAlertProbe({ prometheusUrl: PROM_URL }),
		passThreshold: PASS_THRESHOLD,
	}),
	recorder: new FileRunRecorder({
		baseDir: recordDir,
		transcriptHandoffPath: resolve(
			STACK,
			".run-workspace",
			"agent-transcript.json",
		),
		rcaHandoffPath: resolve(STACK, ".run-workspace", "agent-rca.json"),
		// Which alert actually kicked the agent off (#107). auto-incident.mjs drops
		// it at kickoff; a manual/scripted run has no webhook push, so the file is
		// simply absent and the record carries no kickoff_alert.
		kickoffHandoffPath: resolve(STACK, ".run-workspace", "agent-kickoff.json"),
		prunedRecordDir,
		fullRecordStoreDir: fullStoreDir,
	}),
	cleanup: new ComposeCleanup({
		composeFile: COMPOSE_FILE,
		projectName: PROJECT,
		baselineRef: BASELINE_REF,
	}),
};

const config = {
	runId,
	scenarioId,
	profile: "incident",
	expectedAlert: ALERT,
	agentContext: {
		// Agent-facing endpoints: in-network DNS (alerting stack first, where the
		// agent picks up the firing alerts), NOT the host localhost ports the engine
		// probes from. The agent self-serves incident context from these.
		services: {
			alertmanager: AGENT_ALERTMANAGER_URL,
			prometheus: AGENT_PROM_URL,
			grafana: AGENT_GRAFANA_URL,
			"booklogr-api": AGENT_API_URL,
		},
		// runWorkspace stays the HOST SUBSTRATE in both modes: the conductor's CI /
		// merge / redeploy / cleanup all key off it, and that is exactly where both
		// runners land the fix. It is engine-facing and NOT shown to the agent.
		// (External mode's clean-workspace path is a runner-internal input.)
		runWorkspace: { path: WORKSPACE, service: SERVICE },
		// The agent's own view of its source: the in-sandbox mount, not the host
		// substrate path — keeps the brief free of host paths (de-tell).
		workspacePath: AGENT_WORKSPACE,
		// The brief must name the EXACT command the agent's environment provides: the
		// sandbox shim is `submit` (SUBMIT_CMD in agent.yml). The scripted runner never
		// reads this (it ignores brief.prompt), but the conductor MATERIALIZES the brief
		// in both modes — so keep the value neutral rather than a harness-flavored string
		// a future runner could render verbatim into the agent's view (de-tell footgun).
		submitCommand: "submit",
	},
	mitigation: {
		alertToClear: ALERT,
		maxClearTimeSeconds: MAX_CLEAR_SECONDS,
		sustainedClearSeconds: SUSTAINED_CLEAR_SECONDS,
		inScopeServices: SCOPE_SERVICES,
	},
	recordDir,
};

console.log(
	`[run-incident] runId=${runId} scenario=${scenarioId} mode=${AGENT_MODE}`,
);
console.log(
	`[run-incident] forge=${GITEA_URL} repo=${OWNER}/${REPO} alert=${ALERT}`,
);
if (AGENT_MODE === "external") {
	console.log(
		`[run-incident] cleanWorkspace=${CLEAN_WORKSPACE} (awaiting agent submit sentinel)`,
	);
} else {
	console.log(`[run-incident] patch=${patchPath}`);
}
console.log(
	`[run-incident] workspace=${WORKSPACE} service=${SERVICE} compose=${COMPOSE_FILE}`,
);
console.log(
	`[run-incident] passThreshold=${PASS_THRESHOLD} maxClear=${MAX_CLEAR_SECONDS}s sustained=${SUSTAINED_CLEAR_SECONDS}s`,
);
console.log(`[run-incident] scopeServices=${SCOPE_SERVICES.join(",")}`);

const { record, recordPath } = await runIncident(config, deps);

// Persist evidence records (quiesced.json, confirm-fire.json, alert_fired_at.json) into run record dir
const runWs = resolve(STACK, ".run-workspace");
for (const file of [
	"quiesced.json",
	"confirm-fire.json",
	"alert_fired_at.json",
]) {
	const src = join(runWs, file);
	if (!fs.existsSync(src)) {
		console.error(
			`[run-incident] FATAL: required evidence ${file} missing from run workspace`,
		);
		process.exit(1);
	}
	try {
		fs.copyFileSync(src, join(recordPath, file));
	} catch (e) {
		console.error(
			`[run-incident] FATAL: Could not copy ${file} to run record: ${e.message}`,
		);
		process.exit(1);
	}
}

console.log("\n========== RESULT ==========");
console.log(`verdict : ${record.verdict}`);
console.log(
	`score   : ${record.score.score.toFixed(3)} (threshold ${PASS_THRESHOLD}, passed=${record.score.passed})`,
);
for (const s of record.score.signals) {
	console.log(
		`  - ${s.id.padEnd(16)} value=${Number(s.value).toFixed(2)} weight=${s.weight}  ${s.detail}`,
	);
}
console.log(`ci      : ${record.ci ? `green=${record.ci.green}` : "n/a"}`);
console.log(
	`deploy  : ${record.deploy ? `redeployed=${record.deploy.redeployed}` : "n/a"}`,
);
console.log("timings :", JSON.stringify(record.timings));
console.log(`record  : ${recordPath}`);

// Exit non-zero on a non-passing verdict so smoke scripts can assert.
process.exit(record.verdict === "passed" ? 0 : 1);
