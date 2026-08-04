import type { Trigger, TriggerSignal } from "../types.js";

export interface SlackTriageMessage {
	readonly channel: string;
	readonly user: string;
	readonly ts: string;
	readonly text: string;
}

export interface T0Bundle {
	readonly schema_version: "t0-bundle.v1";
	readonly incident_id: string;
	readonly assembled_at: string;
	readonly signals: readonly TriggerSignal[];
	readonly slack_triage: readonly SlackTriageMessage[];
	/**
	 * The alert that opened the run — `signals[0].alertName` after ordering.
	 * Harness-side audit metadata for the run record (#107); deliberately NOT
	 * part of the rendered, agent-facing document (see {@link renderT0Bundle}).
	 */
	readonly kickoff_alert: string;
}

export function assertSymptomLevel(bundle: T0Bundle): void {
	const POISON_RX = /root.?cause|oracle|fix\.patch|solution\//i;

	const check = (val: string, path: string) => {
		if (POISON_RX.test(val)) {
			throw new Error(`Poisoned content found in ${path}`);
		}
	};

	for (let i = 0; i < bundle.signals.length; i++) {
		const s = bundle.signals[i]!;
		for (const [k, v] of Object.entries(s.annotations))
			check(v, `signals[${i}].annotations[${k}]`);
		for (const [k, v] of Object.entries(s.labels))
			check(v, `signals[${i}].labels[${k}]`);
	}

	for (let i = 0; i < bundle.slack_triage.length; i++) {
		check(bundle.slack_triage[i]!.text, `slack_triage[${i}].text`);
	}
}

/**
 * Deterministically order the arrived signals so the run's t=0 headline does not
 * depend on which Alertmanager notification happened to land first (#107).
 *
 * REORDERING ONLY — never filtering, never annotating. Every arrived signal is
 * kept (ambient furniture stays part of the agent's t=0 picture, #86/#94) and
 * nothing is labelled: the agent sees the same facts in a stable order, so it is
 * handed no triage for free. When `expectedAlert` is set and present among the
 * signals its instances come first (arrival order preserved among themselves)
 * and the remainder is sorted by `firedAt`, then `alertName` — a stable sort, so
 * equal keys keep arrival order. When it is unset or did not arrive, arrival
 * order stands: the first arrival is the honest kickoff and is recorded as such.
 */
export function orderSignalsForKickoff(
	signals: readonly TriggerSignal[],
	expectedAlert?: string,
): readonly TriggerSignal[] {
	if (!expectedAlert) return signals;
	const expected = signals.filter((s) => s.alertName === expectedAlert);
	if (expected.length === 0) return signals;
	const rest = signals
		.filter((s) => s.alertName !== expectedAlert)
		.sort((a, b) => {
			const ta = Date.parse(a.firedAt);
			const tb = Date.parse(b.firedAt);
			if (Number.isFinite(ta) && Number.isFinite(tb)) {
				if (ta !== tb) return ta - tb;
			} else if (a.firedAt !== b.firedAt) {
				return a.firedAt < b.firedAt ? -1 : 1;
			}
			if (a.alertName === b.alertName) return 0;
			return a.alertName < b.alertName ? -1 : 1;
		});
	return [...expected, ...rest];
}

export interface AssembleT0BundleOptions {
	readonly runId: string;
	readonly trigger: Trigger;
	readonly slackTriage: readonly SlackTriageMessage[];
	/**
	 * The scenario's declared alert (BINDING to `scenario.toml` `[expected]
	 * alert`). When set and present among the signals it is promoted to
	 * `signals[0]` — see {@link orderSignalsForKickoff}. Optional: without it the
	 * bundle keeps arrival order.
	 */
	readonly expectedAlert?: string;
}

export function assembleT0Bundle(opts: AssembleT0BundleOptions): T0Bundle {
	const arrived = opts.trigger.signals ?? [
		{
			alertName: opts.trigger.alertName,
			severity: opts.trigger.severity,
			labels: opts.trigger.labels,
			annotations: opts.trigger.annotations,
			firedAt: opts.trigger.firedAt,
		},
	];
	const signals = orderSignalsForKickoff(arrived, opts.expectedAlert);

	let maxFiredAt = signals[0]!.firedAt;
	for (const s of signals) {
		if (new Date(s.firedAt).getTime() > new Date(maxFiredAt).getTime()) {
			maxFiredAt = s.firedAt;
		}
	}

	const bundle: T0Bundle = {
		schema_version: "t0-bundle.v1",
		incident_id: opts.runId,
		assembled_at: maxFiredAt,
		signals,
		slack_triage: opts.slackTriage,
		kickoff_alert: signals[0]!.alertName,
	};

	assertSymptomLevel(bundle);

	return bundle;
}

export function renderT0Bundle(bundle: T0Bundle): string {
	// Stable key order.
	//
	// `kickoff_alert` is DELIBERATELY absent from the rendered document. The
	// render is the agent's t=0 payload; naming one signal as the kickoff would
	// annotate the picture and hand the agent triage for free (#107 de-tell rule:
	// reorder, never annotate). The ordering already carries the decision, and the
	// field is derivable as `signals[0].alertName` — it exists for the run record,
	// not for the agent.
	const ordered = {
		schema_version: bundle.schema_version,
		incident_id: bundle.incident_id,
		assembled_at: bundle.assembled_at,
		signals: bundle.signals.map((s) => ({
			alertName: s.alertName,
			severity: s.severity,
			labels: Object.fromEntries(Object.entries(s.labels).sort()),
			annotations: Object.fromEntries(Object.entries(s.annotations).sort()),
			firedAt: s.firedAt,
		})),
		slack_triage: bundle.slack_triage.map((m) => ({
			channel: m.channel,
			user: m.user,
			ts: m.ts,
			text: m.text,
		})),
	};
	return JSON.stringify(ordered, null, 2);
}
