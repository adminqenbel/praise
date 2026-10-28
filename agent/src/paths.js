// Where the agent keeps its files. Config (non-secret settings and both tokens) and state (policy snapshot, decision cache) live in
// per-user directories, never in the repository and never in a shared location. PRAISE_AGENT_HOME overrides both (tests, portable installs).
"use strict";

const os = require("node:os");
const path = require("node:path");

// Pure: takes env/platform/home so every OS layout can be tested from any machine.
function resolveDirs(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.PRAISE_AGENT_HOME) {
    const base = path.resolve(env.PRAISE_AGENT_HOME);
    return { configDir: base, stateDir: path.join(base, "state") };
  }
  if (platform === "win32") {
    const roaming = env.APPDATA || path.win32.join(home, "AppData", "Roaming");
    const local = env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local");
    return { configDir: path.win32.join(roaming, "Praise", "agent"), stateDir: path.win32.join(local, "Praise", "agent") };
  }
  if (platform === "darwin") {
    const base = path.posix.join(home, "Library", "Application Support", "Praise", "agent");
    return { configDir: base, stateDir: path.posix.join(base, "state") };
  }
  const cfg = env.XDG_CONFIG_HOME || path.posix.join(home, ".config");
  const state = env.XDG_STATE_HOME || path.posix.join(home, ".local", "state");
  return { configDir: path.posix.join(cfg, "praise-agent"), stateDir: path.posix.join(state, "praise-agent") };
}

function filesIn(dirs) {
  return {
    config: path.join(dirs.configDir, "config.json"),
    agentToken: path.join(dirs.configDir, "agent-token"),     // bearer token the extension / tools present to the agent
    deviceToken: path.join(dirs.configDir, "device-token"),   // token the agent presents to the Praise API; separate file on purpose
    snapshot: path.join(dirs.stateDir, "policy.json"),
    cache: path.join(dirs.stateDir, "cache.json"),
    runtime: path.join(dirs.stateDir, "runtime.json"),        // pid + port of a running agent, for `status`
  };
}

module.exports = { resolveDirs, filesIn };
