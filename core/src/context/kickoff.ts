/**
 * The agent's t=0 kickoff text — one wording, one place.
 *
 * Every driver used to carry its own copy of the same
 * `T0_BUNDLE ?? WEBHOOK_PAYLOAD ?? generic` ternary, so the three copies drifted
 * (#107). The text is SYMPTOM-LEVEL by construction: it hands over the payload
 * the incident host received and nothing else — no alert is singled out, no
 * cause is named, no harness vocabulary appears (ADR-0008/0009 de-tell).
 */

/** Shared instruction tail — identical on every branch. */
const TAIL =
  "Investigate from the alerting stack, find the root cause in the code, " +
  'apply a fix in /workspace, and submit. When you\'ve fixed it, write a brief ' +
  "postmortem — root cause, evidence you used, what you changed — save it to a " +
  "file (e.g. postmortem.md) and include it when you submit: " +
  'submit --rca postmortem.md "one-line summary"';

export interface KickoffPromptInput {
  /** The rendered t=0 bundle (`renderT0Bundle`), when one was assembled. */
  readonly t0Bundle?: string;
  /** The raw Alertmanager notification the box received, when there is no bundle. */
  readonly webhookPayload?: string;
}

/**
 * Assemble the first user message handed to the agent.
 *
 * Precedence: the assembled bundle, else the raw notification, else a generic
 * page (a manual run with no delivered payload). Blank strings count as absent —
 * shell drivers forward unset vars as `""`.
 */
export function buildKickoffPrompt(input: KickoffPromptInput = {}): string {
  const bundle = input.t0Bundle?.trim() ? input.t0Bundle : undefined;
  const payload = input.webhookPayload?.trim() ? input.webhookPayload : undefined;

  if (bundle) {
    return (
      "This incident context bundle was just delivered to the incident host:\n" +
      bundle +
      "\n" +
      TAIL
    );
  }
  if (payload) {
    return (
      "This alert notification was just delivered to the incident host:\n" +
      payload +
      "\n" +
      TAIL
    );
  }
  return "An alert is firing for the service. " + TAIL;
}
