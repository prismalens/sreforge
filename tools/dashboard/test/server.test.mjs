// Dashboard server against a fake task runner (test/fake-task.mjs).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createDashboard } from "../server.mjs";

const fake = fileURLToPath(new URL("./fake-task.mjs", import.meta.url));
process.env.FAKE_DELAY_MS = "400";
let server;
let base;

before(async () => {
  server = createDashboard({ task: [process.execPath, fake] });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const run = (body) => fetch(`${base}/api/run`, { method: "POST", body: JSON.stringify(body) });

async function waitForDone() {
  const res = await fetch(`${base}/api/log`);
  const reader = res.body.getReader();
  let text = "";
  while (!text.includes("event: done")) text += new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  return text;
}

test("status is proxied from task status --json", async () => {
  const res = await fetch(`${base}/api/status`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.fault.scenario, "worker-cpu-starvation");
  assert.equal(body.scenarios.length, 3);
  assert.equal(body.job, null);
});

test("an unknown scenario id is rejected", async () => {
  const res = await run({ action: "fault", scenario: "rm -rf /", on: true });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Unknown scenario/);
});

test("a second concurrent command is refused", async () => {
  const [first, second] = await Promise.all([run({ action: "up" }), run({ action: "down" })]);
  assert.equal(first.status, 202);
  assert.equal(second.status, 409);
  assert.match((await second.json()).error, /Busy: "up"/);
  assert.match(await waitForDone(), /fake task up/);
});

test("turning a scenario on turns the current one off first", async () => {
  const res = await run({ action: "fault", scenario: "upstream-timeout", on: true });
  assert.equal(res.status, 202);
  const log = await waitForDone();
  const off = log.indexOf("fake task fault -- worker-cpu-starvation off");
  const on = log.indexOf("fake task fault -- upstream-timeout on");
  assert.ok(off >= 0 && on > off, log);
});
