/**
 * @sreforge/core — the domain-agnostic SREForge engine.
 *
 * Public surface for driving one contamination-controlled incident run:
 *   trigger → context → run → deploy → verify → record → cleanup.
 *
 * This package contains NO use-case/stack/scenario logic. Those
 * live under `use-cases/` and wire the engine via the interfaces re-exported
 * here.
 */

// ---- Shared types ---------------------------------------------------------
export type {
  AgentContext,
  CiResult,
  DeployResult,
  MergeResult,
  MitigationCriteria,
  OracleScore,
  OracleSignal,
  PhaseTimings,
  RunPhase,
  RunRecord,
  RunWorkspace,
  ScenarioProfile,
  ServiceEndpoints,
  SreforgeConfig,
  Trajectory,
  Trigger,
  Verdict,
} from "./types.js";

// ---- Orchestration --------------------------------------------------------
export { Conductor, runIncident } from "./conductor.js";
export type { ConductorDeps, IncidentResult } from "./conductor.js";

// ---- Triggers -------------------------------------------------------------
export type { TriggerSource } from "./triggers/index.js";
export { PrometheusAlertTrigger } from "./triggers/index.js";
export type { PrometheusAlertTriggerOptions } from "./triggers/index.js";

// ---- Context (the t=0 incident page) --------------------------------------
export { IncidentPageRenderer } from "./context/index.js";
export type { AgentBrief } from "./context/index.js";
// The t=0 bundle + the one kickoff wording every agent driver renders.
export {
  assembleT0Bundle,
  assertSymptomLevel,
  buildKickoffPrompt,
  orderSignalsForKickoff,
  renderT0Bundle,
} from "./context/index.js";
export type {
  AssembleT0BundleOptions,
  KickoffPromptInput,
  SlackTriageMessage,
  T0Bundle,
} from "./context/index.js";

// ---- Runner ---------------------------------------------------------------
export type { AgentRunner } from "./runner/index.js";
export {
  ExternalAgentRunner,
  NoopAgentRunner,
  ReferenceFixRunner,
} from "./runner/index.js";
export type { ExternalAgentRunnerOptions } from "./runner/index.js";
export type { ReferenceFixRunnerOptions } from "./runner/index.js";

// ---- Deploy ---------------------------------------------------------------
export type { AutoMerge, CdDeployer, CiGate } from "./deploy/index.js";
export {
  ComposeCdDeployer,
  GiteaAutoMerge,
  GiteaCiGate,
  GiteaClient,
} from "./deploy/index.js";
export type {
  CiRunStatus,
  ComposeCdDeployerOptions,
  GiteaAutoMergeOptions,
  GiteaCiGateOptions,
  GiteaClientOptions,
  PullRequestRef,
} from "./deploy/index.js";

// ---- Verify ---------------------------------------------------------------
export type { Oracle, OracleContext } from "./verify/index.js";
export {
  CompoundedOracle,
  MitigationOracle,
  PrometheusAlertProbe,
} from "./verify/index.js";
export type {
  AlertProbe,
  FiringAlert,
  MitigationOracleOptions,
  PrometheusAlertProbeOptions,
  WeightedOracle,
} from "./verify/index.js";

// ---- Record ---------------------------------------------------------------
export type { RunRecorder } from "./record/index.js";
export {
  FileRunRecorder,
  RECORD_VERSION,
  RECORD_KIND,
  toDiskRecord,
  fromDiskRecord,
  serializeDiskRecord,
  pruneDiskRecord,
} from "./record/index.js";
export type {
  FileRunRecorderOptions,
  DiskRunRecord,
  DiskTrigger,
  DiskTrajectory,
  DiskCiResult,
  DiskDeployResult,
  DiskOracleSignal,
  DiskOracleScore,
} from "./record/index.js";

// ---- Cleanup --------------------------------------------------------------
export type { Cleanup } from "./cleanup/index.js";
export { ComposeCleanup } from "./cleanup/index.js";
export type { ComposeCleanupOptions } from "./cleanup/index.js";
