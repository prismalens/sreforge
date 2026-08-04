import assert from "node:assert/strict";
import test from "node:test";
import {
	assembleT0Bundle,
	assertSymptomLevel,
	orderSignalsForKickoff,
	renderT0Bundle,
} from "../dist/context/t0-bundle.js";

test("assembleT0Bundle - assembly shape and assembled_at = max firedAt", () => {
	const trigger = {
		source: "trigger-bus",
		alertName: "PrimaryAlert",
		severity: "critical",
		labels: { app: "foo" },
		annotations: { msg: "bad" },
		firedAt: "2026-06-25T10:15:30Z",
		signals: [
			{
				alertName: "PrimaryAlert",
				severity: "critical",
				labels: { app: "foo" },
				annotations: { msg: "bad" },
				firedAt: "2026-06-25T10:15:30Z",
			},
			{
				alertName: "SecondaryAlert",
				labels: {},
				annotations: {},
				firedAt: "2026-06-25T10:15:45Z",
			},
		],
	};

	const slackTriage = [
		{ channel: "alerts", user: "U1", ts: "12345.67", text: "looking into it" },
	];

	const bundle = assembleT0Bundle({ runId: "r-1", trigger, slackTriage });

	assert.equal(bundle.schema_version, "t0-bundle.v1");
	assert.equal(bundle.incident_id, "r-1");
	assert.equal(bundle.assembled_at, "2026-06-25T10:15:45Z"); // max firedAt
	assert.equal(bundle.signals.length, 2);
	assert.equal(bundle.slack_triage.length, 1);

	// Stable rendering test
	const rendered = renderT0Bundle(bundle);
	assert.ok(rendered.includes("schema_version"));
});

// ---------------------------------------------------------------------------
// #107 — deterministic kickoff ordering. The rule is REORDER, never filter and
// never annotate: the agent must get the same set of facts in a stable order,
// with no hint about which one the scenario considers the real incident.
// ---------------------------------------------------------------------------

const sig = (alertName, firedAt) => ({
	alertName,
	labels: {},
	annotations: {},
	firedAt,
});

test("orderSignalsForKickoff - expected alert leads regardless of arrival order", () => {
	const arrived = [
		sig("EdgeClientRequestJitter", "2026-06-25T10:15:30Z"),
		sig("BooklogrApiLatencyP99High", "2026-06-25T10:15:45Z"),
		sig("QueueDepthWarning", "2026-06-25T10:15:35Z"),
	];

	const ordered = orderSignalsForKickoff(arrived, "BooklogrApiLatencyP99High");

	assert.equal(ordered[0].alertName, "BooklogrApiLatencyP99High");
	// Every arrived signal is KEPT — furniture is still part of the picture.
	assert.equal(ordered.length, 3);
	assert.deepEqual(
		[...ordered].map((s) => s.alertName).sort(),
		[...arrived].map((s) => s.alertName).sort(),
	);
	// Remainder is stable-sorted by firedAt, then alertName.
	assert.deepEqual(
		ordered.slice(1).map((s) => s.alertName),
		["EdgeClientRequestJitter", "QueueDepthWarning"],
	);
});

test("orderSignalsForKickoff - same result whichever notification landed first", () => {
	const a = sig("EdgeClientRequestJitter", "2026-06-25T10:15:30Z");
	const b = sig("BooklogrApiLatencyP99High", "2026-06-25T10:15:45Z");

	const names = (arr) =>
		orderSignalsForKickoff(arr, "BooklogrApiLatencyP99High").map(
			(s) => s.alertName,
		);

	assert.deepEqual(names([a, b]), names([b, a]));
});

test("orderSignalsForKickoff - remainder ties broken by alertName, then arrival", () => {
	const arrived = [
		sig("Zeta", "2026-06-25T10:15:30Z"),
		sig("Primary", "2026-06-25T10:15:31Z"),
		sig("Alpha", "2026-06-25T10:15:30Z"),
	];

	assert.deepEqual(
		orderSignalsForKickoff(arrived, "Primary").map((s) => s.alertName),
		["Primary", "Alpha", "Zeta"],
	);
});

test("orderSignalsForKickoff - expected alert absent or unset leaves arrival order", () => {
	const arrived = [
		sig("EdgeClientRequestJitter", "2026-06-25T10:15:30Z"),
		sig("QueueDepthWarning", "2026-06-25T10:15:20Z"),
	];

	assert.deepEqual(orderSignalsForKickoff(arrived, "NeverFired"), arrived);
	assert.deepEqual(orderSignalsForKickoff(arrived, undefined), arrived);
});

test("assembleT0Bundle - promotes the expected alert and reports kickoff_alert", () => {
	const signals = [
		sig("EdgeClientRequestJitter", "2026-06-25T10:15:30Z"),
		sig("BooklogrApiLatencyP99High", "2026-06-25T10:15:45Z"),
	];
	const trigger = {
		source: "multi-alert",
		alertName: "EdgeClientRequestJitter",
		labels: {},
		annotations: {},
		firedAt: "2026-06-25T10:15:30Z",
		signals,
	};

	const bundle = assembleT0Bundle({
		runId: "r-1",
		trigger,
		slackTriage: [],
		expectedAlert: "BooklogrApiLatencyP99High",
	});

	assert.equal(bundle.kickoff_alert, "BooklogrApiLatencyP99High");
	assert.equal(bundle.signals[0].alertName, "BooklogrApiLatencyP99High");
	assert.equal(bundle.signals.length, 2);
	// assembled_at stays the max firedAt — ordering must not change it.
	assert.equal(bundle.assembled_at, "2026-06-25T10:15:45Z");
});

test("assembleT0Bundle - kickoff_alert is the first arrival when the expected alert never fired", () => {
	const trigger = {
		source: "multi-alert",
		alertName: "EdgeClientRequestJitter",
		labels: {},
		annotations: {},
		firedAt: "2026-06-25T10:15:30Z",
		signals: [
			sig("EdgeClientRequestJitter", "2026-06-25T10:15:30Z"),
			sig("QueueDepthWarning", "2026-06-25T10:15:20Z"),
		],
	};

	const bundle = assembleT0Bundle({
		runId: "r-1",
		trigger,
		slackTriage: [],
		expectedAlert: "BooklogrApiLatencyP99High",
	});

	assert.equal(bundle.kickoff_alert, "EdgeClientRequestJitter");
	assert.equal(bundle.signals[0].alertName, "EdgeClientRequestJitter");
});

test("renderT0Bundle - DE-TELL: no annotation of the promoted alert", () => {
	const trigger = {
		source: "multi-alert",
		alertName: "EdgeClientRequestJitter",
		labels: {},
		annotations: {},
		firedAt: "2026-06-25T10:15:30Z",
		signals: [
			sig("EdgeClientRequestJitter", "2026-06-25T10:15:30Z"),
			sig("BooklogrApiLatencyP99High", "2026-06-25T10:15:45Z"),
		],
	};

	const rendered = renderT0Bundle(
		assembleT0Bundle({
			runId: "r-1",
			trigger,
			slackTriage: [],
			expectedAlert: "BooklogrApiLatencyP99High",
		}),
	);

	// The kickoff decision shows up as ORDER only. Neither the field naming it
	// nor any word that would flag one signal as the real one may appear — the
	// agent must still do its own triage.
	assert.ok(!rendered.includes("kickoff_alert"));
	for (const word of ["expected", "primary", "real alert", "incident alert"]) {
		assert.ok(
			!rendered.toLowerCase().includes(word),
			`rendered bundle must not contain "${word}"`,
		);
	}
	// The rendered document is exactly the same one an unordered bundle renders,
	// modulo the order of signals.
	const parsed = JSON.parse(rendered);
	assert.deepEqual(Object.keys(parsed), [
		"schema_version",
		"incident_id",
		"assembled_at",
		"signals",
		"slack_triage",
	]);
	assert.deepEqual(
		parsed.signals.map((s) => s.alertName),
		["BooklogrApiLatencyP99High", "EdgeClientRequestJitter"],
	);
});

test("assembleT0Bundle - single-signal trigger still reports its kickoff_alert", () => {
	const bundle = assembleT0Bundle({
		runId: "r-1",
		trigger: {
			source: "prometheus-alert",
			alertName: "OnlyAlert",
			labels: {},
			annotations: {},
			firedAt: "2026-06-25T10:15:30Z",
		},
		slackTriage: [],
	});

	assert.equal(bundle.kickoff_alert, "OnlyAlert");
});

test("assertSymptomLevel - throws on poisoned annotation", () => {
	const trigger = {
		source: "prometheus-alert",
		alertName: "Alert1",
		labels: {},
		annotations: { summary: "The root cause is a bad patch" },
		firedAt: "2026-06-25T10:15:30Z",
	};

	assert.throws(() => {
		assembleT0Bundle({ runId: "r-1", trigger, slackTriage: [] });
	}, /Poisoned content found/);
});
