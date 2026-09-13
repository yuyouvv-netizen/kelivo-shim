import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_STATUS_FILE } from "./status.js";

const DEFAULT_FILES = [".mcp.json", "/persona/.mcp.json"];
const DEFAULT_SCRIPT = fileURLToPath(new URL("./status-mcp.js", import.meta.url));

function writeJsonAtomic(file, value) {
  const next = JSON.stringify(value, null, 2) + "\n";
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === next) {
    if ((fs.statSync(file).mode & 0o777) === 0o600) return false;
    fs.chmodSync(file, 0o600);
    return true;
  }
  const dir = path.dirname(file);
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

export function configureStatusMcp({
  env = process.env,
  files = DEFAULT_FILES,
  script = DEFAULT_SCRIPT,
} = {}) {
  const statusFile = String(env.STATUS_FILE || DEFAULT_STATUS_FILE).trim();
  if (!path.isAbsolute(statusFile)) throw new Error("STATUS_FILE must be absolute");
  if (!path.isAbsolute(script)) throw new Error("status MCP script path must be absolute");

  const [runtimeFile, ...persistentFiles] = files;
  if (!runtimeFile || !fs.existsSync(runtimeFile)) {
    throw new Error("runtime MCP config is missing");
  }
  const entry = {
    command: "node",
    args: [script],
    env: { STATUS_FILE: statusFile },
  };
  const updatedFiles = [];
  const update = (file, fallback) => {
    const current = fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, "utf8"))
      : structuredClone(fallback);
    current.mcpServers ||= {};
    current.mcpServers.status = entry;
    if (writeJsonAtomic(file, current)) updatedFiles.push(file);
    return current;
  };

  const runtimeConfig = update(runtimeFile);
  for (const file of persistentFiles) {
    if (fs.existsSync(file) || fs.existsSync(path.dirname(file))) {
      update(file, runtimeConfig);
    }
  }
  return { configured: true, updatedFiles };
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile && fileURLToPath(import.meta.url) === invokedFile) {
  try {
    configureStatusMcp();
    console.log("[entrypoint] status MCP configured");
  } catch {
    console.error("[entrypoint] ERROR: could not configure status MCP");
    process.exitCode = 1;
  }
}
