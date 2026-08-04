// =============================================================================
// lib-kickoff.mjs — which alert opens the run (#107).
//
// Alertmanager delivers notifications in whatever order they happen to arrive,
// so the agent's t=0 headline used to be a coin flip: ambient furniture
// (EdgeClientRequestJitter) could take the headline while the record claimed the
// incident alert kicked the run off. This module is the part of auto-incident.mjs
// that has a right and a wrong answer, kept pure so it can be tested without
// arming a live run.
//
// REORDER, NEVER FILTER, NEVER ANNOTATE: every delivered alert is kept and none
// is labelled — the ordering is the whole mechanism (core's
// orderSignalsForKickoff owns it, so the bundle and the plain path cannot
// disagree). The kickoff is the scenario's declared alert when it is among the
// delivered ones; otherwise it is the honest first arrival, recorded as such.
// =============================================================================
import { orderSignalsForKickoff } from "../../../../../core/dist/context/t0-bundle.js";

/**
 * Map raw Alertmanager notification alerts onto the engine's TriggerSignal shape.
 * `now` is injectable so the mapping is deterministic under test; it only ever
 * stands in for an alert that arrived without a startsAt.
 */
export function signalsFromAlerts(alerts, now = () => new Date().toISOString()) {
	return (alerts || []).map((a) => {
		const labels = a?.labels || {};
		return {
			alertName: labels.alertname || "UnknownAlert",
			severity: labels.severity,
			labels,
			annotations: a?.annotations || {},
			firedAt: a?.startsAt || now(),
		};
	});
}

/**
 * Resolve the run's kickoff from the delivered notification.
 *
 * Returns the ordered signals (expected alert first when it arrived) and
 * `kickoffAlert` — `signals[0].alertName`, i.e. the alert the agent is actually
 * paged on. `kickoffAlert` is undefined only when nothing was delivered.
 */
export function resolveKickoff(alerts, expectedAlert, now) {
	const signals = orderSignalsForKickoff(
		signalsFromAlerts(alerts, now),
		expectedAlert,
	);
	return {
		signals,
		kickoffAlert: signals.length > 0 ? signals[0].alertName : undefined,
	};
}
