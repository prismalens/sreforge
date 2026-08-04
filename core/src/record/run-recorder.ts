import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

import type { RunRecord } from "../types.js";
import type { RunRecorder } from "./index.js";
import { toDiskRecord, serializeDiskRecord, pruneDiskRecord } from "./serialize.js";

/** Configuration for a {@link FileRunRecorder}. */
export interface FileRunRecorderOptions {
  /** Base directory under which per-run directories are created. */
  readonly baseDir: string;
  /** Optional path to the raw transcript handoff from the agent harness. */
  readonly transcriptHandoffPath?: string;
  /** Optional/best-effort path to an RCA handoff to ingest (writes rca.json/rca.txt). */
  readonly rcaHandoffPath?: string;
  /**
   * Optional/best-effort path to the kickoff handoff (`agent-kickoff.v1`) the
   * automation drops when it launches the agent. Its `kickoff_alert` is the
   * alert the agent was actually paged on — knowable at kickoff, not at
   * trigger-poll time — so it reaches the record through this seam (#107).
   */
  readonly kickoffHandoffPath?: string;
  /** Optional/best-effort directory to write pruned JSON records to. */
  readonly prunedRecordDir?: string;
  /** Optional/best-effort directory to write full JSON records keyed by SHA-256 to. */
  readonly fullRecordStoreDir?: string;
}

/**
 * Writes each run to its own directory: `<baseDir>/<runId>/`, containing:
 *   - `record.json`   — the full {@link RunRecord},
 *   - `diff.patch`    — the graded git diff (also embedded in record.json),
 *   - `transcript.txt`— the engine runner's own event log (NOT the agent transcript),
 *   - `agent-transcript.json` — the raw agent output, if captured.
 *   - `rca.json` / `rca.txt` — present when the driver handed off an RCA.
 *
 * The diff and transcript logs are split out as standalone files so auditors can
 * read them without parsing the JSON envelope.
 */
export class FileRunRecorder implements RunRecorder {
  readonly #baseDir: string;
  readonly #handoffPath?: string;
  readonly #rcaHandoffPath?: string;
  readonly #kickoffHandoffPath?: string;
  readonly #prunedRecordDir?: string;
  readonly #fullRecordStoreDir?: string;

  constructor(options: FileRunRecorderOptions) {
    this.#baseDir = options.baseDir;
    this.#handoffPath = options.transcriptHandoffPath;
    this.#rcaHandoffPath = options.rcaHandoffPath;
    this.#kickoffHandoffPath = options.kickoffHandoffPath;
    this.#prunedRecordDir = options.prunedRecordDir;
    this.#fullRecordStoreDir = options.fullRecordStoreDir;
  }

  async record(record: RunRecord): Promise<string> {
    const runDir = join(this.#baseDir, record.runId);
    await mkdir(runDir, { recursive: true });

    let agentTranscript: unknown = undefined;
    const writes = [
      writeFile(join(runDir, "diff.patch"), record.diff, "utf8"),
      writeFile(
        join(runDir, "transcript.txt"),
        record.trajectory.transcript,
        "utf8",
      ),
    ];

    if (this.#handoffPath && existsSync(this.#handoffPath)) {
      try {
        const content = await readFile(this.#handoffPath, "utf8");
        const handoff = JSON.parse(content);
        if (handoff.run_id === record.runId) {
          agentTranscript = handoff;
          writes.push(writeFile(join(runDir, "agent-transcript.json"), content, "utf8"));
        } else {
          const err = `Transcript mismatch: handoff file run_id '${handoff.run_id}' != record runId '${record.runId}'`;
          console.error(`ERROR: ${err}`);
          writes.push(writeFile(join(runDir, "transcript-error.txt"), err + "\n", "utf8"));
        }
      } catch (err: unknown) {
        console.warn(`WARNING: Failed to read or parse transcript handoff at ${this.#handoffPath}:`, err instanceof Error ? err.message : err);
      }
    }

    if (this.#rcaHandoffPath && existsSync(this.#rcaHandoffPath)) {
      try {
        const content = await readFile(this.#rcaHandoffPath, "utf8");
        const handoff = JSON.parse(content);
        if (
          handoff.schema_version !== "agent-rca.v1" ||
          typeof handoff.run_id !== "string" ||
          (handoff.raw_text !== undefined && typeof handoff.raw_text !== "string")
        ) {
          console.warn("WARNING: Invalid RCA handoff envelope, skipping ingest");
        } else if (handoff.run_id === record.runId) {
          writes.push(writeFile(join(runDir, "rca.json"), content, "utf8"));
          if (handoff.raw_text !== undefined) {
            writes.push(writeFile(join(runDir, "rca.txt"), handoff.raw_text, "utf8"));
          }
        } else {
          const err = `RCA mismatch: handoff file run_id '${handoff.run_id}' != record runId '${record.runId}'`;
          console.error(`ERROR: ${err}`);
          writes.push(writeFile(join(runDir, "rca-error.txt"), err + "\n", "utf8"));
        }
      } catch (err: unknown) {
        console.warn(`WARNING: Failed to read or parse RCA handoff at ${this.#rcaHandoffPath}:`, err instanceof Error ? err.message : err);
      }
    }

    // The kickoff alert (#107). Best-effort like every other handoff: a missing
    // or mismatched file costs the audit field, never the graded record.
    let recorded = record;
    if (this.#kickoffHandoffPath && existsSync(this.#kickoffHandoffPath)) {
      try {
        const content = await readFile(this.#kickoffHandoffPath, "utf8");
        const handoff = JSON.parse(content);
        if (
          handoff.schema_version !== "agent-kickoff.v1" ||
          typeof handoff.kickoff_alert !== "string"
        ) {
          console.warn("WARNING: Invalid kickoff handoff envelope, skipping ingest");
        } else if (handoff.run_id === record.runId) {
          recorded = {
            ...record,
            trigger: { ...record.trigger, kickoffAlert: handoff.kickoff_alert },
          };
        } else {
          console.error(
            `ERROR: Kickoff mismatch: handoff file run_id '${handoff.run_id}' != record runId '${record.runId}'`,
          );
        }
      } catch (err: unknown) {
        console.warn(`WARNING: Failed to read or parse kickoff handoff at ${this.#kickoffHandoffPath}:`, err instanceof Error ? err.message : err);
      }
    }

    const full = toDiskRecord(recorded, agentTranscript);
    writes.push(
      writeFile(
        join(runDir, "record.json"),
        serializeDiskRecord(full),
        "utf8"
      )
    );

    if (this.#prunedRecordDir || this.#fullRecordStoreDir) {
      const pruned = pruneDiskRecord(full);
      if (this.#prunedRecordDir) {
        await mkdir(this.#prunedRecordDir, { recursive: true });
        writes.push(
          writeFile(
            join(this.#prunedRecordDir, `${record.runId}.json`),
            serializeDiskRecord(pruned),
            "utf8"
          )
        );
      }
      if (this.#fullRecordStoreDir && pruned.full_record_sha256) {
        await mkdir(this.#fullRecordStoreDir, { recursive: true });
        writes.push(
          writeFile(
            join(this.#fullRecordStoreDir, `${pruned.full_record_sha256}.json`),
            serializeDiskRecord(full),
            "utf8"
          )
        );
      } else if (this.#fullRecordStoreDir) {
        console.warn(`WARNING: Skipped full-record store write for run '${record.runId}' (missing sha256)`);
      }
    }

    await Promise.all(writes);

    return runDir;
  }
}
