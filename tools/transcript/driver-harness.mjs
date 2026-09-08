export const DRIVERS = [
  { match: "agent-agy.sh",     harness: "agy",        confinement: "host-sandboxed" },
  { match: "agent-ollama.mjs", harness: "ollama",     confinement: "host-open" },
  { match: "agent-inbox.sh",   harness: "agent-loop", confinement: "in-box" },
];

export function driverFor(agentCmd) {
  if (typeof agentCmd !== "string") {
    return null;
  }
  for (const driver of DRIVERS) {
    if (agentCmd.includes(driver.match)) {
      return driver;
    }
  }
  return null;
}

export function resolveConfig(env = {}) {
  const agentCmd = env.AGENT_CMD || "node scripts/agent-ollama.mjs";
  const driver = driverFor(agentCmd);
  return {
    agentCmd,
    runner: env.RUNNER || env.AGENT_MODE || "scripted",
    scenarioId: env.SCENARIO_ID || "latency-cache-stampede",
    provider: env.PROVIDER || "",
    model: env.AGY_MODEL || "",
    harness: driver?.harness ?? null,
    confinement: driver?.confinement ?? null,
  };
}

function renderVal(val) {
  if (val === "" || val === null || val === undefined) {
    return "(unset)";
  }
  return String(val);
}

export function formatBanner(cfg) {
  return `auto ── resolved config: AGENT_CMD=${renderVal(cfg.agentCmd)} RUNNER=${renderVal(cfg.runner)} SCENARIO_ID=${renderVal(cfg.scenarioId)} PROVIDER=${renderVal(cfg.provider)} MODEL=${renderVal(cfg.model)} CONFINEMENT=${renderVal(cfg.confinement)} HARNESS=${renderVal(cfg.harness)}`;
}
