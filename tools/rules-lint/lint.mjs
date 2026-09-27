#!/usr/bin/env node
// =============================================================================
// lint.mjs — issue #76: verify all Prometheus alert rules carry a `service` label.
//
// Every alert rule in `observability/rules/*.yml` must carry a nested `service` label:
// alert grouping and anything scoped by service depend on it.
//
// Usage:
//   node tools/rules-lint/lint.mjs [<file|glob> ...]
// Exit 0 = all valid; 1 = missing label(s); 2 = usage/parse error.
// =============================================================================
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_TARGETS = [
	"use-cases/booklogr/stacks/flask-compose/observability/rules/*.yml",
];

function isValidServiceValue(rawVal) {
	if (!rawVal) return false;
	let val = rawVal.trim();
	if (
		(val.startsWith('"') && val.endsWith('"')) ||
		(val.startsWith("'") && val.endsWith("'"))
	) {
		val = val.slice(1, -1).trim();
	}
	if (!val || val === "~" || val.toLowerCase() === "null") return false;
	return true;
}

function globToRegExp(pattern) {
	const escaped = pattern.replace(/[.+^${}()|\\[\]]/g, "\\$&");
	const regexStr = `^${escaped.replace(/\*/g, "[^/]*").replace(/\?/g, ".")}$`;
	return new RegExp(regexStr);
}

/**
 * Lint YAML content string for Prometheus alert rules missing a `service` label.
 * @param {string} content - YAML content
 * @param {string} file - Filename/path (for error reporting)
 * @param {{totalAlerts?: number}} [stats] - Optional object to collect statistics
 * @returns {Array<{file: string, line: number, alert: string}>} List of failures
 */
export function lintContent(content, file = "", stats = null) {
	const lines = content.split(/\r?\n/);
	const failures = [];
	let currentAlert = null;

	function finalizeCurrent() {
		if (!currentAlert) return;
		if (!currentAlert.hasService) {
			failures.push({
				file: currentAlert.file,
				line: currentAlert.line,
				alert: currentAlert.alert,
			});
		}
	}

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lineNum = i + 1;

		// Ignore full-line comments and empty lines
		if (/^\s*#/.test(line) || /^\s*$/.test(line)) {
			continue;
		}

		// New group starts
		if (/^\s*-\s*name:/.test(line)) {
			finalizeCurrent();
			currentAlert = null;
			continue;
		}

		// New alert starts
		const alertMatch = line.match(/^(\s*)-\s*alert:\s*(\S.*?)\s*$/);
		if (alertMatch) {
			finalizeCurrent();
			if (stats) {
				stats.totalAlerts = (stats.totalAlerts || 0) + 1;
			}
			let alertName = alertMatch[2].trim();
			if (
				(alertName.startsWith('"') && alertName.endsWith('"')) ||
				(alertName.startsWith("'") && alertName.endsWith("'"))
			) {
				alertName = alertName.slice(1, -1);
			}
			const indent = alertMatch[1].length;
			currentAlert = {
				file,
				line: lineNum,
				alert: alertName,
				indent,
				hasService: false,
				inLabels: false,
				labelsIndent: null,
			};
			continue;
		}

		// Within alert block
		if (currentAlert) {
			const lineIndentMatch = line.match(/^(\s*)/);
			const lineIndent = lineIndentMatch ? lineIndentMatch[1].length : 0;

			if (lineIndent <= currentAlert.indent) {
				finalizeCurrent();
				currentAlert = null;
				continue;
			}

			const lineWithoutComment = line.replace(/#.*$/, "").trimEnd();

			if (currentAlert.inLabels) {
				if (lineIndent <= currentAlert.labelsIndent) {
					currentAlert.inLabels = false;
				} else {
					const serviceMatch = lineWithoutComment.match(/^\s*service:\s*(.*)$/);
					if (serviceMatch && isValidServiceValue(serviceMatch[1])) {
						currentAlert.hasService = true;
					}
				}
			}

			if (!currentAlert.inLabels) {
				if (/^\s*labels:\s*$/.test(lineWithoutComment)) {
					currentAlert.inLabels = true;
					currentAlert.labelsIndent = lineIndent;
				}
			}
		}
	}

	finalizeCurrent();
	return failures;
}

/**
 * Lint a single file.
 * @param {string} filePath
 * @param {{totalAlerts?: number}} [stats]
 * @returns {Array<{file: string, line: number, alert: string}>}
 */
export function lintFile(filePath, stats = null) {
	const content = readFileSync(filePath, "utf8");
	return lintContent(content, filePath, stats);
}

/**
 * Lint multiple files.
 * @param {string[]} filePaths
 * @param {{totalAlerts?: number}} [stats]
 * @returns {Array<{file: string, line: number, alert: string}>}
 */
export function lintRules(filePaths, stats = null) {
	const failures = [];
	for (const f of filePaths) {
		failures.push(...lintFile(f, stats));
	}
	return failures;
}

/**
 * Expand CLI arguments/globs to concrete file paths.
 * Node 20 safe (does not use fs.globSync).
 * @param {string[]} patterns
 * @returns {string[]}
 */
export function resolveTargets(patterns) {
	const files = [];
	for (const pattern of patterns) {
		if (existsSync(pattern)) {
			const stat = statSync(pattern);
			if (stat.isFile()) {
				files.push(pattern);
			} else if (stat.isDirectory()) {
				const entries = readdirSync(pattern, { withFileTypes: true });
				for (const entry of entries) {
					if (
						entry.isFile() &&
						(entry.name.endsWith(".yml") || entry.name.endsWith(".yaml"))
					) {
						files.push(join(pattern, entry.name));
					}
				}
			}
		} else {
			// Simple glob expansion: e.g. path/to/rules/*.yml
			const wildcardIndex = pattern.search(/[*?[]/);
			if (wildcardIndex !== -1) {
				const lastSlash = pattern.lastIndexOf("/");
				const dir = lastSlash !== -1 ? pattern.slice(0, lastSlash) : ".";
				const filenamePattern =
					lastSlash !== -1 ? pattern.slice(lastSlash + 1) : pattern;
				if (existsSync(dir)) {
					const regex = globToRegExp(filenamePattern);
					const entries = readdirSync(dir, { withFileTypes: true });
					for (const entry of entries) {
						if (entry.isFile() && regex.test(entry.name)) {
							files.push(join(dir, entry.name));
						}
					}
				}
			}
		}
	}
	// Unique and sorted
	return Array.from(new Set(files)).sort();
}

/**
 * Check that the ambient service is unscoped (not in verify.services) in all scenario manifests.
 * @param {string} scenariosDir
 * @param {string} ambientService
 * @returns {{count: number, errors: string[]}}
 */
// ── CLI ──────────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
	let rawArgs = process.argv.slice(2);
	if (rawArgs.length === 0) {
		rawArgs = [...DEFAULT_TARGETS];
	}

	let filePaths;
	try {
		filePaths = resolveTargets(rawArgs);
	} catch (_e) {
		console.error("usage: rules-lint.mjs <rules-glob-or-file> [...]");
		process.exit(2);
	}

	if (filePaths.length === 0) {
		console.error("usage: rules-lint.mjs <rules-glob-or-file> [...]");
		process.exit(2);
	}

	const stats = { totalAlerts: 0 };
	let failures;
	try {
		failures = lintRules(filePaths, stats);
	} catch (_e) {
		console.error("usage: rules-lint.mjs <rules-glob-or-file> [...]");
		process.exit(2);
	}

	const totalAlerts = stats.totalAlerts;
	const totalFiles = filePaths.length;

	if (failures.length > 0) {
		for (const f of failures) {
			console.error(
				`rules-lint: FAIL — ${f.file}:${f.line} alert "${f.alert}" has no service label`,
			);
		}
		console.error(
			`rules-lint: FAIL — ${failures.length} of ${totalAlerts} alert(s) missing a service label`,
		);
		process.exit(1);
	} else {
		console.log(
			`rules-lint: OK — ${totalAlerts} alert(s) across ${totalFiles} file(s), all carry a service label`,
		);
		console.log("[rules-lint] Found 0 errors.");
		process.exit(0);
	}
}
