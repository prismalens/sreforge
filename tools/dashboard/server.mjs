#!/usr/bin/env node
// Loopback-only dashboard over `task up|down|fault|status`; one command at a time, output streamed over SSE.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const DEFAULT_TASK = ["pnpm", "exec", "task", "--silent"];
const LOG_LIMIT = 5000;

export function createDashboard({ task = DEFAULT_TASK, cwd = REPO_ROOT } = {}) {
  const [bin, ...prefix] = task;
  const clients = new Set();
  let job = null;

  const send = (event, data) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(frame);
  };

  function exec(args, onChunk) {
    return new Promise((ok) => {
      const child = spawn(bin, [...prefix, ...args], { cwd });
      let out = "";
      let err = "";
      child.stdout.on("data", (c) => { out += c; onChunk?.(c.toString()); });
      child.stderr.on("data", (c) => { err += c; onChunk?.(c.toString()); });
      child.on("error", (e) => ok({ code: -1, out, err: `${err}${e.message}\n` }));
      child.on("close", (code) => ok({ code, out, err }));
    });
  }

  async function status() {
    const { code, out, err } = await exec(["status", "--", "--json"]);
    if (code !== 0) throw new Error(`task status exited ${code}: ${err.trim() || out.trim()}`);
    try {
      return JSON.parse(out);
    } catch {
      throw new Error(`task status did not print JSON: ${out.slice(0, 200)}`);
    }
  }

  const jobView = () => job && { label: job.label, running: !job.done, code: job.code, startedAt: job.startedAt };

  function log(line) {
    job.log.push(line);
    if (job.log.length > LOG_LIMIT) job.log.shift();
    send("line", { line });
  }

  async function runSteps(steps) {
    let code = 0;
    for (const args of steps) {
      log(`$ task ${args.join(" ")}\n`);
      ({ code } = await exec(args, log));
      if (code !== 0) break;
    }
    job.done = true;
    job.code = code;
    send("done", jobView());
  }

  async function start({ action, scenario, on }) {
    if (job && !job.done) return [409, { error: `Busy: "${job.label}" is still running. Wait for it to finish.` }];
    if (!["up", "down", "fault"].includes(action)) return [400, { error: `Unknown action "${action}".` }];
    const label = action === "fault" ? `fault ${scenario} ${on ? "on" : "off"}` : action;
    job = { label, log: [], done: false, code: null, startedAt: new Date().toISOString() };

    let steps = [[action]];
    if (action === "fault") {
      let s;
      try {
        s = await status();
      } catch (e) {
        job = null;
        return [502, { error: e.message }];
      }
      if (!s.scenarios?.some((x) => x.id === scenario)) {
        job = null;
        return [400, { error: `Unknown scenario "${scenario}".` }];
      }
      const current = s.fault?.scenario;
      steps = [["fault", "--", scenario, on ? "on" : "off"]];
      if (on && current && current !== scenario) steps.unshift(["fault", "--", current, "off"]);
    }
    send("start", jobView());
    runSteps(steps);
    return [202, jobView()];
  }

  const json = (res, code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const readBody = (req) => new Promise((ok) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => ok(b));
  });

  return createServer(async (req, res) => {
    const { pathname } = new URL(req.url, "http://localhost");
    try {
      if (pathname === "/" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(await readFile(join(HERE, "index.html")));
      } else if (pathname === "/api/status" && req.method === "GET") {
        try {
          json(res, 200, { ...(await status()), job: jobView() });
        } catch (e) {
          json(res, 502, { error: e.message, job: jobView() });
        }
      } else if (pathname === "/api/run" && req.method === "POST") {
        let body;
        try {
          body = JSON.parse((await readBody(req)) || "{}");
        } catch {
          return json(res, 400, { error: "Body must be JSON." });
        }
        const [code, out] = await start(body);
        json(res, code, out);
      } else if (pathname === "/api/log" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        if (job) {
          res.write(`event: start\ndata: ${JSON.stringify(jobView())}\n\n`);
          for (const line of job.log) res.write(`event: line\ndata: ${JSON.stringify({ line })}\n\n`);
          if (job.done) res.write(`event: done\ndata: ${JSON.stringify(jobView())}\n\n`);
        }
        clients.add(res);
        req.on("close", () => clients.delete(res));
      } else {
        json(res, 404, { error: "Not found." });
      }
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 7420);
  createDashboard().listen(port, "127.0.0.1", () => {
    console.log(`sreforge dashboard: http://127.0.0.1:${port}`);
  });
}
