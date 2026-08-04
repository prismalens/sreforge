import test from "node:test";
import assert from "node:assert/strict";
import {
  toDiskRecord,
  fromDiskRecord,
  serializeDiskRecord,
  pruneDiskRecord,
} from "../dist/record/serialize.js";
import { createHash } from "node:crypto";

const dummyRecord = {
  runId: "run-123",
  scenarioId: "scenario-1",
  profile: "incident",
  trigger: {
    source: "prom",
    alertName: "HighErrorRate",
    severity: "critical",
    labels: { app: "foo" },
    annotations: { desc: "bar" },
    firedAt: "2023-01-01T00:00:00Z",
  },
  trajectory: {
    agentName: "agent-1",
    transcript: "hello",
    diff: "diff1",
    submitted: true,
    durationMs: 100,
  },
  diff: "diff1",
  ci: {
    green: true,
    output: "ok",
    exitCode: 0,
    durationMs: 200,
  },
  deploy: {
    redeployed: true,
    service: "web",
    durationMs: 300,
  },
  score: {
    oracleId: "main",
    score: 1.0,
    passed: true,
    signals: [
      { id: "s1", satisfied: true, value: 1.0, weight: 1.0, detail: "ok" }
    ],
  },
  verdict: "passed",
  timings: {
    run: 100,
  },
  startedAt: "2023-01-01T00:00:00Z",
  finishedAt: "2023-01-01T00:01:00Z",
};

test("serialize round-trip", () => {
  const disk = toDiskRecord(dummyRecord, { test_transcript: true });
  assert.equal(disk.record_version, "1.0.0");
  assert.equal(disk.kind, "run-record");
  assert.equal(disk.run_id, "run-123");
  assert.equal(disk.trigger.alert_name, "HighErrorRate");
  assert.equal(disk.trajectory.agent_name, "agent-1");
  assert.deepEqual(disk.agent_transcript, { test_transcript: true });

  const restored = fromDiskRecord(disk);
  assert.deepEqual(restored, dummyRecord);
});

test("pruneDiskRecord", () => {
  const full = toDiskRecord(dummyRecord, {
    schema_version: "1.0",
    run_id: "run-123",
    harness: "cli",
    session: "cold",
    confinement: "host-sandboxed",
    model: "test-model",
    raw_text: "some raw output",
    raw_json: { foo: "bar" },
    other_stuff: 123
  });
  const bytes = serializeDiskRecord(full);
  const expectedSha = createHash("sha256").update(bytes).digest("hex");

  const pruned = pruneDiskRecord(full);
  assert.equal(pruned.trajectory.transcript, undefined);
  assert.deepEqual(pruned.agent_transcript, {
    schema_version: "1.0",
    run_id: "run-123",
    harness: "cli",
    session: "cold",
    confinement: "host-sandboxed",
    model: "test-model"
  });
  assert.equal(pruned.full_record_sha256, expectedSha);
  
  // ensure original isn't mutated
  assert.equal(full.trajectory.transcript, "hello");
  assert.equal(full.agent_transcript.raw_text, "some raw output");
});

test("pruneDiskRecord with missing agent_transcript", () => {
  const full = toDiskRecord(dummyRecord);
  const pruned = pruneDiskRecord(full);
  assert.equal(pruned.agent_transcript, undefined);
});

test("serialize round-trip with absent optionals", () => {
  const minimal = { ...dummyRecord };
  minimal.trigger = { ...minimal.trigger };
  delete minimal.trigger.severity;
  minimal.ci = { ...minimal.ci };
  delete minimal.ci.exitCode;

  const disk = toDiskRecord(minimal);
  assert.equal("severity" in disk.trigger, false, "severity should be absent on disk record");
  assert.equal("exit_code" in disk.ci, false, "exit_code should be absent on disk record");

  const restored = fromDiskRecord(disk);
  assert.deepEqual(restored, minimal);
  assert.equal("severity" in restored.trigger, false);
  assert.equal("exitCode" in restored.ci, false);
});

// #107 — the alert the run actually kicked off on rides in the record, so the
// kickoff variance is auditable after the fact.
test("kickoff alert round-trips as trigger.kickoff_alert", () => {
  const withKickoff = {
    ...dummyRecord,
    trigger: { ...dummyRecord.trigger, kickoffAlert: "HighErrorRate" },
  };

  const disk = toDiskRecord(withKickoff);
  assert.equal(disk.trigger.kickoff_alert, "HighErrorRate");

  const restored = fromDiskRecord(disk);
  assert.equal(restored.trigger.kickoffAlert, "HighErrorRate");
  assert.deepEqual(restored, withKickoff);
});

test("kickoff alert is ABSENT, not null, when unknown", () => {
  const disk = toDiskRecord(dummyRecord);
  assert.equal("kickoff_alert" in disk.trigger, false);

  const restored = fromDiskRecord(disk);
  assert.equal("kickoffAlert" in restored.trigger, false);
  assert.deepEqual(restored, dummyRecord);
});

test("serializeDiskRecord determinism", () => {
  const disk1 = toDiskRecord(dummyRecord);
  disk1.trigger.labels = { a: "1", b: "2" };

  const disk2 = toDiskRecord(dummyRecord);
  disk2.trigger.labels = { b: "2", a: "1" };

  const bytes1 = serializeDiskRecord(disk1);
  const bytes2 = serializeDiskRecord(disk2);

  assert.equal(bytes1, bytes2, "byte output should be identical regardless of key insertion order");
});
