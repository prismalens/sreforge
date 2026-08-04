#!/usr/bin/env node
// =============================================================================
// agent-ollama.mjs — THROWAWAY validation driver: point a real Ollama-hosted
// model at the sealed agent-sandbox and let it work the incident autonomously.
//
// WHY THIS EXISTS (and why it's throwaway)
//   This is NOT the production agent runner. It is the "nearly-free" Phase-1
//   validation (ADR-0018 §5 "manual, host-side"): the model's REASONING runs
//   host-side, and every action it takes is a shell command EXEC'd into the
//   already-sealed agent-shell container — so the agent only ever sees the box
//   surface (endpoints + /workspace), never the host or the harness. It proves
//   two things the scripted/reference runner cannot:
//     1. the environment is solvable by real autonomous reasoning, and
//     2. the de-tell + isolation boundary holds against a real, probing agent.
//   The box stays ZERO-EGRESS: the model is reached from the HOST, not the box,
//   so this run needs no egress allowlist at all.
//
//   After it writes the submit sentinel, grade with:
//       pnpm forge run booklogr RUNNER=external
//
// DE-TELL: the kickoff is SYMPTOM-LEVEL only (mirrors the neutral incident page,
//   ADR-0008/0009) — service + endpoints + "the alerting stack is the source of
//   truth", and NEVER the firing alert name or the root cause. The agent
//   self-serves from Alertmanager.
//
// SAFETY: the model's only tools run INSIDE the box. The model's command is
//   passed as a single argv element to `docker exec … agent-shell sh -c` via
//   execFileSync (no host shell in the loop), so a model command cannot escape
//   onto the host — worst case it runs in the sealed, zero-egress container.
//
// CONFIG (env; the stack Taskfile loads .env, so put the key there):
//   OLLAMA_API_KEY   required — Ollama Cloud key (sent as Authorization: Bearer)
//   OLLAMA_MODEL     default qwen3-coder:480b-cloud
//   OLLAMA_HOST      default https://ollama.com
//   MAX_STEPS        default 30
//   AGENT_UID/GID    default current uid/gid (must match the box's dev user)
//
// RUN:
//   pnpm forge agent-up booklogr           # arm + bring the sandbox up
//   node use-cases/booklogr/stacks/flask-compose/scripts/agent-ollama.mjs
//   pnpm forge run booklogr RUNNER=external # grade the submitted fix
// =============================================================================
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildKickoffPrompt } from "../../../../../core/dist/context/kickoff.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const env = process.env;

// Load the stack .env (gitignored — same file GITEA_TOKEN lives in) so a direct
// `node` invocation picks up OLLAMA_API_KEY without exporting it. Already-set env
// wins; we never log the values.
(function loadDotenv() {
  const envPath = resolve(HERE, "..", ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || m[1] in env) continue;
    env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
})();

const OLLAMA_HOST = (env.OLLAMA_HOST || "https://ollama.com").replace(/\/+$/, "");
const MODEL = env.OLLAMA_MODEL || "qwen3-coder:480b-cloud";
const KEY = env.OLLAMA_API_KEY;
const MAX_STEPS = Number(env.MAX_STEPS || 30);
const CONTAINER = "agent-shell";
const U = `${env.AGENT_UID || process.getuid()}:${env.AGENT_GID || process.getgid()}`;
const OUT_MAX = 3000; // cap each tool output fed back to the model (keep requests small)
const WINDOW = 22; // sliding context window: system + kickoff + most-recent messages

if (!KEY) {
  console.error("FATAL: set OLLAMA_API_KEY (your Ollama Cloud key) — e.g. in the stack .env.");
  process.exit(1);
}

// ---- preflight: the sealed sandbox must be up --------------------------------
try {
  execFileSync("docker", ["inspect", CONTAINER], { stdio: "ignore" });
} catch {
  console.error(`FATAL: ${CONTAINER} not running — run \`pnpm forge agent-up booklogr\` first.`);
  process.exit(1);
}

// ---- the box tools: ALWAYS exec INTO the sealed container --------------------
function inBox(command) {
  try {
    const out = execFileSync(
      "docker",
      ["exec", "-u", U, "-w", "/workspace", CONTAINER, "sh", "-c", command],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 },
    );
    return { exit: 0, out };
  } catch (e) {
    return { exit: e.status ?? 1, out: `${e.stdout || ""}${e.stderr || ""}` };
  }
}
function inBoxArgv(args) {
  try {
    const out = execFileSync(
      "docker",
      ["exec", "-u", U, "-w", "/workspace", CONTAINER, ...args],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 },
    );
    return { exit: 0, out };
  } catch (e) {
    return { exit: e.status ?? 1, out: `${e.stdout || ""}${e.stderr || ""}` };
  }
}
const clip = (s) =>
  s.length > OUT_MAX ? `${s.slice(0, OUT_MAX)}\n…[truncated ${s.length - OUT_MAX} bytes]` : s;

// ---- tool schema (native Ollama /api/chat `tools`) --------------------------
const tools = [
  {
    type: "function",
    function: {
      name: "run_shell",
      description:
        "Run a shell command inside the incident host (from /workspace). Use it to investigate " +
        "via curl to the observability endpoints and the app, to read and edit the service code in " +
        "/workspace, and to run git. Returns combined stdout+stderr and the exit code.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "The shell command to run." } },
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
          "rca-file": { type: "string", description: "Path to the postmortem file." }
        },
      },
    },
  },
];

const SYSTEM = [
  "You are an on-call SRE engineer. An incident is affecting a service you operate.",
  "The alerting stack is the source of truth — start there and let the signals lead you.",
  "You act ONLY through the run_shell tool, which runs inside the incident host.",
  "Reachable endpoints are provided as env vars inside the host — run `env | grep _URL` to see",
  "ALERTMANAGER_URL, PROM_URL, GRAFANA_URL and API_URL, then curl them to investigate.",
  "The service's source is a git checkout at /workspace — read it, find the regression that",
  "explains the signals, and fix it in place.",
  "Investigate efficiently: prefer targeted commands (grep -rn, reading specific files, git log)",
  "over dumping large directory trees; keep each command's output focused.",
  "When you've fixed it, write a brief postmortem — root cause, evidence you used, what you changed — save it to a file (e.g. postmortem.md) and include it when you submit: submit --rca postmortem.md \"one-line summary\"",
  "Keep working until you have submitted.",
].join("\n");

// ③ automation (ADR-0025): when launched by auto-incident.mjs, the kickoff is
// the symptom-level Alertmanager notification the BOX received (webhook push) —
// the same data the agent could pull from ALERTMANAGER_URL itself, so no extra
// de-tell surface. Manual runs keep the generic kickoff.
//
// The wording lives in core (buildKickoffPrompt), not here: three drivers used to
// carry three copies of the same ternary and they drifted. auto-incident renders
// it once and forwards AGENT_KICKOFF; a manual run assembles the same text from
// whatever it was given.
const KICKOFF =
  env.AGENT_KICKOFF ||
  buildKickoffPrompt({
    t0Bundle: env.T0_BUNDLE,
    webhookPayload: env.WEBHOOK_PAYLOAD,
  });

const messages = [
  { role: "system", content: SYSTEM },
  { role: "user", content: KICKOFF },
];

// Sliding context window: always keep [system, kickoff]; then the most-recent
// messages up to WINDOW. Never start the tail on an orphan tool result (a tool
// message must follow the assistant tool_call it answers), or the API rejects it.
// Keeps each request small — the large-context 500s scale with request size.
function trimmed() {
  if (messages.length <= WINDOW) return messages;
  const head = messages.slice(0, 2);
  let start = messages.length - (WINDOW - 2);
  while (start > 2 && messages[start]?.role === "tool") start--;
  return [...head, ...messages.slice(start)];
}

async function chat() {
  // Retry transient provider failures (5xx / 429 / network) so one hiccup does
  // not waste a whole run. 4xx (auth / bad model) is non-retryable — fail fast.
  let lastErr;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
        method: "POST",
        headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, messages: trimmed(), tools, stream: false }),
      });
      if (res.ok) return res.json();
      const body = clip(await res.text());
      if (res.status >= 500 || res.status === 429) throw new Error(`Ollama ${res.status}: ${body} (transient)`);
      throw new Error(`Ollama ${res.status}: ${body}`); // non-retryable
    } catch (e) {
      lastErr = e;
      const retryable = /transient|fetch failed|ECONN|ETIMEDOUT|EAI_AGAIN|network|socket/i.test(e.message);
      if (attempt >= 5 || !retryable) throw lastErr;
      const wait = Math.min(3000 * attempt, 15000);
      console.error(`  (transient: ${e.message}; retry ${attempt}/4 in ${wait / 1000}s)`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

// ---- the loop ---------------------------------------------------------------
console.log("╭──────────────────────────────────────────────────────────────╮");
console.log("│  confinement: host-open                                     │");
console.log(`│  provider:    ${env.PROVIDER || "ollama"}`);
console.log(`│  model:       ${MODEL}`);
console.log("╰──────────────────────────────────────────────────────────────╯\n");
console.log(`agent-ollama: model=${MODEL} host=${OLLAMA_HOST} box=${CONTAINER} steps<=${MAX_STEPS}\n`);
let submitted = false;
for (let step = 1; step <= MAX_STEPS && !submitted; step++) {
  let data;
  try {
    data = await chat();
  } catch (e) {
    console.error(`step ${step}: ${e.message}`);
    process.exit(1);
  }
  const msg = data.message || {};
  messages.push(msg);
  if (msg.content && msg.content.trim()) console.log(`[${step}] 🧠 ${msg.content.trim()}`);

  const calls = msg.tool_calls || [];
  if (calls.length === 0) {
    messages.push({ role: "user", content: "Continue: call run_shell to investigate/fix, or submit when done." });
    continue;
  }
  for (const c of calls) {
    const name = c.function?.name;
    let args = c.function?.arguments;
    if (typeof args === "string") {
      try { args = JSON.parse(args); } catch { args = {}; }
    }
    args = args || {};
    if (name === "run_shell") {
      const cmd = String(args.command || "");
      console.log(`[${step}] $ ${cmd}`);
      const r = inBox(cmd);
      console.log(clip(r.out).trimEnd());
      messages.push({ role: "tool", tool_name: "run_shell", content: clip(`(exit ${r.exit})\n${r.out}`) });
    } else if (name === "submit") {
      const note = String(args.note || "fix").replace(/[^\w .,:;/-]/g, " ").slice(0, 200);
      let rcaFile = args["rca-file"] ? String(args["rca-file"]) : "";
      let submitArgs = ["submit"];
      if (rcaFile) {
        if (/^[A-Za-z0-9._/-]+$/.test(rcaFile) && !rcaFile.startsWith("/") && !rcaFile.includes("..")) {
          submitArgs.push("--rca", rcaFile);
        } else {
          console.warn(`[${step}] ⚠ warning: rejected invalid RCA path "${rcaFile}", submitting without RCA`);
          rcaFile = "";
        }
      }
      submitArgs.push(note);
      console.log(`[${step}] ✅ submit: ${note}${rcaFile ? ` (rca: ${rcaFile})` : ""}`);
      const r = inBoxArgv(submitArgs);
      console.log(r.out.trimEnd());
      messages.push({ role: "tool", tool_name: "submit", content: clip(`(exit ${r.exit})\n${r.out}`) });
      submitted = r.exit === 0;
    } else {
      messages.push({ role: "tool", tool_name: name || "unknown", content: `unknown tool: ${name}` });
    }
  }
}

// ---- transcript + next step -------------------------------------------------
const logDir = resolve(HERE, "..", ".run-workspace");
mkdirSync(logDir, { recursive: true });
const logPath = resolve(logDir, "agent-ollama-transcript.json");
writeFileSync(logPath, JSON.stringify({ model: MODEL, submitted, messages }, null, 2));

// Ollama loop starts a fresh chat context for every invocation, so it defaults to cold.
const session = env.AGENT_SESSION || "cold";
const provider = env.PROVIDER || "ollama";
const runId = env.RUN_ID || "run-unknown";

// Best-effort: the transcript is a debugging artifact, never the graded evidence
// (the verdict is outcome-based, ADR-0004). execFileSync throws on a non-zero
// exit, which would crash the driver AFTER the agent had already submitted — so
// a handoff failure must never propagate.
const handoffScript = resolve(HERE, "../../../../../tools/transcript/write-handoff.mjs");
const handoffOut = resolve(logDir, "agent-transcript.json");
try {
  execFileSync("node", [
    handoffScript,
    "--out", handoffOut,
    "--run-id", runId,
    "--harness", "ollama",
    "--session", session,
    "--confinement", "host-open",
    "--model", MODEL,
    "--provider", provider,
    "--submitted", String(submitted),
    "--raw-json-file", logPath
  ]);
} catch (err) {
  console.warn(`agent-ollama: WARNING — transcript handoff failed (continuing; the run is still gradeable): ${err.message}`);
}

try {
  if (inBox("test -f /workspace/.sreforge/rca.txt").exit === 0) {
    const catRes = inBox("cat /workspace/.sreforge/rca.txt");
    if (catRes.exit !== 0 || !catRes.out.trim()) {
      console.warn("agent-ollama: WARNING — rca read failed or empty, skipping handoff (continuing)");
    } else {
      const rcaOut = resolve(logDir, "agent-rca.json");
      const rcaTmp = resolve(logDir, "rca.txt");
      writeFileSync(rcaTmp, catRes.out, "utf8");
      execFileSync("node", [
        handoffScript,
        "--kind", "rca",
        "--out", rcaOut,
        "--run-id", runId,
        "--harness", "ollama",
        "--session", session,
        "--confinement", "host-open",
        "--model", MODEL,
        "--provider", provider,
        "--submitted", String(submitted),
        "--raw-text-file", rcaTmp
      ]);
    }
  }
} catch (err) {
  console.warn(`agent-ollama: WARNING — rca handoff failed (continuing; the run is still gradeable): ${err.message}`);
}

console.log(`\nagent-ollama: ${submitted ? "SUBMITTED ✅" : "did NOT submit ⚠"} — transcript → ${logPath}`);
if (submitted) {
  console.log("Now grade it:  pnpm forge run booklogr RUNNER=external");
} else {
  console.log("No sentinel written. Re-run with a higher MAX_STEPS, or inspect the transcript.");
  process.exit(2);
}
