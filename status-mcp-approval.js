import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const STATUS_MCP_SERVER_NAME = "status";

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];
}

function writeJsonAtomic(file, value) {
  const next = JSON.stringify(value, null, 2) + "\n";
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === next) {
    if ((fs.statSync(file).mode & 0o777) === 0o600) return false;
    fs.chmodSync(file, 0o600);
    return true;
  }
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temp, next, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, file);
    fs.chmodSync(file, 0o600);
  } finally {
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch {}
  }
  return true;
}

export function approveStatusMcp({
  env = process.env,
  settingsFile,
  serverName = STATUS_MCP_SERVER_NAME,
} = {}) {
  const configDir = String(
    env.CLAUDE_CONFIG_DIR || path.join(env.HOME || "/root", ".claude"),
  ).trim();
  const file = settingsFile || path.join(configDir, "settings.json");
  if (!path.isAbsolute(file)) throw new Error("Claude settings path must be absolute");

  let settings = {};
  if (fs.existsSync(file)) {
    settings = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      throw new Error("Claude settings must contain a JSON object");
    }
  }

  const enabled = Array.isArray(settings.enabledMcpjsonServers)
    ? settings.enabledMcpjsonServers
    : [];
  settings.enabledMcpjsonServers = uniqueStrings([...enabled, serverName]);

  if (Array.isArray(settings.disabledMcpjsonServers)) {
    settings.disabledMcpjsonServers = uniqueStrings(
      settings.disabledMcpjsonServers.filter((name) => name !== serverName),
    );
  }

  return {
    approved: true,
    updated: writeJsonAtomic(file, settings),
    settingsFile: file,
  };
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile && fileURLToPath(import.meta.url) === invokedFile) {
  try {
    approveStatusMcp();
    console.log("[entrypoint] status MCP approved");
  } catch {
    console.error("[entrypoint] ERROR: could not approve status MCP");
    process.exitCode = 1;
  }
}
