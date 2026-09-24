#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	defineChecks,
	resolveRepoRoot,
	runAllChecks,
	summarize,
} from "../../../../../tools/doctor/lib.mjs";
import { DEPLOY_SERVICES } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STACK = resolve(HERE, "..");
const USECASE = resolve(STACK, "../..");
const REPO_ROOT = resolveRepoRoot(USECASE);

// Read env directly instead of relying on Taskfile dotenv so it can run if missing
let envContent = "";
const envPath = resolve(STACK, ".env");
if (existsSync(envPath)) {
	envContent = readFileSync(envPath, "utf8");
}
const env = {};
for (const line of envContent.split("\n")) {
	const m = line.match(/^([^=]+)=(.*)$/);
	if (m) env[m[1]] = m[2].trim();
}

const parsedGiteaUrl = new URL(env.GITEA_URL || "http://127.0.0.1:3000");

const ambientEnvPath = resolve(STACK, "furniture/ambient.env");
const ambientEnv = {};
if (existsSync(ambientEnvPath)) {
	const ambientContent = readFileSync(ambientEnvPath, "utf8");
	for (const line of ambientContent.split("\n")) {
		const m = line.match(/^([^=]+)=(.*)$/);
		if (m) {
			let val = m[2].trim();
			if (
				(val.startsWith('"') && val.endsWith('"')) ||
				(val.startsWith("'") && val.endsWith("'"))
			) {
				val = val.slice(1, -1);
			}
			ambientEnv[m[1]] = val;
		}
	}
}

const config = {
	giteaLocalhostUrl: (() => {
		const u = new URL(parsedGiteaUrl);
		u.hostname = "localhost";
		return u.href;
	})(),
	gitea127Url: (() => {
		const u = new URL(parsedGiteaUrl);
		u.hostname = "127.0.0.1";
		return u.href;
	})(),
	giteaAdminUser: env.GITEA_ADMIN_USER || "sreforge",
	giteaAdminPass: env.GITEA_ADMIN_PASSWORD || "change-me-locally",
	giteaMaintUser: env.GITEA_MAINT_USER || "maintainer",
	giteaMaintPass: env.GITEA_MAINT_PASS || "maintainer",
	giteaOwner: env.GITEA_REPO_OWNER || "booklogr",
	giteaRepo: env.GITEA_REPO_NAME || "booklogr",
	runnerContainer: "sreforge-runner",
	giteaContainer: "sreforge-gitea",
	envPath,
	exampleEnvPath: resolve(STACK, ".env.example"),
	substratePath: resolve(STACK, "substrate/booklogr"), // substrate is stack-local
	coreNodeModulesPath: resolve(REPO_ROOT, "core/node_modules"),
	coreDistPath: resolve(REPO_ROOT, "core/dist"),
	rootNodeModulesPath: resolve(REPO_ROOT, "node_modules"),
	deployServices: DEPLOY_SERVICES,
	prometheusUrl: env.PROM_URL || "http://localhost:9090",
	alertmanagerUrl: "http://localhost:9093",
	deployUpHint: "pnpm forge up booklogr",
	useCase: "booklogr",
	ambientRulesPath: resolve(
		STACK,
		ambientEnv.AMBIENT_RULE_PATH || "observability/rules/ambient-rules.yml",
	),
	ambientAlertName: ambientEnv.AMBIENT_ALERT_NAME || "EdgeClientRequestJitter",
	ambientAlertService: ambientEnv.AMBIENT_ALERT_SERVICE || "edge-client",
	ambientCommitAuthor: ambientEnv.AMBIENT_COMMIT_AUTHOR || "Mozzo1000",
	ambientCommitSubject:
		ambientEnv.AMBIENT_COMMIT_SUBJECT ||
		"refactor(api): normalize response status validation in fields route",
};

const checks = [
	...defineChecks(config),
	{
		id: "agy-preflight",
		plane: "agent",
		run: async () => {
			const res = spawnSync("bash", [resolve(HERE, "preflight-agy.sh"), "--skip-probe"], {
				encoding: "utf8",
			});
			if (res.status === 0) {
				return {
					status: "pass",
					detail: "agy driver preconditions ok (live agy probe not run here)",
				};
			}
			return {
				status: "warn",
				detail: (res.stderr || res.stdout || "preflight-agy.sh failed").trim().split("\n")[0],
				hint: "bash use-cases/booklogr/stacks/flask-compose/scripts/preflight-agy.sh",
			};
		},
	},
];

async function main() {
	const results = await runAllChecks(checks);
	const { lines, exitCode } = summarize(results);
	for (const line of lines) {
		console.log(line);
	}
	process.exit(exitCode);
}

main();
