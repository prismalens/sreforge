# rca-judge

An **LLM-as-judge** that grades an agent-written RCA (root-cause analysis /
postmortem) against a scenario's **authored root-cause truth**, producing a
bounded, reproducible score banked to `runs/<runId>/diagnosis.json`.

This is the **descoped #56**: it grades the *whole* RCA once, against a *single*
rubric on **three axes**. Per-fact grading, alias classes, and
required/forbidden-fact lists are deferred. The score is **reported beside the
verdict, never inside it** — it does not gate anything, does not touch
`record.json`, and is not a `[verify.weights]` signal (ADR-0027).

It is the diagnosis-side counterpart to [`../detell-judge`](../detell-judge/README.md):
same prompt-first, model-agnostic, no-heavyweight-deps shape.

## The three axes

The judge returns a strict JSON verdict — **only booleans + a rationale**. All
arithmetic happens in harness code (ADR-0027: no arithmetic in the judge).

| Axis | Meaning | Weight |
|---|---|---|
| `root_cause_correct` | RCA identifies the authored root-cause *mechanism*, not just the symptomatic component | 0.5 |
| `evidence_grounded` | Claims are tied to observable evidence (metrics, config, logs, commits) rather than asserted | 0.3 |
| `false_leads` | RCA blames something the authored truth rules out (**`true` is BAD** — a false lead) | 0.2 (scored inverted) |

`score = 0.5·root_cause_correct + 0.3·evidence_grounded + 0.2·(!false_leads)`,
in `[0,1]`. Weights live as the `WEIGHTS` const in `judge.mjs` and sum to 1.

## Modes

```bash
# --prepare: assemble the filled judge prompt → <out>/judge-input.md. No model
#            call, no API cost. Run it in any model, save its JSON verdict.
node tools/rca-judge/judge.mjs --prepare --run-dir runs/<runId> --scenario <scenario-dir>
node tools/rca-judge/judge.mjs --prepare --rca-file <path> --scenario <scenario-dir> --out <dir>

# --grade: parse an externally-produced verdict JSON + apply the deterministic
#          scoring. No model call, no API cost. Writes/prints diagnosis.json.
node tools/rca-judge/judge.mjs --grade <verdict.json> --out <dir> --run-id <id> --scenario-id <id>

# --judge: end-to-end — assemble, call the pinned model, parse (retry up to 3×),
#          grade, write diagnosis.json. Requires RCA_JUDGE_MODEL.
node tools/rca-judge/judge.mjs --judge --run-dir runs/<runId> --scenario <scenario-dir>

pnpm judge:rca --judge ...   # same, via the package script
```

### No API cost in `--prepare` / `--grade`

Like detell-judge, `--prepare` and `--grade` **never call a model** — they are
cheap local operations (assemble a prompt; score a verdict). Only `--judge`
invokes the model. This keeps the deterministic scoring path free and lets a
human or a separate agent run the prompt anywhere.

## Inputs

**RCA text** (priority order):
- `--run-dir <runs/<runId>>` — reads `<dir>/rca.txt`, falls back to `rca.json`'s
  `raw_text` (the banked `agent-rca.v1` envelope).
- `--rca-file <path>` — reads the RCA text directly, no run dir.

**Ground truth**: `--scenario <scenario-dir>` — reads the
`## Root cause (harness-internal)` section of `<dir>/verify/oracle.md`. Missing
section → clear error. This section is **harness-internal**: nothing from it may
reach an agent-reachable surface.

**Output dir**: `--run-dir` if given, else `--out`. `diagnosis.json` lands there.
`--run-id` / `--scenario-id` override the ids derived from the directory names.

## Stability contract

This CLI surface is the contract prismalens (`ScoringOracle`) depends on:

```bash
node tools/rca-judge/judge.mjs --judge --rca-file <path> --scenario <scenario-dir> --out <dir>
```

- **Consumer-facing surface**: `judge.mjs --judge` with `--scenario <dir>`, either `--run-dir` or `--rca-file`, optional `--out`, and required `RCA_JUDGE_MODEL`.
- **Oracle layout**: Ground truth is resolved strictly at `<scenario>/verify/oracle.md` under `## Root cause (harness-internal)`. That layout is part of the contract.
- **Exit codes**:
  - `exit 2`: Contract violation (bad flags, missing/malformed oracle, unpinned model).
  - `exit 0`: Success (writes `diagnosis.json`), or best-effort model unreachable / timeout / unparseable output (writes no diagnosis; absent score is normal).
- **Output shape**: Writes `diagnosis.json` with `schema_version: "diagnosis.v1"`.
- **Breaking changes**: `tools/rca-judge/test/contract.test.mjs` is the gate. Any change to flags, oracle resolution, exit codes, or schema version breaks prismalens.

## Env vars

| Var | Mode | Meaning |
|---|---|---|
| `RCA_JUDGE_MODEL` | `--judge` | **Required** — pins the judge model id. No silent default (a drifting default would silently change scores). Must be a **non-Claude** model (ADR-0027 §14): no Anthropic client is wired. |
| `OLLAMA_HOST` | `--judge` | Judge endpoint, default `https://ollama.com`. Model call is a plain `POST /api/chat` (same pattern as the booklogr agent-ollama driver). |
| `OLLAMA_API_KEY` | `--judge` | Bearer token for Ollama Cloud, if the endpoint needs it. |

## Behaviour & invariants (ADR-0027)

- **Best-effort, never fatal (`--judge`).** Judge unreachable / timeout / parse
  failure after 3 retries → log loudly to stderr, **write nothing**, exit `0`. An
  absent `diagnosis.json` is a normal state. (`--prepare` / `--grade` input errors
  — missing files, bad JSON — may exit non-zero.)
- **Re-judging is idempotent-by-overwrite.** Running `--judge` again replaces
  `diagnosis.json` — that is how a rubric revision rolls out over a banked corpus.
- **Never mutates `record.json`** (content-addressed; certification linkage).
- **`rubric_version` + `judge_model` are always stamped.**
- **Reported, never gating.** Does not touch verdict computation, the live
  `[verify.weights]`, or `OracleScore`/`OracleSignal`.
- **Independence.** Run the judge with a **different model than the one under
  test** (a model can be soft on its own family's output).

## Tests

```bash
pnpm test:rca-judge   # node --test tools/rca-judge/test/*.test.mjs
```

No model calls in the tests: the model call is an injected function
(`runJudge({ callModel })`) that tests stub, and scoring is covered via `--grade`
on fixture verdicts. The decoy false-lead fixture exercises the `false_leads`
polarity in scoring (the LLM decision itself is not unit-testable).
