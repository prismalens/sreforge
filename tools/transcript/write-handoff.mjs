// write-handoff.mjs — Driver contract script to package agent transcripts or RCAs
// into a standard envelope for the engine, correlated with the runId.
import { parseArgs } from "node:util";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function run() {
  let args;
  try {
    args = parseArgs({
      options: {
        kind: { type: "string", default: "transcript" },
        out: { type: "string" },
        "run-id": { type: "string" },
        harness: { type: "string" },
        session: { type: "string" },
        confinement: { type: "string" },
        model: { type: "string" },
        provider: { type: "string" },
        submitted: { type: "string" },
        "raw-text-file": { type: "string" },
        "raw-json-file": { type: "string" },
        preflight: { type: "string" },
      },
      strict: true,
    });
  } catch (err) {
    console.error(`Usage error: ${err.message}`);
    process.exit(1);
  }

  const { values } = args;

  if (!values.out || !values["run-id"] || !values.harness || !values.session || !values.confinement) {
    console.error("Missing required arguments. Required: --out, --run-id, --harness, --session, --confinement");
    process.exit(1);
  }

  if (values.session !== "cold" && values.session !== "warm") {
    console.error("Invalid session value. Must be 'cold' or 'warm'");
    process.exit(1);
  }

  // Keep the guard below as a single-line chain of `!==` comparisons against
  // double-quoted tier names. tools/record/test/confinement-tiers-crosscheck.test.mjs
  // parses the tiers out of this line and pins them against
  // tools/record/confinement.mjs, which bank.mjs imports to refuse unlabelled
  // records (#124). The two ends of the handoff — the writer here and the banker
  // there — must never disagree about which tiers are valid.
  if (values.confinement !== "host-open" && values.confinement !== "host-sandboxed" && values.confinement !== "in-box") {
    console.error("Invalid confinement value. Must be 'host-open', 'host-sandboxed', or 'in-box'");
    process.exit(1);
  }

  if (values.kind !== "transcript" && values.kind !== "rca") {
    console.error("Invalid kind value. Must be 'transcript' or 'rca'");
    process.exit(1);
  }

  const expectedHarness = process.env.SREFORGE_EXPECTED_HARNESS;
  if (expectedHarness && expectedHarness !== values.harness) {
    console.error(`Harness mismatch: the run resolved to '${expectedHarness}' but this handoff claims '${values.harness}'. Refusing to write a mislabelled record.`);
    process.exit(1);
  }

  if (values.kind === "rca" && values["raw-json-file"]) {
    console.error("rca handoff requires --raw-text-file");
    process.exit(1);
  }

  if (!values["raw-text-file"] && !values["raw-json-file"]) {
    console.error("Must provide either --raw-text-file or --raw-json-file");
    process.exit(1);
  }

  if (values["raw-text-file"] && values["raw-json-file"]) {
    console.error("Cannot provide both --raw-text-file and --raw-json-file");
    process.exit(1);
  }

  const handoff = {
    schema_version: values.kind === "rca" ? "agent-rca.v1" : "agent-transcript.v1",
    run_id: values["run-id"],
    harness: values.harness,
    session: values.session,
    confinement: values.confinement,
    preflight: values.preflight === "ok" ? "ok" : "skipped",
    captured_at: new Date().toISOString(),
  };

  if (values.model) handoff.model = values.model;
  if (values.provider) handoff.provider = values.provider;
  if (values.submitted) handoff.submitted = values.submitted === "true";

  const rawPath = values["raw-json-file"] || values["raw-text-file"];
  let content;
  try {
    content = readFileSync(rawPath, "utf8");
  } catch (err) {
    console.error(`Error reading raw file ${rawPath}: ${err.message}`);
    process.exit(1);
  }

  if (values["raw-json-file"]) {
    try {
      handoff.raw_json = JSON.parse(content);
    } catch {
      // Never fail the run over a malformed transcript — keep the bytes as text.
      console.warn(`WARNING: ${rawPath} is not valid JSON. Falling back to raw_text.`);
      handoff.raw_text = content;
    }
  } else {
    handoff.raw_text = content;
  }

  try {
    mkdirSync(dirname(values.out), { recursive: true });
    writeFileSync(values.out, JSON.stringify(handoff, null, 2) + "\n", "utf8");
  } catch (err) {
    console.error(`Error writing output file: ${err.message}`);
    process.exit(1);
  }
}

try {
  run();
} catch (err) {
  console.error(`Unhandled error: ${err.message}`);
  process.exit(1);
}
