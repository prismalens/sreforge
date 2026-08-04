// #107 — the kickoff selection auto-incident.mjs applies to the delivered
// notification. The defect these cover: Alertmanager answers whichever alert
// lands first, so ambient furniture (EdgeClientRequestJitter, from the #86/#94
// realism baseline) could take the agent's t=0 headline while the record claimed
// the incident alert opened the run.
import assert from "node:assert/strict";
import test from "node:test";
import { resolveKickoff, signalsFromAlerts } from "../lib-kickoff.mjs";

const EXPECTED = "BooklogrApiLatencyP99High";

const alert = (alertname, startsAt, extra = {}) => ({
	labels: { alertname, severity: "warning", ...(extra.labels || {}) },
	annotations: extra.annotations || { summary: `${alertname} is firing` },
	startsAt,
});

test("signalsFromAlerts - maps the notification onto trigger signals", () => {
	const signals = signalsFromAlerts([
		alert("EdgeClientRequestJitter", "2026-07-25T10:15:30Z"),
	]);

	assert.deepEqual(signals, [
		{
			alertName: "EdgeClientRequestJitter",
			severity: "warning",
			labels: { alertname: "EdgeClientRequestJitter", severity: "warning" },
			annotations: { summary: "EdgeClientRequestJitter is firing" },
			firedAt: "2026-07-25T10:15:30Z",
		},
	]);
});

test("signalsFromAlerts - tolerates an empty or absent alert list", () => {
	assert.deepEqual(signalsFromAlerts([]), []);
	assert.deepEqual(signalsFromAlerts(undefined), []);
});

test("signalsFromAlerts - names an unlabelled alert rather than dropping it", () => {
	const signals = signalsFromAlerts([{ startsAt: "2026-07-25T10:15:30Z" }]);
	assert.equal(signals.length, 1);
	assert.equal(signals[0].alertName, "UnknownAlert");
});

test("furniture-first arrival: the expected alert becomes the headline", () => {
	const { signals, kickoffAlert } = resolveKickoff(
		[
			alert("EdgeClientRequestJitter", "2026-07-25T10:15:30Z"),
			alert(EXPECTED, "2026-07-25T10:15:45Z"),
		],
		EXPECTED,
	);

	assert.equal(kickoffAlert, EXPECTED);
	assert.equal(signals[0].alertName, EXPECTED);
	// Furniture is NOT filtered — it still reaches the agent as a signal.
	assert.equal(signals.length, 2);
	assert.ok(signals.some((s) => s.alertName === "EdgeClientRequestJitter"));
});

test("the same set of alerts kicks off identically whatever the arrival order", () => {
	const a = alert("EdgeClientRequestJitter", "2026-07-25T10:15:30Z");
	const b = alert(EXPECTED, "2026-07-25T10:15:45Z");
	const c = alert("QueueDepthWarning", "2026-07-25T10:15:35Z");

	const order1 = resolveKickoff([a, b, c], EXPECTED);
	const order2 = resolveKickoff([c, a, b], EXPECTED);
	const order3 = resolveKickoff([b, c, a], EXPECTED);

	for (const r of [order2, order3]) {
		assert.equal(r.kickoffAlert, order1.kickoffAlert);
		assert.deepEqual(
			r.signals.map((s) => s.alertName),
			order1.signals.map((s) => s.alertName),
		);
	}
	assert.deepEqual(order1.signals.map((s) => s.alertName), [
		EXPECTED,
		"EdgeClientRequestJitter",
		"QueueDepthWarning",
	]);
});

test("expected alert absent: the first arrival wins, and that is the truth recorded", () => {
	const { signals, kickoffAlert } = resolveKickoff(
		[
			alert("EdgeClientRequestJitter", "2026-07-25T10:15:30Z"),
			alert("QueueDepthWarning", "2026-07-25T10:15:20Z"),
		],
		EXPECTED,
	);

	assert.equal(kickoffAlert, "EdgeClientRequestJitter");
	// Arrival order stands untouched when there is nothing to promote.
	assert.deepEqual(
		signals.map((s) => s.alertName),
		["EdgeClientRequestJitter", "QueueDepthWarning"],
	);
});

test("nothing delivered: no kickoff to claim", () => {
	const { signals, kickoffAlert } = resolveKickoff([], EXPECTED);
	assert.deepEqual(signals, []);
	assert.equal(kickoffAlert, undefined);
});

test("a single delivered alert is the kickoff, expected or not", () => {
	assert.equal(
		resolveKickoff([alert(EXPECTED, "2026-07-25T10:15:30Z")], EXPECTED)
			.kickoffAlert,
		EXPECTED,
	);
	assert.equal(
		resolveKickoff(
			[alert("EdgeClientRequestJitter", "2026-07-25T10:15:30Z")],
			EXPECTED,
		).kickoffAlert,
		"EdgeClientRequestJitter",
	);
});

test("an alert with no startsAt still resolves (injected clock keeps it deterministic)", () => {
	const { kickoffAlert, signals } = resolveKickoff(
		[{ labels: { alertname: "EdgeClientRequestJitter" } }],
		EXPECTED,
		() => "2026-07-25T10:15:30Z",
	);

	assert.equal(kickoffAlert, "EdgeClientRequestJitter");
	assert.equal(signals[0].firedAt, "2026-07-25T10:15:30Z");
});
