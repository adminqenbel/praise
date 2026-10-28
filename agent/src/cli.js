#!/usr/bin/env node
// Command line: pair the agent with a Praise account, show its status, print the bearer token for wiring the extension.
// The device token is read from a file or stdin only (an argv value would end up in shell history and the process list).
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const { resolveDirs, filesIn } = require("./paths");
const { loadConfig, saveConfigPatch, normalizeApiOrigin, EXTENSION_ORIGIN_RE } = require("./config");
const secrets = require("./secrets");
const store = require("./store");

const USAGE = `Usage: node src/cli.js <command>

  run                                  start the agent (same as node src/server.js)
  configure --api <origin> (--token-file <path> | --token-stdin)
            [--port <n>] [--allow-origin chrome-extension://<id>]...
                                       pair with a Praise account; the device token is never taken from argv
  status                               configuration, pairing and policy state (no secrets are printed)
  token                                print the agent bearer token (paste it into the extension / tool)
  rotate-token                         replace the agent bearer token (restart the agent afterwards)
  unpair                               forget the device token
`;

function parseFlags(args) {
  const flags = { allowOrigin: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const need = () => { if (i + 1 >= args.length) throw new Error(`${a} needs a value`); return args[++i]; };
    if (a === "--api") flags.api = need();
    else if (a === "--token-file") flags.tokenFile = need();
    else if (a === "--token-stdin") flags.tokenStdin = true;
    else if (a === "--port") flags.port = need();
    else if (a === "--allow-origin") flags.allowOrigin.push(need());
    else if (a === "--token" || a.startsWith("--token=")) throw new Error("the device token is not accepted on the command line; use --token-file <path> or --token-stdin");
    else throw new Error(`unknown option: ${a}`);
  }
  return flags;
}

function getJson(port, token, urlPath) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: urlPath, headers: { Authorization: "Bearer " + token }, timeout: 1500 }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => { try { resolve({ status: res.statusCode, data: JSON.parse(body) }); } catch (e) { resolve(null); } });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

async function runCli(argv, io = {}) {
  const out = io.stdout || ((s) => process.stdout.write(s));
  const err = io.stderr || ((s) => process.stderr.write(s));
  const dirs = io.dirs || resolveDirs(io.env || process.env);
  const files = filesIn(dirs);
  const harden = io.harden !== false;
  const [cmd, ...rest] = argv;

  try {
    switch (cmd) {
      case "run": case "start": {
        await require("./server").main();
        return 0;
      }
      case "configure": {
        const f = parseFlags(rest);
        if (!f.api && !f.tokenFile && !f.tokenStdin && !f.port && !f.allowOrigin.length) throw new Error("nothing to configure; see usage");
        const patch = {};
        if (f.api) {
          const origin = normalizeApiOrigin(f.api);
          if (!origin) throw new Error("--api must be an https origin (http is accepted only for localhost)");
          patch.api = origin;
        }
        if (f.port !== undefined) {
          const p = Number(f.port);
          if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error("--port must be 1..65535");
          patch.port = p;
        }
        if (f.allowOrigin.length) {
          for (const o of f.allowOrigin) if (!EXTENSION_ORIGIN_RE.test(o)) throw new Error("--allow-origin must look like chrome-extension://<32 letters a-p>");
          const cur = loadConfig(files.config).allowed_origins;
          patch.allowed_origins = [...new Set([...cur, ...f.allowOrigin])];
        }
        let deviceToken = null;
        if (f.tokenFile || f.tokenStdin) {
          const raw = f.tokenStdin || f.tokenFile === "-"
            ? (io.readStdin ? io.readStdin() : fs.readFileSync(0, "utf8"))
            : fs.readFileSync(f.tokenFile, "utf8");
          deviceToken = String(raw).trim();
          if (!secrets.validDeviceToken(deviceToken)) throw new Error("the token file does not contain a valid device token");
          if (!patch.api && !loadConfig(files.config).api) throw new Error("--api is required when pairing");
        }
        secrets.ensureDir(dirs.configDir, { harden });
        if (deviceToken) secrets.writeDeviceToken(files.deviceToken, deviceToken, { harden });
        saveConfigPatch(files.config, patch);
        out(`Saved. ${deviceToken ? "Device token stored (not shown). " : ""}Running agents pick this up on their next sync; run "node src/cli.js status" to check.\n`);
        return 0;
      }
      case "token": {
        secrets.ensureDir(dirs.configDir, { harden });
        out(secrets.loadOrCreateAgentToken(files.agentToken, { harden }) + "\n");
        return 0;
      }
      case "rotate-token": {
        secrets.rotateAgentToken(files.agentToken, { harden });
        out('Agent token replaced. Restart the agent, then update the extension with "node src/cli.js token".\n');
        return 0;
      }
      case "unpair": {
        try { fs.unlinkSync(files.deviceToken); } catch (e) { /* not paired */ }
        out("Device token removed. The agent keeps enforcing its last policy snapshot until it is replaced.\n");
        return 0;
      }
      case "status": {
        const cfg = loadConfig(files.config);
        const lines = [
          `config dir      ${dirs.configDir}`,
          `state dir       ${dirs.stateDir}`,
          `api             ${cfg.api}`,
          `paired          ${secrets.readDeviceToken(files.deviceToken) ? "yes" : "no"}`,
          `agent token     ${secrets.readAgentToken(files.agentToken) ? "present" : "not created yet (run: token)"}`,
          `allowed origins ${cfg.allowed_origins.length ? cfg.allowed_origins.join(", ") : "(none)"}`,
        ];
        const snap = store.loadSnapshot(files.snapshot);
        lines.push(`saved policy    ${snap.status === "ok" ? `yes (${snap.snapshot.mode}, fetched ${snap.fetchedAt ? new Date(snap.fetchedAt).toISOString() : "?"})` : snap.status}`);
        const rt = store.readJsonSafe(files.runtime).data;
        const agentToken = secrets.readAgentToken(files.agentToken);
        let live = null;
        if (rt && rt.port && agentToken) live = await getJson(rt.port, agentToken, "/v1/health");
        if (live && live.status === 200) {
          const h = live.data;
          lines.push(`running         yes (pid ${rt.pid}, 127.0.0.1:${rt.port}, v${h.version}, detect v${h.detect_version})`);
          lines.push(`live policy     ${h.policy.loaded ? `${h.policy.version} (${h.policy.mode})` : "none"}${h.policy.revoked ? ", device token REVOKED" : ""}${h.policy.offline ? ", offline" : ""}`);
        } else lines.push("running         no");
        out(lines.join("\n") + "\n");
        return 0;
      }
      default:
        (cmd === undefined || cmd === "help" || cmd === "--help" ? out : err)(USAGE);
        return cmd === undefined || cmd === "help" || cmd === "--help" ? 0 : 2;
    }
  } catch (e) {
    err(`error: ${e.message}\n`);
    return 1;
  }
}

if (require.main === module) runCli(process.argv.slice(2)).then((code) => { if (process.argv[2] !== "run" && process.argv[2] !== "start") process.exit(code); });

module.exports = { runCli, parseFlags };
