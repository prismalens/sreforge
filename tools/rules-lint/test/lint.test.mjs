// lint.test.mjs — tests for rules-lint (#76)

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	DEFAULT_TARGETS,
	lintContent,
	lintRules,
	resolveTargets,
} from "../lint.mjs";

const CLI_PATH = fileURLToPath(new URL("../lint.mjs", import.meta.url));

test("all-labelled fixture returns [] from lintContent", () => {
	const yaml = `
groups:
  - name: test.rules
    rules:
      - alert: TestAlert
        expr: up == 0
        labels:
          severity: critical
          service: test-service
`;
	const stats = { totalAlerts: 0 };
	const result = lintContent(yaml, "test.yml", stats);
	assert.deepEqual(result, []);
	assert.equal(stats.totalAlerts, 1);
});

test("missing-label fixture returns failure object", () => {
	const yaml = `
groups:
  - name: test.rules
    rules:
      - alert: MissingService
        expr: up == 0
        labels:
          severity: warning
`;
	const stats = { totalAlerts: 0 };
	const result = lintContent(yaml, "bad.yml", stats);
	assert.equal(result.length, 1);
	assert.equal(result[0].alert, "MissingService");
	assert.equal(result[0].line, 5);
	assert.equal(result[0].file, "bad.yml");
	assert.equal(stats.totalAlerts, 1);
});

test("empty-value fixture treated as missing", () => {
	const yaml = `
groups:
  - name: test.rules
    rules:
      - alert: EmptyService
        expr: up == 0
        labels:
          severity: warning
          service:
`;
	const stats = { totalAlerts: 0 };
	const result = lintContent(yaml, "empty.yml", stats);
	assert.equal(result.length, 1);
	assert.equal(result[0].alert, "EmptyService");
	assert.equal(result[0].line, 5);
	assert.equal(stats.totalAlerts, 1);
});

test("real live rule files all pass", () => {
	// The served copy is a gitignored build artifact present only after an arm;
	// exclude it so the exact file and alert counts stay deterministic.
	const files = resolveTargets(DEFAULT_TARGETS).filter(
		(f) => !f.endsWith("observability/rules/ambient-rules.yml"),
	);
	assert.equal(files.length, 2);
	const stats = { totalAlerts: 0 };
	const failures = lintRules(files, stats);
	assert.deepEqual(failures, []);
	assert.equal(stats.totalAlerts, 5);
});

test("CLI exit 0 on all-labelled fixture", () => {
	const tmpDir = join(tmpdir(), `rules-lint-test-${Date.now()}`);
	mkdirSync(tmpDir, { recursive: true });
	const file = join(tmpDir, "good.yml");
	writeFileSync(
		file,
		`groups:\n  - name: g.rules\n    rules:\n      - alert: Good\n        expr: up == 0\n        labels:\n          service: s1\n`,
	);
	try {
		const stdout = execFileSync("node", [CLI_PATH, file], { encoding: "utf8" });
		assert.match(
			stdout,
			/rules-lint: OK — 1 alert\(s\) across 1 file\(s\), all carry a service label/,
		);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("CLI exit 1 on missing-label fixture", () => {
	const tmpDir = join(tmpdir(), `rules-lint-test-${Date.now()}`);
	mkdirSync(tmpDir, { recursive: true });
	const file = join(tmpDir, "bad.yml");
	writeFileSync(
		file,
		`groups:\n  - name: b.rules\n    rules:\n      - alert: Bad\n        expr: up == 0\n        labels:\n          severity: warning\n`,
	);
	try {
		assert.throws(
			() => execFileSync("node", [CLI_PATH, file], { encoding: "utf8" }),
			(err) => {
				assert.equal(err.status, 1);
				assert.match(
					err.stderr,
					/rules-lint: FAIL — .*bad\.yml:4 alert "Bad" has no service label/,
				);
				assert.match(
					err.stderr,
					/rules-lint: FAIL — 1 of 1 alert\(s\) missing a service label/,
				);
				return true;
			},
		);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("annotation-only service fixture fails lint", () => {
	const yaml = `
groups:
  - name: test.rules
    rules:
      - alert: AnnotationOnlyService
        expr: up == 0
        annotations:
          summary: Alert summary
          service: annotation-service
`;
	const stats = { totalAlerts: 0 };
	const result = lintContent(yaml, "annotation_only.yml", stats);
	assert.equal(result.length, 1);
	assert.equal(result[0].alert, "AnnotationOnlyService");
	assert.equal(stats.totalAlerts, 1);
});

test("quoted-empty service fixture fails lint", () => {
	const yamlDouble = `
groups:
  - name: test.rules
    rules:
      - alert: QuotedDoubleEmpty
        expr: up == 0
        labels:
          service: ""
`;
	const yamlSingle = `
groups:
  - name: test.rules
    rules:
      - alert: QuotedSingleEmpty
        expr: up == 0
        labels:
          service: ''
`;
	assert.equal(lintContent(yamlDouble, "double.yml").length, 1);
	assert.equal(lintContent(yamlSingle, "single.yml").length, 1);
});

test("null or tilde service fixture fails lint", () => {
	const yamlNull = `
groups:
  - name: test.rules
    rules:
      - alert: NullService
        expr: up == 0
        labels:
          service: null
`;
	const yamlTilde = `
groups:
  - name: test.rules
    rules:
      - alert: TildeService
        expr: up == 0
        labels:
          service: ~
`;
	assert.equal(lintContent(yamlNull, "null.yml").length, 1);
	assert.equal(lintContent(yamlTilde, "tilde.yml").length, 1);
});

test("following recording rule labels do not satisfy alert service requirement", () => {
	const yaml = `
groups:
  - name: test.rules
    rules:
      - alert: AlertWithoutService
        expr: up == 0
        labels:
          severity: critical
      - record: job:up:count
        expr: count(up)
        labels:
          service: recording-service
`;
	const stats = { totalAlerts: 0 };
	const result = lintContent(yaml, "recording_rule.yml", stats);
	assert.equal(result.length, 1);
	assert.equal(result[0].alert, "AlertWithoutService");
	assert.equal(stats.totalAlerts, 1);
});

test("resolveTargets respects wildcard glob patterns and extensions", () => {
	const tmpDir = join(tmpdir(), `rules-lint-glob-${Date.now()}`);
	mkdirSync(tmpDir, { recursive: true });
	writeFileSync(join(tmpDir, "rule-a.yml"), "content");
	writeFileSync(join(tmpDir, "rule-b.yaml"), "content");
	writeFileSync(join(tmpDir, "subset-c.yml"), "content");
	writeFileSync(join(tmpDir, "other.txt"), "content");

	try {
		const ymlOnly = resolveTargets([join(tmpDir, "*.yml")]);
		assert.deepEqual(ymlOnly, [
			join(tmpDir, "rule-a.yml"),
			join(tmpDir, "subset-c.yml"),
		]);

		const subsetOnly = resolveTargets([join(tmpDir, "subset-*.yml")]);
		assert.deepEqual(subsetOnly, [join(tmpDir, "subset-c.yml")]);

		const yamlOnly = resolveTargets([join(tmpDir, "*.yaml")]);
		assert.deepEqual(yamlOnly, [join(tmpDir, "rule-b.yaml")]);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});
