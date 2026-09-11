import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_FILES = [".mcp.json", "/persona/.mcp.json"];

function browserEntryFromEnv(env) {
  const rawUrl = String(env.BROWSER_MCP_URL || "").trim();
  const token = String(env.BROWSER_MCP_TOKEN || "").trim();

  if (!rawUrl && !token) return null;
  if (!rawUrl || !token) {
    throw new Error("BROWSER_MCP_URL and BROWSER_MCP_TOKEN must be set together");
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("BROWSER_MCP_URL must be a valid URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("BROWSER_MCP_URL must use https");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("BROWSER_MCP_URL must not contain credentials, query parameters, or a fragment");
  }
  if (parsed.pathname.replace(/\/+$/, "") !== "/mcp") {
    throw new Error("BROWSER_MCP_URL must point to /mcp");
  }

  return {
    type: "http",
    url: rawUrl,
    headers: { "X-Token": token },
  };
}

function writeJsonAtomic(file, value) {
  const next = JSON.stringify(value, null, 2) + "\n";
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === next) return false;

  const dir = path.dirname(file);
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600;
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temp, next, { mode });
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
  return true;
}

export function configureBrowserMcp({
  env = process.env,
  files = DEFAULT_FILES,
} = {}) {
  const entry = browserEntryFromEnv(env);
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
    current.mcpServers.browser = entry;
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
    const result = configureBrowserMcp();
    if (result.configured) console.log("[entrypoint] browser MCP configured");
  } catch {
    console.error("[entrypoint] ERROR: invalid browser MCP settings or MCP config");
    process.exitCode = 1;
  }
}
