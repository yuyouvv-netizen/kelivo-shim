import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_FILES = [".mcp.json", "/persona/.mcp.json"];
const FISH_URL_REFERENCE = "${FISHING_MCP_URL}";
const FISH_TOKEN_REFERENCE = "${FISHING_MCP_TOKEN}";

function fishEntryFromEnv(env) {
  const rawUrl = String(env.FISHING_MCP_URL || "").trim();
  const token = String(env.FISHING_MCP_TOKEN || "").trim();

  if (!rawUrl && !token) return null;
  if (!rawUrl || !token) {
    throw new Error("FISHING_MCP_URL and FISHING_MCP_TOKEN must be set together");
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("FISHING_MCP_URL must be a valid URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("FISHING_MCP_URL must use https");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("FISHING_MCP_URL must not contain credentials, query parameters, or a fragment");
  }
  if (parsed.pathname.replace(/\/+$/, "") !== "/mcp") {
    throw new Error("FISHING_MCP_URL must point to /mcp");
  }

  return {
    type: "http",
    // Claude Code resolves these references from the process environment.
    // The real endpoint and token never need to be persisted to disk.
    url: FISH_URL_REFERENCE,
    headers: { "X-Token": FISH_TOKEN_REFERENCE },
  };
}

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
    fs.writeFileSync(temp, next, { mode: 0o600 });
    fs.renameSync(temp, file);
    fs.chmodSync(file, 0o600);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
  return true;
}

export function configureFishMcp({
  env = process.env,
  files = DEFAULT_FILES,
} = {}) {
  const entry = fishEntryFromEnv(env);
  if (!entry) return { configured: false, updatedFiles: [] };

  const [runtimeFile, ...persistentFiles] = files;
  if (!runtimeFile || !fs.existsSync(runtimeFile)) {
    throw new Error("runtime MCP config is missing");
  }

  const updatedFiles = [];
  const update = (file, fallback) => {
    const current = fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, "utf8"))
      : structuredClone(fallback);
    current.mcpServers ||= {};
    current.mcpServers.fish = entry;
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
    const result = configureFishMcp();
    if (result.configured) console.log("[entrypoint] fish MCP configured");
  } catch {
    console.error("[entrypoint] ERROR: invalid fish MCP settings or MCP config");
    process.exitCode = 1;
  }
}
