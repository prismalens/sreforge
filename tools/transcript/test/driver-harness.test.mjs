import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  driverFor,
  resolveConfig,
  formatBanner,
} from "../driver-harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");

test("1. driverFor resolves agy driver with host-sandboxed confinement", () => {
  const driver = driverFor("bash scripts/agent-agy.sh");
  assert.equal(driver?.harness, "agy");
  assert.equal(driver?.confinement, "host-sandboxed");
});

test("2. driverFor resolves ollama driver", () => {
  const driver = driverFor("node scripts/agent-ollama.mjs");
  assert.equal(driver?.harness, "ollama");
});

test("3. driverFor resolves inbox driver", () => {
  const driver = driverFor("bash scripts/agent-inbox.sh");
  assert.equal(driver?.harness, "agent-loop");
});

test("4. driverFor returns null for unknown driver", () => {
  const driver = driverFor("node scripts/mystery.mjs");
  assert.equal(driver, null);
});

test("5. resolveConfig returns default config", () => {
  const cfg = resolveConfig({});
  assert.equal(cfg.agentCmd, "node scripts/agent-ollama.mjs");
  assert.equal(cfg.runner, "scripted");
  assert.equal(cfg.scenarioId, "latency-cache-stampede");
  assert.equal(cfg.harness, "ollama");
});

test("6. resolveConfig resolves explicit agy env", () => {
  const cfg = resolveConfig({
    AGENT_CMD: "bash scripts/agent-agy.sh",
    PROVIDER: "antigravity",
    AGY_MODEL: "m",
  });
  assert.equal(cfg.harness, "agy");
  assert.equal(cfg.confinement, "host-sandboxed");
  assert.equal(cfg.provider, "antigravity");
  assert.equal(cfg.model, "m");
});

test("7. formatBanner matches exact pinned banner literal", () => {
  const banner = formatBanner(resolveConfig({}));
  assert.equal(
    banner,
    "auto ── resolved config: AGENT_CMD=node scripts/agent-ollama.mjs RUNNER=scripted SCENARIO_ID=latency-cache-stampede PROVIDER=(unset) MODEL=(unset) CONFINEMENT=host-open HARNESS=ollama",
  );
});

test("8. formatBanner contains PROVIDER=(unset) for empty value", () => {
  const banner = formatBanner(resolveConfig({}));
  assert.ok(banner.includes("PROVIDER=(unset)"));
});

test("9. the banner cannot disagree with the record", () => {
  const driversToTest = [
    {
      cmd: "bash scripts/agent-agy.sh",
      file: "use-cases/booklogr/stacks/flask-compose/scripts/agent-agy.sh",
    },
    {
      cmd: "node scripts/agent-ollama.mjs",
      file: "use-cases/booklogr/stacks/flask-compose/scripts/agent-ollama.mjs",
    },
    {
      cmd: "bash scripts/agent-inbox.sh",
      file: "use-cases/booklogr/stacks/flask-compose/scripts/agent-inbox.sh",
    },
  ];

  for (const { cmd, file } of driversToTest) {
    const resolved = resolveConfig({ AGENT_CMD: cmd });
    const content = readFileSync(resolve(REPO_ROOT, file), "utf8");

    const harnessMatch = content.match(/(?:--harness["']?\s*,?\s*["'])([^"']+)["']/);
    assert.ok(harnessMatch, `Missing --harness in ${file}`);
    assert.equal(
      harnessMatch[1],
      resolved.harness,
      `Harness mismatch in ${file}: file has '${harnessMatch[1]}' but resolved is '${resolved.harness}'`,
    );

    const confinementMatch = content.match(/(?:--confinement["']?\s*,?\s*["'])([^"']+)["']/);
    assert.ok(confinementMatch, `Missing --confinement in ${file}`);
    assert.equal(
      confinementMatch[1],
      resolved.confinement,
      `Confinement mismatch in ${file}: file has '${confinementMatch[1]}' but resolved is '${resolved.confinement}'`,
    );
  }
});

test("10. the Taskfile keeps its env fallbacks", () => {
  const taskfilePath = resolve(
    REPO_ROOT,
    "use-cases/booklogr/stacks/flask-compose/Taskfile.yml",
  );
  const taskfileText = readFileSync(taskfilePath, "utf8");
  const requiredKeys = [
    "AGENT_CMD",
    "RUNNER",
    "SCENARIO_ID",
    "PROVIDER",
    "AGY_MODEL",
    "AGENT_MODE",
  ];

  for (const key of requiredKeys) {
    const pattern = new RegExp(`^\\s*${key}:.*default\\s+\\(env "${key}"\\)`, "m");
    assert.ok(
      pattern.test(taskfileText),
      `Taskfile.yml is missing fallback 'default (env "${key}")' under an env entry for ${key}`,
    );
  }
});

test("11. the preflight defaults match the driver's", () => {
  const driverText = readFileSync(
    resolve(REPO_ROOT, "use-cases/booklogr/stacks/flask-compose/scripts/agent-agy.sh"),
    "utf8",
  );
  const preflightText = readFileSync(
    resolve(REPO_ROOT, "use-cases/booklogr/stacks/flask-compose/scripts/preflight-agy.sh"),
    "utf8",
  );

  const driverModel = driverText.match(/AGY_MODEL:-([^}]+)\}/)?.[1];
  const preflightModel = preflightText.match(/AGY_MODEL:-([^}]+)\}/)?.[1];
  assert.ok(driverModel && preflightModel, "Could not find AGY_MODEL defaults");
  assert.equal(driverModel, preflightModel);

  const driverProvider = driverText.match(/PROVIDER:-([^}]+)\}/)?.[1];
  const preflightProvider = preflightText.match(/PROVIDER:-([^}]+)\}/)?.[1];
  assert.ok(driverProvider && preflightProvider, "Could not find PROVIDER defaults");
  assert.equal(driverProvider, preflightProvider);
});
