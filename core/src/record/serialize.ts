import { createHash } from "node:crypto";
import type {
  RunRecord,
  ScenarioProfile,
  Trigger,
  Trajectory,
  CiResult,
  DeployResult,
  OracleScore,
  OracleSignal,
  Verdict,
  PhaseTimings
} from "../types.js";

export const RECORD_VERSION = "1.0.0";
export const RECORD_KIND = "run-record";

export interface DiskTrigger {
  source: string;
  alert_name: string;
  severity?: string;
  labels: Readonly<Record<string, string>>;
  annotations: Readonly<Record<string, string>>;
  fired_at: string;
  /** The alert the run was actually kicked off on (#107); absent when unknown. */
  kickoff_alert?: string;
  signals?: readonly {
    alert_name: string;
    severity?: string;
    labels: Readonly<Record<string, string>>;
    annotations: Readonly<Record<string, string>>;
    fired_at: string;
  }[];
}

export interface DiskTrajectory {
  agent_name: string;
  transcript?: string;
  diff: string;
  submitted: boolean;
  duration_ms: number;
}

export interface DiskCiResult {
  green: boolean;
  output: string;
  exit_code?: number;
  duration_ms: number;
}

export interface DiskDeployResult {
  redeployed: boolean;
  service: string;
  duration_ms: number;
}

export interface DiskOracleSignal {
  id: string;
  satisfied: boolean;
  value: number;
  weight: number;
  detail: string;
}

export interface DiskOracleScore {
  oracle_id: string;
  score: number;
  passed: boolean;
  signals: readonly DiskOracleSignal[];
  sub_scores?: readonly DiskOracleScore[];
}

export interface DiskRunRecord {
  record_version: string;
  kind: string;
  run_id: string;
  scenario_id: string;
  profile: ScenarioProfile;
  trigger: DiskTrigger;
  trajectory: DiskTrajectory;
  diff: string;
  ci: DiskCiResult | null;
  deploy: DiskDeployResult | null;
  score: DiskOracleScore;
  verdict: Verdict;
  timings: PhaseTimings;
  started_at: string;
  finished_at: string;
  agent_transcript?: unknown;
  full_record_sha256?: string;
}

export function toDiskRecord(record: RunRecord, agentTranscript?: unknown): DiskRunRecord {
  return {
    record_version: RECORD_VERSION,
    kind: RECORD_KIND,
    run_id: record.runId,
    scenario_id: record.scenarioId,
    profile: record.profile,
    trigger: {
      source: record.trigger.source,
      alert_name: record.trigger.alertName,
      ...(record.trigger.severity !== undefined ? { severity: record.trigger.severity } : {}),
      labels: record.trigger.labels,
      annotations: record.trigger.annotations,
      fired_at: record.trigger.firedAt,
      ...(record.trigger.kickoffAlert !== undefined ? { kickoff_alert: record.trigger.kickoffAlert } : {}),
      ...(record.trigger.signals
        ? {
            signals: record.trigger.signals.map(s => ({
              alert_name: s.alertName,
              ...(s.severity !== undefined ? { severity: s.severity } : {}),
              labels: s.labels,
              annotations: s.annotations,
              fired_at: s.firedAt,
            })),
          }
        : {}),
    },
    trajectory: {
      agent_name: record.trajectory.agentName,
      ...(record.trajectory.transcript !== undefined ? { transcript: record.trajectory.transcript } : {}),
      diff: record.trajectory.diff,
      submitted: record.trajectory.submitted,
      duration_ms: record.trajectory.durationMs,
    },
    diff: record.diff,
    ci: record.ci ? {
      green: record.ci.green,
      output: record.ci.output,
      ...(record.ci.exitCode !== undefined ? { exit_code: record.ci.exitCode } : {}),
      duration_ms: record.ci.durationMs,
    } : null,
    deploy: record.deploy ? {
      redeployed: record.deploy.redeployed,
      service: record.deploy.service,
      duration_ms: record.deploy.durationMs,
    } : null,
    score: toDiskScore(record.score),
    verdict: record.verdict,
    timings: record.timings,
    started_at: record.startedAt,
    finished_at: record.finishedAt,
    ...(agentTranscript !== undefined ? { agent_transcript: agentTranscript } : {})
  };
}

function toDiskScore(score: OracleScore): DiskOracleScore {
  return {
    oracle_id: score.oracleId,
    score: score.score,
    passed: score.passed,
    signals: score.signals.map(s => ({
      id: s.id,
      satisfied: s.satisfied,
      value: s.value,
      weight: s.weight,
      detail: s.detail,
    })),
    ...(score.subScores ? { sub_scores: score.subScores.map(toDiskScore) } : {})
  };
}

export function fromDiskRecord(disk: DiskRunRecord): RunRecord {
  return {
    runId: disk.run_id,
    scenarioId: disk.scenario_id,
    profile: disk.profile,
    trigger: {
      source: disk.trigger.source,
      alertName: disk.trigger.alert_name,
      ...(disk.trigger.severity !== undefined ? { severity: disk.trigger.severity } : {}),
      labels: disk.trigger.labels,
      annotations: disk.trigger.annotations,
      firedAt: disk.trigger.fired_at,
      ...(disk.trigger.kickoff_alert !== undefined ? { kickoffAlert: disk.trigger.kickoff_alert } : {}),
      ...(disk.trigger.signals
        ? {
            signals: disk.trigger.signals.map(s => ({
              alertName: s.alert_name,
              ...(s.severity !== undefined ? { severity: s.severity } : {}),
              labels: s.labels,
              annotations: s.annotations,
              firedAt: s.fired_at,
            })),
          }
        : {}),
    },
    trajectory: {
      agentName: disk.trajectory.agent_name,
      transcript: disk.trajectory.transcript ?? "",
      diff: disk.trajectory.diff,
      submitted: disk.trajectory.submitted,
      durationMs: disk.trajectory.duration_ms,
    },
    diff: disk.diff,
    ci: disk.ci ? {
      green: disk.ci.green,
      output: disk.ci.output,
      ...(disk.ci.exit_code !== undefined ? { exitCode: disk.ci.exit_code } : {}),
      durationMs: disk.ci.duration_ms,
    } : null,
    deploy: disk.deploy ? {
      redeployed: disk.deploy.redeployed,
      service: disk.deploy.service,
      durationMs: disk.deploy.duration_ms,
    } : null,
    score: fromDiskScore(disk.score),
    verdict: disk.verdict,
    timings: disk.timings,
    startedAt: disk.started_at,
    finishedAt: disk.finished_at,
  };
}

function fromDiskScore(disk: DiskOracleScore): OracleScore {
  return {
    oracleId: disk.oracle_id,
    score: disk.score,
    passed: disk.passed,
    signals: disk.signals.map(s => ({
      id: s.id,
      satisfied: s.satisfied,
      value: s.value,
      weight: s.weight,
      detail: s.detail,
    })),
    ...(disk.sub_scores ? { subScores: disk.sub_scores.map(fromDiskScore) } : {})
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      result[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

export function serializeDiskRecord(disk: DiskRunRecord): string {
  return JSON.stringify(canonicalize(disk), null, 2) + "\n";
}

export function pruneDiskRecord(full: DiskRunRecord): DiskRunRecord {
  const bytes = serializeDiskRecord(full);
  const sha = createHash("sha256").update(bytes).digest("hex");
  
  const pruned: DiskRunRecord = { ...full };
  if (full.agent_transcript && typeof full.agent_transcript === "object" && !Array.isArray(full.agent_transcript)) {
    const at = full.agent_transcript as Record<string, unknown>;
    const keys = ["schema_version", "run_id", "harness", "session", "confinement", "captured_at", "model", "provider", "submitted"];
    const header: Record<string, unknown> = {};
    for (const k of keys) {
      if (k in at) {
        header[k] = at[k];
      }
    }
    pruned.agent_transcript = header;
  } else {
    delete pruned.agent_transcript;
  }
  pruned.trajectory = { ...full.trajectory };
  delete pruned.trajectory.transcript;
  pruned.full_record_sha256 = sha;
  
  return pruned;
}
