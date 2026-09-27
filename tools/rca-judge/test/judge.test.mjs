import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  WEIGHTS,
  RUBRIC_VERSION,
  SCHEMA_VERSION,
  computeScore,
  extractRootCause,
  assemblePrompt,
  parseVerdict,
  runJudge,
  buildDiagnosis,
} from "../judge.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const JUDGE = resolve(HERE, "../judge.mjs");
const FIX = resolve(HERE, "fixtures");
const oracleMd = readFileSync(join(FIX, "oracle.md"), "utf8");

function tmp() { return mkdtempSync(join(tmpdir(), "rca-judge-")); }
function runCli(args, env = {}) {
  const r = spawnSync("node", [JUDGE, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  return { exit: r.status, out: `${r.stdout || ""}`, err: `${r.stderr || ""}` };
}

// ── 1. prompt assembly ────────────────────────────────────────────────────────
test("extractRootCause pulls only the harness-internal section", () => {
  const rc = extractRootCause(oracleMd);
  assert.match(rc, /CACHE_TYPE=NullCache/);
  assert.match(rc, /innocent decoy/);
  assert.doesNotMatch(rc, /CompoundedOracle/);
  assert.doesNotMatch(rc, /Signal text/);
});

test("extractRootCause throws a clear error when the section is missing", () => {
  const bad = readFileSync(join(FIX, "oracle-no-root-cause.md"), "utf8");
  assert.throws(() => extractRootCause(bad), /Root cause \(harness-internal\)/);
});

test("assemblePrompt embeds the RCA text and the ground truth", () => {
  const prompt = assemblePrompt({ rcaText: "MY_UNIQUE_RCA_MARKER", rootCause: extractRootCause(oracleMd) });
  assert.match(prompt, /MY_UNIQUE_RCA_MARKER/);
  assert.match(prompt, /CACHE_TYPE=NullCache/);
  assert.match(prompt, /root_cause_correct/); // rubric body present
});

// ── 2. scoring math + weights sum ─────────────────────────────────────────────
test("WEIGHTS sum to exactly 1", () => {
  const sum = WEIGHTS.root_cause_correct + WEIGHTS.evidence_grounded + WEIGHTS.no_false_leads;
  assert.equal(Math.round(sum * 1e6) / 1e6, 1);
});

test("all-good scores 1.0", () => {
  assert.equal(computeScore({ root_cause_correct: true, evidence_grounded: true, false_leads: false }), 1);
});

test("all-bad scores 0.0", () => {
  assert.equal(computeScore({ root_cause_correct: false, evidence_grounded: false, false_leads: true }), 0);
});

test("correct + grounded but chased a false lead forfeits the 0.2 weight → 0.8", () => {
  assert.equal(computeScore({ root_cause_correct: true, evidence_grounded: true, false_leads: true }), 0.8);
});

test("scores are bounded in [0,1] across all 8 axis combinations", () => {
  for (const a of [true, false]) for (const b of [true, false]) for (const c of [true, false]) {
    const s = computeScore({ root_cause_correct: a, evidence_grounded: b, false_leads: c });
    assert.ok(s >= 0 && s <= 1, `score ${s} out of range`);
  }
});

// ── 3. polarity: false_leads:true lowers the score ────────────────────────────
test("false_leads:true strictly lowers the score vs false_leads:false", () => {
  const clear = computeScore({ root_cause_correct: true, evidence_grounded: true, false_leads: false });
  const chased = computeScore({ root_cause_correct: true, evidence_grounded: true, false_leads: true });
  assert.ok(chased < clear);
  assert.equal(Math.round((clear - chased) * 1e6) / 1e6, WEIGHTS.no_false_leads);
});

// ── 4. diagnosis shape ──────────────────────────────────────────────────────
test("buildDiagnosis stamps schema, rubric and judge model", () => {
  const d = buildDiagnosis({
    runId: "run-abc", scenario: "decoy-deploy-control",
    axes: { root_cause_correct: true, evidence_grounded: false, false_leads: false },
    rationale: "grounded enough", judgeModel: "qwen3-coder:480b-cloud",
  });
  assert.equal(d.schema_version, SCHEMA_VERSION);
  assert.equal(d.rubric_version, RUBRIC_VERSION);
  assert.equal(d.judge_model, "qwen3-coder:480b-cloud");
  assert.match(d.judged_at, /^\d{4}-\d{2}-\d{2}T/);
});

// ── 5. parse-retry: malformed then valid; 3 malformed → non-fatal ─────────────
test("runJudge retries past a malformed reply and succeeds on the next valid one", async () => {
  const replies = ["not json at all", '```json\n{"root_cause_correct":true,"evidence_grounded":true,"false_leads":false,"rationale":"ok"}\n```'];
  let i = 0;
  const result = await runJudge({ prompt: "p", callModel: async () => replies[i++] });
  assert.ok(result);
  assert.equal(result.axes.root_cause_correct, true);
  assert.equal(result.rationale, "ok");
});

test("runJudge returns null after 3 malformed replies (non-fatal)", async () => {
  let calls = 0;
  const result = await runJudge({ prompt: "p", callModel: async () => { calls++; return "garbage"; } });
  assert.equal(result, null);
  assert.equal(calls, 3);
});

test("--judge exits 0 and writes no diagnosis when the model call fails (best-effort)", () => {
  // Point at an unroutable host so the fetch fails fast; must still exit 0.
  const out = tmp();
  const r = runCli(
    ["--judge", "--rca-file", join(FIX, "oracle.md"), "--scenario", scenarioDir(), "--out", out],
    { RCA_JUDGE_MODEL: "test-model", OLLAMA_HOST: "http://127.0.0.1:1" },
  );
  assert.equal(r.exit, 0);
  assert.ok(!existsSync(join(out, "diagnosis.json")));
});

test("--judge fails fast when RCA_JUDGE_MODEL is unset (no silent default)", () => {
  const r = runCli(
    ["--judge", "--rca-file", join(FIX, "oracle.md"), "--scenario", scenarioDir()],
    { RCA_JUDGE_MODEL: "" },
  );
  assert.notEqual(r.exit, 0);
  assert.match(r.err, /RCA_JUDGE_MODEL/);
});

// ── 6. run-dir mode reads banked rca.txt; --rca-file works without a run dir ───
function scenarioDir() {
  // A throwaway scenario dir with verify/oracle.md = the fixture.
  const d = tmp();
  mkdirSync(join(d, "verify"), { recursive: true });
  writeFileSync(join(d, "verify", "oracle.md"), oracleMd, "utf8");
  return d;
}

test("--prepare reads banked rca.txt from a run dir and writes judge-input.md", () => {
  const run = tmp();
  writeFileSync(join(run, "rca.txt"), "BANKED_RCA_FROM_RUN_DIR", "utf8");
  const r = runCli(["--prepare", "--run-dir", run, "--scenario", scenarioDir()]);
  assert.equal(r.exit, 0);
  const prompt = readFileSync(join(run, "judge-input.md"), "utf8");
  assert.match(prompt, /BANKED_RCA_FROM_RUN_DIR/);
  assert.match(prompt, /CACHE_TYPE=NullCache/);
});

test("--prepare falls back to rca.json raw_text when rca.txt is absent", () => {
  const run = tmp();
  writeFileSync(join(run, "rca.json"), JSON.stringify({ schema_version: "agent-rca.v1", run_id: "x", raw_text: "RAW_FROM_JSON" }), "utf8");
  const r = runCli(["--prepare", "--run-dir", run, "--scenario", scenarioDir()]);
  assert.equal(r.exit, 0);
  assert.match(readFileSync(join(run, "judge-input.md"), "utf8"), /RAW_FROM_JSON/);
});

test("--prepare works with --rca-file and no run dir (prismalens surface)", () => {
  const out = tmp();
  const rca = join(out, "the-rca.txt");
  writeFileSync(rca, "STANDALONE_RCA", "utf8");
  const r = runCli(["--prepare", "--rca-file", rca, "--scenario", scenarioDir(), "--out", out]);
  assert.equal(r.exit, 0);
  assert.match(readFileSync(join(out, "judge-input.md"), "utf8"), /STANDALONE_RCA/);
});

// ── 7. decoy fixture: --grade of a false-lead verdict handles polarity ─────────
test("--grade of the decoy false-lead verdict writes a low-scoring diagnosis", () => {
  const out = tmp();
  const r = runCli([
    "--grade", join(FIX, "verdict-decoy-false-lead.json"),
    "--out", out, "--run-id", "run-decoy", "--scenario-id", "decoy-deploy-control",
    "--judge-model", "external",
  ]);
  assert.equal(r.exit, 0);
  const d = JSON.parse(readFileSync(join(out, "diagnosis.json"), "utf8"));
  assert.equal(d.axes.false_leads, true);
  assert.equal(d.score, 0); // all-false + false_leads
  assert.equal(d.run_id, "run-decoy");
  assert.equal(d.scenario, "decoy-deploy-control");
});

test("--grade stamps rubric_version and judge_model; re-grade overwrites idempotently", () => {
  const out = tmp();
  const verdict = join(out, "v.json");
  writeFileSync(verdict, JSON.stringify({ root_cause_correct: true, evidence_grounded: true, false_leads: false, rationale: "r" }), "utf8");
  runCli(["--grade", verdict, "--out", out, "--run-id", "r1", "--scenario-id", "s1", "--judge-model", "m1"]);
  const first = JSON.parse(readFileSync(join(out, "diagnosis.json"), "utf8"));
  assert.equal(first.rubric_version, RUBRIC_VERSION);
  assert.equal(first.judge_model, "m1");
  assert.equal(first.score, 1);
  // Re-grade with a different model → overwrite in place.
  runCli(["--grade", verdict, "--out", out, "--run-id", "r1", "--scenario-id", "s1", "--judge-model", "m2"]);
  const second = JSON.parse(readFileSync(join(out, "diagnosis.json"), "utf8"));
  assert.equal(second.judge_model, "m2");
});

test("parseVerdict rejects a verdict missing a required boolean", () => {
  assert.equal(parseVerdict('{"root_cause_correct":true,"evidence_grounded":true}'), null);
});
