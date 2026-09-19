import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, "../write-handoff.mjs");

// spawnSync, not execFileSync: execFileSync only returns stdout, so stderr on a
// successful (exit 0) run is lost — and the invalid-JSON warning is exactly that
// case. spawnSync gives us both streams regardless of exit code.
function runScript(args, env = process.env) {
  const r = spawnSync("node", [SCRIPT, ...args], { encoding: "utf8", env });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

test("missing required arg exits 1", () => {
  const result = runScript(["--out", "/tmp/out.json", "--run-id", "123"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing required arguments/);
});

test("missing --confinement exits non-zero", () => {
  const result = runScript([
    "--out", "/tmp/out.json",
    "--run-id", "123",
    "--harness", "agy",
    "--session", "cold",
    "--raw-text-file", "/dev/null"
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing required arguments/);
  assert.match(result.stderr, /--confinement/);
});

test("invalid session exits 1", () => {
  const result = runScript([
    "--out", "/tmp/out.json",
    "--run-id", "123",
    "--harness", "agy",
    "--session", "hot",
    "--confinement", "host-sandboxed",
    "--raw-text-file", "/dev/null"
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid session value/);
});

test("invalid confinement value exits non-zero and names valid values", () => {
  const result = runScript([
    "--out", "/tmp/out.json",
    "--run-id", "123",
    "--harness", "agy",
    "--session", "cold",
    "--confinement", "bogus",
    "--raw-text-file", "/dev/null"
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid confinement value/);
  assert.match(result.stderr, /host-open/);
  assert.match(result.stderr, /host-sandboxed/);
  assert.match(result.stderr, /in-box/);
});

test("valid --confinement value lands in emitted handoff JSON", () => {
  const d = mkdtempSync(join(tmpdir(), "sreforge-test-"));
  const txtPath = join(d, "raw.txt");
  const outPath = join(d, "out.json");
  writeFileSync(txtPath, "hello world", "utf8");

  for (const tier of ["host-open", "host-sandboxed", "in-box"]) {
    const result = runScript([
      "--out", outPath,
      "--run-id", "run-tier-test",
      "--harness", "agy",
      "--session", "cold",
      "--confinement", tier,
      "--raw-text-file", txtPath
    ]);
    assert.equal(result.status, 0);
    const out = JSON.parse(readFileSync(outPath, "utf8"));
    assert.equal(out.confinement, tier);
  }
});

test("raw_text path works", () => {
  const d = mkdtempSync(join(tmpdir(), "sreforge-test-"));
  const txtPath = join(d, "raw.txt");
  const outPath = join(d, "out.json");
  writeFileSync(txtPath, "hello world", "utf8");

  const result = runScript([
    "--out", outPath,
    "--run-id", "run-1",
    "--harness", "agy",
    "--session", "cold",
    "--confinement", "host-sandboxed",
    "--raw-text-file", txtPath
  ]);
  assert.equal(result.status, 0);

  const out = JSON.parse(readFileSync(outPath, "utf8"));
  assert.equal(out.run_id, "run-1");
  assert.equal(out.harness, "agy");
  assert.equal(out.session, "cold");
  assert.equal(out.confinement, "host-sandboxed");
  assert.equal(out.raw_text, "hello world");
  assert.equal(out.raw_json, undefined);
  assert.equal(out.schema_version, "agent-transcript.v1");
  assert.ok(out.captured_at);
});

test("raw_json path works", () => {
  const d = mkdtempSync(join(tmpdir(), "sreforge-test-"));
  const jsonPath = join(d, "raw.json");
  const outPath = join(d, "out.json");
  writeFileSync(jsonPath, JSON.stringify({ a: 1 }), "utf8");

  const result = runScript([
    "--out", outPath,
    "--run-id", "run-2",
    "--harness", "agy",
    "--session", "warm",
    "--confinement", "in-box",
    "--model", "test-model",
    "--submitted", "true",
    "--raw-json-file", jsonPath
  ]);
  assert.equal(result.status, 0);

  const out = JSON.parse(readFileSync(outPath, "utf8"));
  assert.equal(out.run_id, "run-2");
  assert.equal(out.session, "warm");
  assert.equal(out.confinement, "in-box");
  assert.equal(out.model, "test-model");
  assert.equal(out.submitted, true);
  assert.deepEqual(out.raw_json, { a: 1 });
  assert.equal(out.raw_text, undefined);
});

test("invalid-JSON fallback to raw_text", () => {
  const d = mkdtempSync(join(tmpdir(), "sreforge-test-"));
  const jsonPath = join(d, "raw.json");
  const outPath = join(d, "out.json");
  writeFileSync(jsonPath, "{ bad json", "utf8");

  const result = runScript([
    "--out", outPath,
    "--run-id", "run-3",
    "--harness", "agy",
    "--session", "cold",
    "--confinement", "host-open",
    "--raw-json-file", jsonPath
  ]);
  assert.equal(result.status, 0);
  assert.match(result.stderr, /not valid JSON/);
  assert.match(result.stderr, /Falling back to raw_text/);

  const out = JSON.parse(readFileSync(outPath, "utf8"));
  assert.equal(out.raw_text, "{ bad json");
  assert.equal(out.confinement, "host-open");
  assert.equal(out.raw_json, undefined);
});

test("--kind rca works", () => {
  const d = mkdtempSync(join(tmpdir(), "sreforge-test-"));
  const txtPath = join(d, "raw.txt");
  const outPath = join(d, "out.json");
  writeFileSync(txtPath, "rca prose here", "utf8");

  const result = runScript([
    "--kind", "rca",
    "--out", outPath,
    "--run-id", "run-4",
    "--harness", "agy",
    "--session", "cold",
    "--confinement", "host-sandboxed",
    "--raw-text-file", txtPath
  ]);
  assert.equal(result.status, 0);

  const out = JSON.parse(readFileSync(outPath, "utf8"));
  assert.equal(out.run_id, "run-4");
  assert.equal(out.confinement, "host-sandboxed");
  assert.equal(out.raw_text, "rca prose here");
  assert.equal(out.schema_version, "agent-rca.v1");
});

test("invalid kind exits 1", () => {
  const result = runScript([
    "--kind", "bad",
    "--out", "/tmp/out.json",
    "--run-id", "123",
    "--harness", "agy",
    "--session", "cold",
    "--confinement", "host-sandboxed",
    "--raw-text-file", "/dev/null"
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid kind value/);
});

test("--kind rca --raw-json-file exits non-zero", () => {
  const result = runScript([
    "--kind", "rca",
    "--out", "/tmp/out.json",
    "--run-id", "123",
    "--harness", "agy",
    "--session", "cold",
    "--confinement", "host-sandboxed",
    "--raw-json-file", "/tmp/raw.json"
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /rca handoff requires --raw-text-file/);
});

test("SREFORGE_EXPECTED_HARNESS mismatch exits 1 and reports error", () => {
  const result = runScript(
    [
      "--out", "/tmp/out.json",
      "--run-id", "123",
      "--harness", "agy",
      "--session", "cold",
      "--confinement", "host-sandboxed",
      "--raw-text-file", "/dev/null",
    ],
    { ...process.env, SREFORGE_EXPECTED_HARNESS: "ollama" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Harness mismatch/);
});

test("SREFORGE_EXPECTED_HARNESS matching resolved harness exits 0 and writes handoff", () => {
  const d = mkdtempSync(join(tmpdir(), "sreforge-test-"));
  const txtPath = join(d, "raw.txt");
  const outPath = join(d, "out.json");
  writeFileSync(txtPath, "hello world", "utf8");

  const result = runScript(
    [
      "--out", outPath,
      "--run-id", "123",
      "--harness", "agy",
      "--session", "cold",
      "--confinement", "host-sandboxed",
      "--raw-text-file", txtPath,
    ],
    { ...process.env, SREFORGE_EXPECTED_HARNESS: "agy" },
  );
  assert.equal(result.status, 0);
  const out = JSON.parse(readFileSync(outPath, "utf8"));
  assert.equal(out.harness, "agy");
});

test("SREFORGE_EXPECTED_HARNESS unset exits 0 (assertion is opt-in)", () => {
  const d = mkdtempSync(join(tmpdir(), "sreforge-test-"));
  const txtPath = join(d, "raw.txt");
  const outPath = join(d, "out.json");
  writeFileSync(txtPath, "hello world", "utf8");

  const env = { ...process.env };
  delete env.SREFORGE_EXPECTED_HARNESS;

  const result = runScript(
    [
      "--out", outPath,
      "--run-id", "123",
      "--harness", "agy",
      "--session", "cold",
      "--confinement", "host-sandboxed",
      "--raw-text-file", txtPath,
    ],
    env,
  );
  assert.equal(result.status, 0);
});

test("absent --preflight stamps 'skipped' in written JSON", () => {
  const d = mkdtempSync(join(tmpdir(), "sreforge-test-"));
  const txtPath = join(d, "raw.txt");
  const outPath = join(d, "out.json");
  writeFileSync(txtPath, "hello world", "utf8");

  const result = runScript([
    "--out", outPath,
    "--run-id", "123",
    "--harness", "agy",
    "--session", "cold",
    "--confinement", "host-sandboxed",
    "--raw-text-file", txtPath,
  ]);
  assert.equal(result.status, 0);
  const out = JSON.parse(readFileSync(outPath, "utf8"));
  assert.equal(out.preflight, "skipped");
});

test("--preflight ok stamps 'ok' in written JSON", () => {
  const d = mkdtempSync(join(tmpdir(), "sreforge-test-"));
  const txtPath = join(d, "raw.txt");
  const outPath = join(d, "out.json");
  writeFileSync(txtPath, "hello world", "utf8");

  const result = runScript([
    "--out", outPath,
    "--run-id", "123",
    "--harness", "agy",
    "--session", "cold",
    "--confinement", "host-sandboxed",
    "--preflight", "ok",
    "--raw-text-file", txtPath,
  ]);
  assert.equal(result.status, 0);
  const out = JSON.parse(readFileSync(outPath, "utf8"));
  assert.equal(out.preflight, "ok");
});

test("--preflight non-ok value stamps 'skipped' in written JSON", () => {
  const d = mkdtempSync(join(tmpdir(), "sreforge-test-"));
  const txtPath = join(d, "raw.txt");
  const outPath = join(d, "out.json");
  writeFileSync(txtPath, "hello world", "utf8");

  const result = runScript([
    "--out", outPath,
    "--run-id", "123",
    "--harness", "agy",
    "--session", "cold",
    "--confinement", "host-sandboxed",
    "--preflight", "yes",
    "--raw-text-file", txtPath,
  ]);
  assert.equal(result.status, 0);
  const out = JSON.parse(readFileSync(outPath, "utf8"));
  assert.equal(out.preflight, "skipped");
});
