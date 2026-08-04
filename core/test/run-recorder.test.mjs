// FileRunRecorder transcript-ingestion tests (#31).
//
// The agent transcript arrives out-of-band: a harness drops a raw handoff file
// at a fixed path and the recorder files it under the run. A fixed path with no
// correlation check would silently file a PREVIOUS run's transcript as this
// run's evidence, so the run_id must match or the handoff is rejected.
//
// The load-bearing property here is the last test: a transcript problem must
// never cost us the graded record. The verdict is outcome-based (ADR-0004) and
// does not depend on the transcript, so losing record.json over a bad handoff
// would be strictly worse than having no transcript at all.
//
//   npm test   # (builds first, then runs this)

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileRunRecorder } from "../dist/index.js";

const RUN_ID = "test-run-1";

/** Minimal RunRecord — only the fields the recorder itself reads. */
function makeRecord(runId = RUN_ID) {
  return {
    runId,
    scenarioId: "latency-cache-stampede",
    profile: "incident",
    trigger: {
      source: "prometheus-alert",
      alertName: "BooklogrApiLatencyP99High",
      labels: {},
      annotations: {},
      firedAt: "2026-07-19T10:00:00Z",
    },
    trajectory: {
      agentName: "external",
      transcript: "runner event log, not the agent transcript",
      diff: "--- a\n+++ b\n",
      submitted: true,
      durationMs: 1000,
    },
    diff: "--- a\n+++ b\n",
    ci: null,
    deploy: null,
    score: { oracleId: "mitigation", score: 1, passed: true, signals: [] },
    verdict: "passed",
    timings: {},
    startedAt: "2026-07-19T10:00:00Z",
    finishedAt: "2026-07-19T10:05:00Z",
  };
}

function makeHandoff(dir, runId) {
  const p = join(dir, "agent-transcript.json");
  writeFileSync(
    p,
    JSON.stringify({
      schema_version: "agent-transcript.v1",
      run_id: runId,
      harness: "agy",
      session: "cold",
      confinement: "host-sandboxed",
      captured_at: "2026-07-19T10:04:00Z",
      raw_text: "agent output goes here",
    }),
  );
  return p;
}

function tmp() {
  return mkdtempSync(join(tmpdir(), "sreforge-recorder-"));
}

test("ingests the handoff when the run id matches", async () => {
  const base = tmp();
  const handoff = makeHandoff(tmp(), RUN_ID);

  const runDir = await new FileRunRecorder({
    baseDir: base,
    transcriptHandoffPath: handoff,
  }).record(makeRecord());

  const ingested = join(runDir, "agent-transcript.json");
  assert.ok(existsSync(ingested), "agent-transcript.json should be written");
  assert.equal(
    JSON.parse(readFileSync(ingested, "utf8")).raw_text,
    "agent output goes here",
  );
  assert.ok(!existsSync(join(runDir, "transcript-error.txt")));

  const written = JSON.parse(readFileSync(join(runDir, "record.json"), "utf8"));
  assert.equal(written.record_version, "1.0.0");
  assert.equal(written.kind, "run-record");
  assert.equal(written.run_id, RUN_ID);
  assert.equal(written.agent_transcript.raw_text, "agent output goes here");
});

test("refuses the handoff when the run id does not match", async () => {
  const base = tmp();
  const handoff = makeHandoff(tmp(), "some-other-run");

  const runDir = await new FileRunRecorder({
    baseDir: base,
    transcriptHandoffPath: handoff,
  }).record(makeRecord());

  assert.ok(
    !existsSync(join(runDir, "agent-transcript.json")),
    "a mismatched transcript must NOT be filed as this run's evidence",
  );
  const err = readFileSync(join(runDir, "transcript-error.txt"), "utf8");
  assert.match(err, /some-other-run/);
  assert.match(err, new RegExp(RUN_ID));
});

test("is a no-op when no handoff exists", async () => {
  const base = tmp();

  const runDir = await new FileRunRecorder({
    baseDir: base,
    transcriptHandoffPath: join(tmp(), "does-not-exist.json"),
  }).record(makeRecord());

  assert.ok(!existsSync(join(runDir, "agent-transcript.json")));
  assert.ok(!existsSync(join(runDir, "transcript-error.txt")));
  assert.ok(existsSync(join(runDir, "record.json")), "record.json is still written");
});

test("a malformed handoff never costs us the graded record", async () => {
  const base = tmp();
  const dir = tmp();
  const handoff = join(dir, "agent-transcript.json");
  writeFileSync(handoff, "{ this is not json");

  const runDir = await new FileRunRecorder({
    baseDir: base,
    transcriptHandoffPath: handoff,
  }).record(makeRecord());

  const written = JSON.parse(readFileSync(join(runDir, "record.json"), "utf8"));
  assert.equal(written.verdict, "passed", "the verdict must survive a bad transcript");
  assert.equal(written.agent_transcript, undefined);
  assert.ok(existsSync(join(runDir, "diff.patch")));
  assert.ok(existsSync(join(runDir, "transcript.txt")));
  assert.ok(!existsSync(join(runDir, "agent-transcript.json")));
});

test("writes pruned and full records when configured", async () => {
  const base = tmp();
  const prunedDir = tmp();
  const fullDir = tmp();
  
  const handoff = makeHandoff(tmp(), RUN_ID);

  const runDir = await new FileRunRecorder({
    baseDir: base,
    transcriptHandoffPath: handoff,
    prunedRecordDir: prunedDir,
    fullRecordStoreDir: fullDir,
  }).record(makeRecord());

  const fullBytes = readFileSync(join(runDir, "record.json"));
  
  const prunedPath = join(prunedDir, `${RUN_ID}.json`);
  assert.ok(existsSync(prunedPath), "pruned record must be written");
  const pruned = JSON.parse(readFileSync(prunedPath, "utf8"));
  assert.equal(pruned.trajectory.transcript, undefined);
  assert.deepEqual(pruned.agent_transcript, {
    schema_version: "agent-transcript.v1",
    run_id: RUN_ID,
    harness: "agy",
    session: "cold",
    confinement: "host-sandboxed",
    captured_at: "2026-07-19T10:04:00Z",
  });
  assert.ok(pruned.full_record_sha256, "pruned record must have sha256");

  const fullPath = join(fullDir, `${pruned.full_record_sha256}.json`);
  assert.ok(existsSync(fullPath), "full record must be written at content-addressed path");
  const storedFullBytes = readFileSync(fullPath);
  assert.equal(storedFullBytes.toString("utf8"), fullBytes.toString("utf8"), "full record must match exactly");
});

test("mismatched handoff with pruned and full record configured", async () => {
  const base = tmp();
  const prunedDir = tmp();
  const fullDir = tmp();
  
  const handoff = makeHandoff(tmp(), "some-other-run");

  const runDir = await new FileRunRecorder({
    baseDir: base,
    transcriptHandoffPath: handoff,
    prunedRecordDir: prunedDir,
    fullRecordStoreDir: fullDir,
  }).record(makeRecord());

  assert.ok(existsSync(join(runDir, "record.json")));
  assert.ok(existsSync(join(runDir, "transcript-error.txt")));
  assert.ok(!existsSync(join(runDir, "agent-transcript.json")));

  const written = JSON.parse(readFileSync(join(runDir, "record.json"), "utf8"));
  assert.equal(written.agent_transcript, undefined);

  const prunedPath = join(prunedDir, `${RUN_ID}.json`);
  assert.ok(existsSync(prunedPath), "pruned record must be written");
  const pruned = JSON.parse(readFileSync(prunedPath, "utf8"));
  assert.equal(pruned.agent_transcript, undefined);
  assert.ok(pruned.full_record_sha256, "pruned record must have sha256");

  const fullPath = join(fullDir, `${pruned.full_record_sha256}.json`);
  assert.ok(existsSync(fullPath), "full record must be written at content-addressed path");
});


function makeRcaHandoff(dir, runId) {
  const p = join(dir, "agent-rca.json");
  writeFileSync(
    p,
    JSON.stringify({
      schema_version: "agent-rca.v1",
      run_id: runId,
      harness: "agy",
      session: "cold",
      captured_at: "2026-07-19T10:04:00Z",
      raw_text: "rca output goes here",
    }),
  );
  return p;
}

test("ingests the rca when the run id matches", async () => {
  const base = tmp();
  const rcaHandoff = makeRcaHandoff(tmp(), RUN_ID);

  const runDir = await new FileRunRecorder({
    baseDir: base,
    rcaHandoffPath: rcaHandoff,
  }).record(makeRecord());

  const ingestedJson = join(runDir, "rca.json");
  assert.ok(existsSync(ingestedJson), "rca.json should be written");
  assert.equal(
    JSON.parse(readFileSync(ingestedJson, "utf8")).raw_text,
    "rca output goes here",
  );
  const ingestedTxt = join(runDir, "rca.txt");
  assert.ok(existsSync(ingestedTxt), "rca.txt should be written");
  assert.equal(readFileSync(ingestedTxt, "utf8"), "rca output goes here");
  assert.ok(!existsSync(join(runDir, "rca-error.txt")));

  const written = JSON.parse(readFileSync(join(runDir, "record.json"), "utf8"));
  assert.equal(written.rca, undefined, "record.json must not contain an rca field");
});

test("refuses the rca when the run id does not match", async () => {
  const base = tmp();
  const rcaHandoff = makeRcaHandoff(tmp(), "some-other-run");

  const runDir = await new FileRunRecorder({
    baseDir: base,
    rcaHandoffPath: rcaHandoff,
  }).record(makeRecord());

  assert.ok(!existsSync(join(runDir, "rca.json")), "mismatched rca must NOT be filed");
  assert.ok(!existsSync(join(runDir, "rca.txt")), "mismatched rca must NOT be filed");
  
  const err = readFileSync(join(runDir, "rca-error.txt"), "utf8");
  assert.match(err, /some-other-run/);
  assert.match(err, new RegExp(RUN_ID));

  const written = JSON.parse(readFileSync(join(runDir, "record.json"), "utf8"));
  assert.equal(written.rca, undefined, "record.json must not contain an rca field");
});

test("a malformed rca handoff never affects record.json or transcript", async () => {
  const base = tmp();
  const dir = tmp();
  const rcaHandoff = join(dir, "agent-rca.json");
  writeFileSync(rcaHandoff, "{ this is not json");
  
  const handoff = makeHandoff(tmp(), RUN_ID);

  const runDir = await new FileRunRecorder({
    baseDir: base,
    transcriptHandoffPath: handoff,
    rcaHandoffPath: rcaHandoff,
  }).record(makeRecord());

  const written = JSON.parse(readFileSync(join(runDir, "record.json"), "utf8"));
  assert.equal(written.verdict, "passed", "the verdict must survive a bad rca");
  assert.equal(written.rca, undefined);
  assert.equal(written.agent_transcript.raw_text, "agent output goes here", "transcript ingestion unaffected");
  assert.ok(existsSync(join(runDir, "agent-transcript.json")));
  assert.ok(!existsSync(join(runDir, "rca.json")));
  assert.ok(!existsSync(join(runDir, "rca.txt")));
});

test("refuses the rca when raw_text is not a string", async () => {
  const base = tmp();
  const dir = tmp();
  const rcaHandoff = join(dir, "agent-rca.json");
  writeFileSync(
    rcaHandoff,
    JSON.stringify({
      schema_version: "agent-rca.v1",
      run_id: RUN_ID,
      raw_text: { some: "object" },
    }),
  );

  const runDir = await new FileRunRecorder({
    baseDir: base,
    rcaHandoffPath: rcaHandoff,
  }).record(makeRecord());

  assert.ok(!existsSync(join(runDir, "rca.json")), "invalid rca must NOT be filed");
  assert.ok(!existsSync(join(runDir, "rca.txt")), "invalid rca must NOT be filed");
  const written = JSON.parse(readFileSync(join(runDir, "record.json"), "utf8"));
  assert.equal(written.verdict, "passed");
});

test("refuses the rca when schema_version is wrong", async () => {
  const base = tmp();
  const dir = tmp();
  const rcaHandoff = join(dir, "agent-rca.json");
  writeFileSync(
    rcaHandoff,
    JSON.stringify({
      schema_version: "wrong-version",
      run_id: RUN_ID,
      raw_text: "text",
    }),
  );

  const runDir = await new FileRunRecorder({
    baseDir: base,
    rcaHandoffPath: rcaHandoff,
  }).record(makeRecord());

  assert.ok(!existsSync(join(runDir, "rca.json")), "invalid rca must NOT be filed");
  assert.ok(!existsSync(join(runDir, "rca.txt")), "invalid rca must NOT be filed");
  const written = JSON.parse(readFileSync(join(runDir, "record.json"), "utf8"));
  assert.equal(written.verdict, "passed");
});

// ---------------------------------------------------------------------------
// #107 — the kickoff handoff: which alert actually opened the run. Same rules as
// every other handoff (run-id correlated, best-effort), because the same failure
// mode applies: a stale file would file the PREVIOUS run's kickoff as this one's.
// ---------------------------------------------------------------------------

function makeKickoff(dir, runId, alert = "BooklogrApiLatencyP99High") {
  const p = join(dir, "agent-kickoff.json");
  writeFileSync(
    p,
    JSON.stringify({
      schema_version: "agent-kickoff.v1",
      run_id: runId,
      kickoff_alert: alert,
    }),
  );
  return p;
}

test("records the kickoff alert when the run id matches", async () => {
  const base = tmp();
  const kickoff = makeKickoff(tmp(), RUN_ID, "EdgeClientRequestJitter");

  const runDir = await new FileRunRecorder({
    baseDir: base,
    kickoffHandoffPath: kickoff,
  }).record(makeRecord());

  const written = JSON.parse(readFileSync(join(runDir, "record.json"), "utf8"));
  assert.equal(written.trigger.kickoff_alert, "EdgeClientRequestJitter");
  // The trigger the engine polled is untouched — the record carries both truths.
  assert.equal(written.trigger.alert_name, "BooklogrApiLatencyP99High");
});

test("refuses the kickoff handoff when the run id does not match", async () => {
  const base = tmp();
  const kickoff = makeKickoff(tmp(), "some-other-run");

  const runDir = await new FileRunRecorder({
    baseDir: base,
    kickoffHandoffPath: kickoff,
  }).record(makeRecord());

  const written = JSON.parse(readFileSync(join(runDir, "record.json"), "utf8"));
  assert.ok(
    !("kickoff_alert" in written.trigger),
    "a mismatched kickoff must NOT be filed as this run's evidence",
  );
  assert.equal(written.verdict, "passed");
});

test("a missing or malformed kickoff handoff never costs the record", async () => {
  const base = tmp();
  const dir = tmp();
  const bad = join(dir, "agent-kickoff.json");
  writeFileSync(bad, "{not json");

  const runDir = await new FileRunRecorder({
    baseDir: base,
    kickoffHandoffPath: bad,
  }).record(makeRecord());

  const written = JSON.parse(readFileSync(join(runDir, "record.json"), "utf8"));
  assert.ok(!("kickoff_alert" in written.trigger));
  assert.equal(written.verdict, "passed");

  const absent = await new FileRunRecorder({
    baseDir: tmp(),
    kickoffHandoffPath: join(tmp(), "nope.json"),
  }).record(makeRecord());
  const written2 = JSON.parse(readFileSync(join(absent, "record.json"), "utf8"));
  assert.ok(!("kickoff_alert" in written2.trigger));
});
