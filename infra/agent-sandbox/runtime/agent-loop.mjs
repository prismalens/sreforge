#!/usr/bin/env node
// =============================================================================
// agent-loop.mjs — IN-BOX reasoning loop for the sealed agent-shell container.
//
// Adapted from the host-side agent-ollama.mjs; runs INSIDE the box as the `dev`
// user, cwd /workspace. Actions are LOCAL shell commands (no docker anywhere).
// The host driver (agent-inbox.sh) injects the API key PER-EXEC and tees stdout.
//
// Config is STRICTLY from env — no .env loading (the box has no .env):
//   OLLAMA_API_KEY   required (fail loud)
//   OLLAMA_MODEL     default qwen3-coder:480b-cloud
//   OLLAMA_HOST      default https://ollama.com
//   MAX_STEPS        default 30
//   AGENT_KICKOFF    optional — the kickoff text, rendered host-side (preferred)
//   T0_BUNDLE        optional — assembled t=0 bundle, used when AGENT_KICKOFF is unset
//   WEBHOOK_PAYLOAD  optional (same kickoff semantics as agent-ollama.mjs)
//
// Exit 0 if submitted, 2 if the step budget ran out, 1 on a permanent
// provider failure — the transcript is written on every exit path.
// =============================================================================
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const env = process.env;

const OLLAMA_HOST = (env.OLLAMA_HOST || "https://ollama.com").replace(
	/\/+$/,
	"",
);
const DEFAULT_MODEL = "qwen3-coder:480b-cloud";
// DECISION: an OLLAMA_MODEL pin from the env (stack .env, forwarded by the
// host driver) still wins over this default — operators rely on it — but the
// override must never be silent, so warn when it diverges (see below).
const MODEL = env.OLLAMA_MODEL || DEFAULT_MODEL;
const KEY = env.OLLAMA_API_KEY;
if (env.OLLAMA_MODEL && env.OLLAMA_MODEL !== DEFAULT_MODEL) {
	console.error(
		`WARNING: OLLAMA_MODEL env pin "${env.OLLAMA_MODEL}" overrides the driver default "${DEFAULT_MODEL}" — the pin wins, but confirm this is intentional.`,
	);
}
const MAX_STEPS = Number(env.MAX_STEPS || 30);
let OUT_MAX = Number(env.AGENT_OUT_MAX || 3000); // cap per tool output fed back
let WINDOW = Number(env.AGENT_WINDOW || 22); // sliding window: system + kickoff + most-recent
const DEGRADE_THRESHOLD = Number(env.AGENT_DEGRADE_THRESHOLD || 2); // consecutive 500s to trigger degradation
const WINDOW_FLOOR = Number(env.AGENT_WINDOW_FLOOR || 6); // minimum AGENT_WINDOW floor
const OUT_MAX_FLOOR = Number(env.AGENT_OUT_MAX_FLOOR || 500); // minimum AGENT_OUT_MAX floor
const MAX_DEGRADATIONS = Number(env.AGENT_MAX_DEGRADATIONS || 3); // max degradation steps

let consecutive500s = 0;
let degradationCount = 0;
const degradations = [];

export function computeDegradation({
	currentWindow,
	currentOutMax,
	windowFloor,
	outMaxFloor,
	consecutive500s,
	degradationCount,
	maxDegradations,
	degradeThreshold,
}) {
	if (consecutive500s < degradeThreshold) {
		return { shouldDegrade: false, reason: "below_threshold" };
	}
	if (degradationCount >= maxDegradations) {
		return { shouldDegrade: false, reason: "max_degradations_reached" };
	}
	const canDegradeWindow = currentWindow > windowFloor;
	const canDegradeOutMax = currentOutMax > outMaxFloor;
	if (!canDegradeWindow && !canDegradeOutMax) {
		return { shouldDegrade: false, reason: "at_floors" };
	}

	const newWindow = Math.max(windowFloor, Math.floor(currentWindow / 2));
	const newOutMax = Math.max(outMaxFloor, Math.floor(currentOutMax / 2));

	return {
		shouldDegrade: true,
		newWindow,
		newOutMax,
		degradationStep: degradationCount + 1,
	};
}

import { pathToFileURL } from "node:url";

export const isMainModule =
	process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (!KEY && isMainModule) {
	console.error(
		"FATAL: OLLAMA_API_KEY is required (injected by the host driver).",
	);
	process.exit(1);
}

// ---- local shell execution (no docker — we ARE in the box) ------------------
function localShell(command) {
	try {
		const out = execFileSync("sh", ["-c", command], {
			encoding: "utf8",
			cwd: "/workspace",
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: 64 * 1024 * 1024,
			timeout: Number(env.AGENT_SHELL_TIMEOUT_MS || 120000),
		});
		return { exit: 0, out };
	} catch (e) {
		return { exit: e.status ?? 1, out: `${e.stdout || ""}${e.stderr || ""}` };
	}
}
function localShellArgv(args) {
	try {
		const out = execFileSync(args[0], args.slice(1), {
			encoding: "utf8",
			cwd: "/workspace",
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: 64 * 1024 * 1024,
			timeout: Number(env.AGENT_SHELL_TIMEOUT_MS || 120000),
		});
		return { exit: 0, out };
	} catch (e) {
		return { exit: e.status ?? 1, out: `${e.stdout || ""}${e.stderr || ""}` };
	}
}

const clip = (s) =>
	s.length > OUT_MAX
		? `${s.slice(0, OUT_MAX)}\n…[truncated ${s.length - OUT_MAX} bytes]`
		: s;

// ---- tool schema (native Ollama /api/chat `tools`) --------------------------
const tools = [
	{
		type: "function",
		function: {
			name: "run_shell",
			description:
				"Run a shell command on this host (from /workspace). Use it to investigate " +
				"via curl to the observability endpoints and the app, to read and edit the service code in " +
				"/workspace, and to run git. Returns combined stdout+stderr and the exit code.",
			parameters: {
				type: "object",
				properties: {
					command: { type: "string", description: "The shell command to run." },
				},
				required: ["command"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "submit",
			description:
				"Hand off your fix for grading. Commits your /workspace edits and signals completion. " +
				"Call this exactly once, when your fix is applied.",
			parameters: {
				type: "object",
				properties: {
					note: { type: "string", description: "One-line summary of the fix." },
					"rca-file": {
						type: "string",
						description: "Path to the postmortem file.",
					},
				},
			},
		},
	},
];

// System prompt: the agent IS on the incident host (no "runs inside" indirection).
const SYSTEM = [
	"You are an on-call SRE engineer. An incident is affecting a service you operate.",
	"The alerting stack is the source of truth — start there and let the signals lead you.",
	"You act ONLY through the run_shell tool, which runs commands on this host.",
	"Reachable endpoints are in env vars — run `env | grep _URL` to see",
	"ALERTMANAGER_URL, PROM_URL, GRAFANA_URL and API_URL, then curl them to investigate.",
	"The service's source is a git checkout at /workspace — read it, find the regression that",
	"explains the signals, and fix it in place.",
	"Investigate efficiently: prefer targeted commands (grep -rn, reading specific files, git log)",
	"over dumping large directory trees; keep each command's output focused.",
	'When you\'ve fixed it, write a brief postmortem — root cause, evidence you used, what you changed — save it to a file (e.g. postmortem.md) and include it when you submit: submit --rca postmortem.md "one-line summary"',
	"Keep working until you have submitted.",
].join("\n");

// Kickoff: symptom-level only — never name the alert cause (de-tell).
//
// The wording is assembled ONCE host-side by core's buildKickoffPrompt and
// injected as AGENT_KICKOFF (auto-incident.mjs → agent-inbox.sh). This file is
// baked into the image alone — agent-shell.Dockerfile COPYs exactly one runtime
// file, from a build context that cannot reach core/dist — so injection is how
// the box shares that wording instead of keeping a third copy of the ternary.
// The branch below is the hand-invocation fallback: started in-box with a
// payload in the env and no AGENT_KICKOFF, the loop still pages honestly.
const KICKOFF_TAIL =
	"Investigate from the alerting stack, find the root cause in the code, " +
	'apply a fix in /workspace, and submit. When you\'ve fixed it, write a brief postmortem — root cause, evidence you used, what you changed — save it to a file (e.g. postmortem.md) and include it when you submit: submit --rca postmortem.md "one-line summary"';
const DELIVERED = env.T0_BUNDLE || env.WEBHOOK_PAYLOAD;
const KICKOFF =
	env.AGENT_KICKOFF ||
	(DELIVERED
		? `This incident context bundle was just delivered to the incident host:\n${DELIVERED}\n${KICKOFF_TAIL}`
		: `An alert is firing for the service. ${KICKOFF_TAIL}`);

const messages = [
	{ role: "system", content: SYSTEM },
	{ role: "user", content: KICKOFF },
];

// Sliding context window: always keep [system, kickoff]; then the most-recent
// messages up to WINDOW. Never start the tail on an orphan tool result.
function trimmed() {
	if (messages.length <= WINDOW) return messages;
	const head = messages.slice(0, 2);
	let start = messages.length - (WINDOW - 2);
	while (start > 2 && messages[start]?.role === "tool") start--;
	return [...head, ...messages.slice(start)];
}

// Retry transient provider failures (5xx / 429 / network); 4xx is non-retryable.
async function chat() {
	let lastErr;
	for (let attempt = 1; attempt <= 5; attempt++) {
		try {
			const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${KEY}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model: MODEL,
					messages: trimmed(),
					tools,
					stream: false,
				}),
				signal: AbortSignal.timeout(Number(env.CHAT_TIMEOUT_MS || 120000)),
			});
			if (res.ok) {
				consecutive500s = 0;
				return res.json();
			}

			const body = clip(await res.text());
			if (res.status >= 500) {
				consecutive500s++;
				const deg = computeDegradation({
					currentWindow: WINDOW,
					currentOutMax: OUT_MAX,
					windowFloor: WINDOW_FLOOR,
					outMaxFloor: OUT_MAX_FLOOR,
					consecutive500s,
					degradationCount,
					maxDegradations: MAX_DEGRADATIONS,
					degradeThreshold: DEGRADE_THRESHOLD,
				});

				if (deg.shouldDegrade) {
					const oldWindow = WINDOW;
					const oldOutMax = OUT_MAX;
					WINDOW = deg.newWindow;
					OUT_MAX = deg.newOutMax;
					degradationCount = deg.degradationStep;
					consecutive500s = 0;
					degradations.push({
						step: degradationCount,
						trigger_status: res.status,
						consecutive_5xx: DEGRADE_THRESHOLD,
						window: { from: oldWindow, to: WINDOW },
						out_max: { from: oldOutMax, to: OUT_MAX },
					});

					console.error(
						`agent-loop: ⚠️ adaptive degradation step ${degradationCount}/${MAX_DEGRADATIONS} triggered by ${DEGRADE_THRESHOLD} consecutive ${res.status}s: ` +
							`AGENT_WINDOW ${oldWindow} -> ${WINDOW}, AGENT_OUT_MAX ${oldOutMax} -> ${OUT_MAX}`,
					);
				}
			} else if (res.status !== 429) {
				consecutive500s = 0;
			}

			if (res.status >= 500 || res.status === 429)
				throw new Error(`Ollama ${res.status}: ${body} (transient)`);
			throw new Error(`Ollama ${res.status}: ${body}`);
		} catch (e) {
			lastErr = e;
			const retryable =
				/transient|fetch failed|ECONN|ETIMEDOUT|EAI_AGAIN|network|socket|timeout|abort/i.test(
					e.message,
				);
			if (attempt >= 5 || !retryable) throw lastErr;
			const wait = Math.min(3000 * attempt, 15000);
			console.error(
				`  (transient: ${e.message}; retry ${attempt}/4 in ${wait / 1000}s)`,
			);
			await new Promise((r) => setTimeout(r, wait));
		}
	}
	throw lastErr;
}

// ---- transcript (JSON to .sreforge/; the diff capture excludes .sreforge/) ---
// Written on every exit path — including a permanent chat() failure, where the
// history up to the failure is exactly what's needed to debug it. Best-effort.
const transcriptPath = "/workspace/.sreforge/agent-transcript.json";
// `submitted` is a parameter, NOT a closure read: it lives inside runLoop(), so
// referencing it here would throw ReferenceError on every call — and the catch
// below would swallow it, silently producing no transcript at all.
// Pure builder so the payload can be unit-tested without a /workspace mount.
// This exists because the previous shape read `submitted` from a scope it did
// not live in: the ReferenceError was swallowed by saveTranscript's catch and
// the transcript silently never appeared. A pure function makes that testable.
export function buildTranscript(submitted) {
	return {
		model: MODEL,
		submitted,
		// Effective knobs at exit + every degradation step, so an analyst can tell
		// a window-22 run from one degraded to the floor. Two runs that degraded
		// differently are not comparable evidence (ADR-0010).
		effective_window: WINDOW,
		effective_out_max: OUT_MAX,
		degradation_count: degradationCount,
		degradations,
		messages,
	};
}

function saveTranscript(submitted) {
	try {
		mkdirSync("/workspace/.sreforge", { recursive: true });
		writeFileSync(
			transcriptPath,
			JSON.stringify(buildTranscript(submitted), null, 2),
		);
	} catch (e) {
		console.error(`agent-loop: WARN — failed to save transcript: ${e.message}`);
	}
}

export async function runLoop() {
	console.log(
		`agent-loop: model=${MODEL} host=${OLLAMA_HOST} steps<=${MAX_STEPS}\n`,
	);
	let submitted = false;
	for (let step = 1; step <= MAX_STEPS && !submitted; step++) {
		let data;
		try {
			data = await chat();
		} catch (e) {
			console.error(`step ${step}: ${e.message}`);
			saveTranscript(submitted);
			console.error(`agent-loop: transcript → ${transcriptPath}`);
			process.exit(1);
		}
		const msg = data.message || {};
		messages.push(msg);
		if (msg.content?.trim()) console.log(`[${step}] 🧠 ${msg.content.trim()}`);

		const calls = msg.tool_calls || [];
		if (calls.length === 0) {
			messages.push({
				role: "user",
				content:
					"Continue: call run_shell to investigate/fix, or submit when done.",
			});
			continue;
		}
		for (const c of calls) {
			const name = c.function?.name;
			let args = c.function?.arguments;
			if (typeof args === "string") {
				try {
					args = JSON.parse(args);
				} catch {
					args = {};
				}
			}
			args = args || {};
			if (name === "run_shell") {
				const cmd = String(args.command || "");
				console.log(`[${step}] $ ${cmd}`);
				const r = localShell(cmd);
				console.log(clip(r.out).trimEnd());
				messages.push({
					role: "tool",
					tool_name: "run_shell",
					content: clip(`(exit ${r.exit})\n${r.out}`),
				});
			} else if (name === "submit") {
				const note = String(args.note || "fix")
					.replace(/[^\w .,:;/-]/g, " ")
					.slice(0, 200);
				let rcaFile = args["rca-file"] ? String(args["rca-file"]) : "";
				const submitArgs = ["submit"];
				if (rcaFile) {
					if (
						/^[A-Za-z0-9._/-]+$/.test(rcaFile) &&
						!rcaFile.startsWith("/") &&
						!rcaFile.includes("..")
					) {
						submitArgs.push("--rca", rcaFile);
					} else {
						console.warn(
							`[${step}] ⚠ warning: rejected invalid RCA path "${rcaFile}", submitting without RCA`,
						);
						rcaFile = "";
					}
				}
				submitArgs.push(note);
				console.log(
					`[${step}] ✅ submit: ${note}${rcaFile ? ` (rca: ${rcaFile})` : ""}`,
				);
				// submit is on PATH (/usr/local/bin/submit) — run it directly
				const r = localShellArgv(submitArgs);
				console.log(r.out.trimEnd());
				messages.push({
					role: "tool",
					tool_name: "submit",
					content: clip(`(exit ${r.exit})\n${r.out}`),
				});
				submitted = r.exit === 0;
			} else {
				messages.push({
					role: "tool",
					tool_name: name || "unknown",
					content: `unknown tool: ${name}`,
				});
			}
		}
	}

	saveTranscript(submitted);
	console.log(
		`\nagent-loop: ${submitted ? "SUBMITTED ✅" : "did NOT submit ⚠"} — transcript → ${transcriptPath}`,
	);
	process.exit(submitted ? 0 : 2);
}

if (isMainModule) {
	runLoop().catch((err) => {
		console.error(`agent-loop: FATAL: ${err.message}`);
		process.exit(1);
	});
}
