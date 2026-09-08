# `tools/transcript` — Agent handoff capture

Provides the driver-facing contract for handing off agent-side artifacts (like conversation transcripts or RCAs) to the SREForge engine. Because drivers run outside the sealed engine environment, they write to a shared mount; this script packages the raw data into standard envelopes (`agent-transcript.v1`, `agent-rca.v1`).

## Files

| Path | What |
| --- | --- |
| `write-handoff.mjs` | Packages raw text or JSON into a standard schema envelope. |

## Usage

External drivers (like t3code or `agent-agy.sh`) call this script after the agent completes its run, just before or after `submit`:

```sh
node tools/transcript/write-handoff.mjs \
  --run-id "<run-id>" \
  --harness "<harness-name>" \
  --session "cold" \
  --confinement "host-open" \
  --kind "transcript" \
  --raw-text-file "/path/to/raw.txt" \
  --out ".run-workspace/agent-transcript.json"

# RCA handoff
node tools/transcript/write-handoff.mjs \
  --run-id "<run-id>" \
  --harness "<harness-name>" \
  --session "cold" \
  --confinement "host-open" \
  --kind "rca" \
  --raw-text-file "/path/to/rca.txt" \
  --out ".run-workspace/agent-rca.json"
```

`--confinement` is required and must be one of `host-open` | `host-sandboxed` | `in-box` — the tier the driver actually ran the agent under. It is a fixed property of the driver, hardcoded per driver, never an env var; an unlabelled handoff is refused so a verdict is never banked with unknown measurement conditions.

`--preflight <ok>` stamps `"preflight": "ok"` in the handoff envelope; any other value or omission stamps `"skipped"`. When `SREFORGE_EXPECTED_HARNESS` is present in the environment, this script asserts it matches `--harness` and refuses to write a mislabelled record on mismatch.

That refusal is enforced at **two** points, because every driver deliberately swallows a handoff failure (ADR-0004 best-effort), so a driver that never calls this script at all would otherwise sail past the guard here:

1. **Write end — this script.** A missing, empty or out-of-enum `--confinement` exits 1; no handoff file is produced.
2. **Bank end — `tools/record/bank.mjs` (#124).** A *new* full record whose `agent_transcript.confinement` is absent or out-of-enum is refused rather than banked, as is a verdict-bearing record with no `agent_transcript` header at all — the latter only while the record is still untracked, since a git-tracked record is one this repo has already accepted. Already-banked records are grandfathered; `--allow-unlabelled` is the deliberate operator override.

The enum itself lives once, in `tools/record/confinement.mjs`, and is pinned against this script's validation guard by `tools/record/test/confinement-tiers-crosscheck.test.mjs` — this script is a CLI that runs on import, so the constant cannot be shared by importing it.

The engine's `FileRunRecorder` automatically ingests these files from the `.run-workspace` directory and bundles them into the final `run-record.v1` artifact set.
