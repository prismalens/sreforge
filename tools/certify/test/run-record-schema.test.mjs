import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { validate } from "../lib/json-schema-mini.mjs";
import { toDiskRecord, pruneDiskRecord } from "../../../core/dist/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(HERE, "../schemas/run-record.v1.schema.json");
const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));

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
  timings: { run: 100 },
  startedAt: "2023-01-01T00:00:00Z",
  finishedAt: "2023-01-01T00:01:00Z",
};

test("full record validates", () => {
  const disk = toDiskRecord(dummyRecord, { session: "cold" });
  const errors = validate(schema, disk);
  assert.deepEqual(errors, []);
});

test("pruned record validates", () => {
  const disk = toDiskRecord(dummyRecord, { session: "cold" });
  const pruned = pruneDiskRecord(disk);
  const errors = validate(schema, pruned);
  assert.deepEqual(errors, []);
});

test("camelCase record fails validation", () => {
  const errors = validate(schema, dummyRecord);
  assert.notEqual(errors.length, 0);
});

// #107 — trigger.kickoff_alert is OPTIONAL: banked historical records carry no
// such field and must keep validating, while a record that names its kickoff
// must validate too (the trigger scope is additionalProperties:false, so an
// unknown key is a hard failure — the schema has to know about it).
test("record naming its kickoff alert validates", () => {
  const withKickoff = {
    ...dummyRecord,
    trigger: { ...dummyRecord.trigger, kickoffAlert: "HighErrorRate" },
  };
  const disk = toDiskRecord(withKickoff, { session: "cold" });
  assert.equal(disk.trigger.kickoff_alert, "HighErrorRate");
  assert.deepEqual(validate(schema, disk), []);
});

test("record without a kickoff alert still validates (optional, absent not null)", () => {
  const disk = toDiskRecord(dummyRecord, { session: "cold" });
  assert.ok(!("kickoff_alert" in disk.trigger));
  assert.deepEqual(validate(schema, disk), []);
});

test("non-string kickoff_alert fails validation", () => {
  const disk = toDiskRecord(dummyRecord, { session: "cold" });
  disk.trigger.kickoff_alert = 42;
  assert.notEqual(validate(schema, disk).length, 0);
});
