---
title: Run contract
description: What a scenario's setup emits and what the engine consumes per run.
sidebar:
  order: 4
---

This is the internal boundary between **scenario setup** and the engine's
`runner` / `verify` / `record`. SREForge *is* the engine (`core/`), so this is not
a contract with an external framework — it's the shape setup hands the engine each
run. The example uses `booklogr`.

## The shape setup emits

```json
{
  "agent_context": {
    "services": {
      "prometheus":   "http://prometheus:9090",
      "alertmanager": "http://alertmanager:9093",
      "grafana":      "http://grafana:3000",
      "api":          "http://booklogr-api:5000"
    },
    "run_workspace": {
      "path":    "/work/run/<run-id>/booklogr",
      "service": "booklogr-api"
    },
    "workspace_path": "/workspace",
    "submit_command": "submit"
  },
  "scenario": {
    "id":             "latency-cache-stampede",
    "profile":        "incident",
    "run_id":         "<run-id>",
    "expected_alert": "BooklogrApiLatencyP99High",
    "alert_fired_at": "<ISO timestamp — set by the confirm-fire gate>"
  },
  "eval_only": {
    "alert_to_clear":          "BooklogrApiLatencyP99High",
    "max_clear_time_seconds":  600,
    "sustained_clear_seconds": 360
  }
}
```

:::note[The endpoints are the *agent's* view — in-network DNS]
`agent_context.services` are **service-DNS** URLs reachable on the deployment
network, **not** host ports. The engine itself probes the same services from
*outside* the network on their host-published ports — so the addresses differ:

| Service | Agent (in-network) | Operator (host) |
|---|---|---|
| Prometheus | `http://prometheus:9090` | `http://localhost:9090` |
| Alertmanager | `http://alertmanager:9093` | `http://localhost:9093` |
| Grafana | `http://grafana:3000` | `http://localhost:3002` |
| booklogr API | `http://booklogr-api:5000` | `http://localhost:5000` |

There is **deliberately no `loki`** (or any log-store) endpoint: this stack's
observability is Prometheus + Alertmanager + Grafana, and advertising a service
that doesn't exist would itself be a tell.
:::

## The three sections

### `agent_context` — what the agent receives

Rendered into a neutral on-call **page** (not a curated brief). The
**`run_workspace.path`** is the host-side substrate clone the engine operates on
(CI replay, redeploy, cleanup); the agent sees its own mount at
**`workspace_path`** (default `/workspace`) and edits the source in place, then
runs **`submit_command`** when done. There is no `fork_repo`, no PAT, and no
github.com in v1. The agent never merges or deploys.

:::caution[The page does not name the firing alert]
`scenario.expected_alert` is **engine-internal metadata** for the run record — it
is **not** rendered into the agent's page. The agent reads the firing alerts off
Alertmanager itself, the way a real on-call would. Pre-digesting the alert would
both spoon-feed the diagnosis and read like a benchmark prompt. (This matters for
anyone wiring an agent in: do not expect the alert name/summary in the page —
discover it from the alerting stack.)
:::

### `scenario` — run metadata

`id` identifies the target scenario (defaults to `latency-cache-stampede`). `SCENARIO_ID` propagation accepts values via environment variable (`SCENARIO_ID=<id>`) or trailing task argument (`SCENARIO_ID=<id>`) on scenario-aware verbs, threading the ID to smoke and arm scripts. Invalid scenario slugs (not matching `/^[a-z0-9][a-z0-9-]*$/`) are rejected before script execution.

`profile` is `incident` or `patch`. **`alert_fired_at`** is populated by the
**confirm-fire gate**: setup injects the fault and confirms the alert fired
*before* the run is handed to the agent; if it never fires, the run aborts or
retries.

### `eval_only` — scoring inputs, never exposed to the agent

The oracle's inputs. `sustained_clear_seconds` enforces the sustained-clear check.

:::caution[No diff expectations]
There is deliberately **no** `expected_diff_contains` or `expected_files_touched`.
Verification is behavioural; diffs are at most non-blocking hints.
:::

## How a fix is graded (incident profile)

```
submit → CI gate (build + existing tests)
       → green → auto-merge → CD-on-merge redeploy of run_workspace.service
       → mitigation oracle scores, under still-active fault:
           CI green + alert_to_clear clears and stays cleared (sustained_clear_seconds)
           + no new alerts + time-to-clear
```

Multi-signal and fully objective. The RCA channel (`submit --rca`) is reported alongside the record; the RCA LLM-judge arrives in a later version.

## What a run records (outputs)

Each run produces an artifact set in **`runs/<runId>/`**:
- `record.json`: The immutable **`run-record.v1`** (canonical snake_case schema `tools/certify/schemas/run-record.v1.schema.json`; camelCase `RunRecord` is merely the in-memory TS type).
- `diff.patch`: The patch applied by the agent.
- `transcript.txt`: The engine runner's log.
- `agent-transcript.json`: The agent-provided conversation trace.
- `rca.json` / `rca.txt`: The agent's root cause analysis, if provided.
- `diagnosis.json`: The **`diagnosis.v1`** RCA-judge result, if the [RCA judge](../../concepts/closed-loop-verification/) has graded the run's `rca.txt` against the scenario's authored root-cause truth. Reported *beside* the verdict — its score never feeds `record.json` or the pass decision. Absent is a normal state (no RCA, judge not run, or judge unreachable). Written by `tools/rca-judge/judge.mjs`; never written into or read from `record.json`.

The engine also captures the record into persistent storage via a split (ADR-0026):
- **Pruned record**: The `record.json` stripped of `trajectory.transcript` and the raw payload (`raw_text`/`raw_json`) of `agent_transcript`, but retaining `agent_transcript`'s identity header (`harness`, `model`, `provider`, `session`, `confinement`, `run_id`, `captured_at`) plus a `full_record_sha256` reference, is committed to `use-cases/<uc>/scenarios/<id>/records/<runId>.json`.
- **Full record**: The complete run state is archived in a content-addressed private store seam.
- **Headroom campaign runs**: `tools/headroom` campaign run-ids and their records land in these exact same existing paths (`runs/<runId>/record.json` and pruned copies); the campaign records nothing new.

The `run-record.v1` schema fields include:

| Field | Meaning |
|---|---|
| `run_id`, `scenario_id`, `profile` | Run + scenario identity |
| `trigger` | The firing alert that opened the run (`source`, `alert_name`, `severity`, `labels`, `annotations`, `fired_at`, `signals`, `kickoff_alert`) |
| `trigger.kickoff_alert` | Optional. The alert the agent was actually paged on at t=0: the scenario's expected alert when it was among the delivered notifications, otherwise the first notification that arrived. Written by the automated cycle; absent (not `null`) when the run had no alert push to observe |
| `trajectory` | What the agent produced: `agent_name`, `diff`, `submitted`, `duration_ms` |
| `agent_transcript` | Harness-sourced transcript metadata (`harness`, `model`, `provider`, `session`, `confinement`: `host-open` \| `host-sandboxed` \| `in-box`, `captured_at`) |
| `ci`, `deploy` | CI-gate result and the redeploy result (`null` if not reached) |
| `score` | The oracle's `oracle_score` (see below) |
| `verdict` | `"passed"` \| `"failed"` \| `"rejected"` \| `"aborted"` \| `"error"` |
| `timings`, `started_at`, `finished_at` | Per-phase timings and ISO bounds |

The **`oracle_score`** is the graded result the verdict derives from:

```json
{
  "oracle_id": "mitigation",
  "score": 0.93,
  "passed": true,
  "signals": [
    { "id": "ci_green",      "satisfied": true, "value": 1, "weight": 0.25, "detail": "…" },
    { "id": "alert_cleared", "satisfied": true, "value": 1, "weight": 0.35, "detail": "…" }
  ],
  "sub_scores": []
}
```

`passed` is `score >= pass_threshold` (`0.85` for this scenario). For a
[compound oracle](../../concepts/closed-loop-verification/), `sub_scores` carries
the per-phase scores (detect / diagnose / mitigate).

## The `patch` profile variant

For `profile: "patch"`, `scenario` carries a pinned `base_commit` and `verify/` is
a hidden test suite run against the agent's patch. There is no live deployment, no
alert, and no `run_workspace` deploy step.

## Forward-compatibility

Additive-only within v1.x: new fields are fine; no rename or removal without a
`contract_version` bump. The engine ignores unknown fields.

## See also

- [Scenario format](../scenario-format/) — the authored side of this contract.
- [Closed-loop verification](../../concepts/closed-loop-verification/) — how the
  oracle uses `eval_only`.
