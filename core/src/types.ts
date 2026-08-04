/**
 * Shared domain-agnostic types for the SREForge engine.
 *
 * These types are the spine of the closed-loop incident run:
 *   trigger → context → run → deploy → verify → record → cleanup.
 *
 * Nothing here may reference a concrete use-case, stack, or scenario.
 * The engine is domain-agnostic by construction.
 */

// ---------------------------------------------------------------------------
// Profiles & verdicts
// ---------------------------------------------------------------------------

/**
 * Scenario profile.
 * - `incident`: programmatic Problem/Oracle closed loop (the only v1 profile).
 * - `patch`: declarative folder + hidden tests + reference solution (deferred).
 */
export type ScenarioProfile = "incident" | "patch";

/**
 * Final, human-readable verdict for a run. Derived from the oracle score and
 * the deploy outcome; the numeric score remains the source of truth.
 */
export type Verdict =
  | "passed" // fix deployed, alert cleared and stayed cleared
  | "failed" // fix deployed but the behavioral oracle was not satisfied
  | "rejected" // CI gate was red; the fix never deployed
  | "aborted" // run could not start / produce a gradeable result
  | "error"; // engine-internal failure

/**
 * Lifecycle phase identifiers, used for structured timing and logging.
 * Ordered to match the run lifecycle.
 */
export type RunPhase =
  | "trigger"
  | "context"
  | "run"
  | "ci"
  | "merge"
  | "redeploy"
  | "verify"
  | "record"
  | "cleanup";

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

/**
 * A single correlated alert signal contributing to a multi-alert trigger.
 */
export interface TriggerSignal {
  alertName: string;
  severity?: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  firedAt: string; // ISO8601
}

/**
 * A normalized event that opens an incident run. In v1 this is produced from a
 * firing Prometheus alert; in v2 it generalizes to a multi-signal trigger bus.
 */
export interface Trigger {
  /** Stable identifier of the trigger kind, e.g. `"prometheus-alert"`. */
  readonly source: string;
  /** The firing alert's name, e.g. `"ApiLatencyP99High"`. */
  readonly alertName: string;
  /** Alert severity as reported by the source, if any. */
  readonly severity?: string;
  /** Alertmanager/Prometheus labels attached to the firing alert. */
  readonly labels: Readonly<Record<string, string>>;
  /** Alertmanager/Prometheus annotations (summary, description, …). */
  readonly annotations: Readonly<Record<string, string>>;
  /** When the alert started firing (ISO-8601). Set by the confirm-fire gate. */
  readonly firedAt: string;
  /**
   * Optional correlated signals for a multi-alert trigger bus. When present,
   * signals[0] is the primary and the scalar fields above mirror it.
   */
  readonly signals?: readonly TriggerSignal[];
  /**
   * The alert the agent was actually kicked off on — its t=0 headline (#107).
   * Normally the scenario's declared alert; the first arrival when that alert
   * was not among the ones delivered. Absent (never null) when the kickoff was
   * not observed, e.g. an engine-only run with no webhook push.
   */
  readonly kickoffAlert?: string;
}

// ---------------------------------------------------------------------------
// Agent context (the run contract emitted by scenario setup)
// ---------------------------------------------------------------------------

/**
 * Documented endpoints the agent may reach on the deployment network, plus the
 * env var that names the database connection string. Mirrors the
 * `agent_context.services` block of the run contract. Open-ended on purpose:
 * the engine does not hard-code a service catalog.
 */
export interface ServiceEndpoints {
  readonly prometheus: string;
  readonly alertmanager: string;
  readonly grafana: string;
  /** Optional, stack-dependent endpoints (api, ui, loki, …). */
  readonly [service: string]: string | undefined;
}

/**
 * The run workspace: a per-run clone of the substrate the agent edits in place.
 * Mirrors `agent_context.run_workspace`.
 */
export interface RunWorkspace {
  /** Absolute path to the cloned substrate the agent edits. */
  readonly path: string;
  /** Name of the service whose redeploy is gated on a merged fix. */
  readonly service: string;
}

/**
 * Everything the agent is handed at t=0. Honest, neutral framing — it never
 * mentions a harness or an evaluation. Mirrors `agent_context`.
 */
export interface AgentContext {
  /**
   * Reachable, documented endpoints on the deployment network. These are the
   * AGENT's view: in-network service DNS (e.g. `http://alertmanager:9093`), not
   * the host-published ports the engine itself probes from outside the network.
   */
  readonly services: ServiceEndpoints;
  /** The per-run substrate clone the agent edits. */
  readonly runWorkspace: RunWorkspace;
  /**
   * Agent-facing path where the service source is mounted inside the sandbox.
   * Distinct from {@link RunWorkspace.path}, which is the host-side substrate the
   * engine operates on (CI replay / redeploy / cleanup). Kept separate so the
   * brief shows the agent its own working directory and never leaks a host path.
   * Defaults to `/workspace` when omitted.
   */
  readonly workspacePath?: string;
  /**
   * The command the agent invokes to submit its fix (fix-only in v1). The agent
   * never merges or deploys; submission hands control back to the engine.
   */
  readonly submitCommand: string;
}

// ---------------------------------------------------------------------------
// Trajectory (what the runner collects from the agent)
// ---------------------------------------------------------------------------

/**
 * The agent's produced fix plus its transcript. The diff is the load-bearing
 * artifact; the transcript is retained for verifier self-audit.
 */
export interface Trajectory {
  /** Registry name of the agent/meta-harness that ran, e.g. `"t3code"`. */
  readonly agentName: string;
  /** Raw harness transcript (opaque to the engine; kept for audit). */
  readonly transcript: string;
  /** Unified `git diff` of the agent's edits to the run workspace. */
  readonly diff: string;
  /** Whether the agent explicitly called `submit`. */
  readonly submitted: boolean;
  /** Wall-clock duration the agent was active, in milliseconds. */
  readonly durationMs: number;
}

// ---------------------------------------------------------------------------
// Deploy (CI gate → auto-merge → CD redeploy)
// ---------------------------------------------------------------------------

/**
 * Result of the CI gate (build + existing tests) run against the run workspace.
 * Red here means the fix never deploys and the alert persists.
 */
export interface CiResult {
  /** Build + existing tests all passed. */
  readonly green: boolean;
  /** Combined build/test output, surfaced to the agent as feedback on red. */
  readonly output: string;
  /** Exit code of the gate process, when one is available. */
  readonly exitCode?: number;
  readonly durationMs: number;
}

/** Result of committing a green fix to the run workspace (auto-merge step). */
export interface MergeResult {
  readonly merged: boolean;
  /** Commit SHA produced by the auto-merge, when available. */
  readonly commit?: string;
}

/** Result of the CD redeploy (compose rebuild + swap) of a single service. */
export interface DeployResult {
  /** The new image/container is up and reporting ready. */
  readonly redeployed: boolean;
  /** The service that was redeployed. */
  readonly service: string;
  readonly durationMs: number;
}

// ---------------------------------------------------------------------------
// Verify (oracle scores)
// ---------------------------------------------------------------------------

/**
 * A single objective signal contributing to an oracle's score. v1 signals are
 * fully objective (no LLM): CI green, alert cleared, sustained-clear, etc.
 */
export interface OracleSignal {
  /** Stable signal id, e.g. `"alert_cleared"`, `"sustained_clear"`. */
  readonly id: string;
  /** Whether the signal was satisfied. */
  readonly satisfied: boolean;
  /** Normalized contribution in [0, 1] (partial credit allowed). */
  readonly value: number;
  /** Relative weight of this signal within its oracle. */
  readonly weight: number;
  /** Human-readable explanation for audit. */
  readonly detail: string;
}

/**
 * The score produced by an oracle (or a composition of oracles). Normalized to
 * [0, 1]; `passed` is the boolean threshold decision.
 */
export interface OracleScore {
  /** Oracle id, e.g. `"mitigation"`, `"compounded"`. */
  readonly oracleId: string;
  /** Aggregate score in [0, 1]. */
  readonly score: number;
  /** Whether the score clears this oracle's pass threshold. */
  readonly passed: boolean;
  /** The signals (or sub-oracle scores) that produced this score. */
  readonly signals: readonly OracleSignal[];
  /** Optional nested sub-oracle scores for a CompoundedOracle. */
  readonly subScores?: readonly OracleScore[];
}

// ---------------------------------------------------------------------------
// Record (persisted run artifact)
// ---------------------------------------------------------------------------

/** Per-phase timing, in milliseconds, keyed by lifecycle phase. */
export type PhaseTimings = Readonly<Partial<Record<RunPhase, number>>>;

/**
 * The complete, persisted record of one run. Written to a run directory for
 * verifier self-audit and the leaderboard.
 */
export interface RunRecord {
  readonly runId: string;
  readonly scenarioId: string;
  readonly profile: ScenarioProfile;
  readonly trigger: Trigger;
  readonly trajectory: Trajectory;
  /** The graded diff (mirrors `trajectory.diff`; kept at top level for audit). */
  readonly diff: string;
  readonly ci: CiResult | null;
  readonly deploy: DeployResult | null;
  readonly score: OracleScore;
  readonly verdict: Verdict;
  readonly timings: PhaseTimings;
  /** ISO-8601 timestamps bounding the run. */
  readonly startedAt: string;
  readonly finishedAt: string;
}

// ---------------------------------------------------------------------------
// Engine configuration
// ---------------------------------------------------------------------------

/**
 * The `eval_only` block of the run contract: never shown to the agent. Drives
 * the mitigation oracle's behavioral verification.
 */
export interface MitigationCriteria {
  /** Alert that must clear and stay cleared for a pass. */
  readonly alertToClear: string;
  /** Upper bound on time-to-clear, in seconds. */
  readonly maxClearTimeSeconds: number;
  /** How long the alert must stay cleared to count as mitigated. */
  readonly sustainedClearSeconds: number;
  /**
   * Services whose firing alerts count toward the `no_new_alerts` regression
   * signal. When set, an alert is a regression only if its `service` label is in
   * this set. When omitted, the signal is unscoped (every non-target firing alert
   * counts) — the legacy behavior. The booklogr harness always supplies this,
   * defaulting to the primary (redeployed) service.
   */
  readonly inScopeServices?: readonly string[];
}

/**
 * Everything the engine needs to drive one incident run. Assembled by scenario
 * setup; the engine treats it as immutable input.
 */
export interface SreforgeConfig {
  readonly runId: string;
  readonly scenarioId: string;
  readonly profile: ScenarioProfile;
  /** The expected firing alert that opens the run. */
  readonly expectedAlert: string;
  /** Context handed to the agent at t=0. */
  readonly agentContext: AgentContext;
  /** Hidden grading criteria for the mitigation oracle. */
  readonly mitigation: MitigationCriteria;
  /** Absolute path to the directory where the RunRecord is persisted. */
  readonly recordDir: string;
}
