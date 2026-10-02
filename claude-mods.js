import fs from "fs";
import path from "path";

export const DEFAULT_CLAUDE_MOD_PROBE_FILE = "/tmp/kelivo-claude-mod-probe.json";

export function claudeModsSupported(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version || ""));
  if (!match) return false;
  const [, majorText, minorText, patchText] = match;
  const major = Number(majorText);
  const minor = Number(minorText);
  const patch = Number(patchText);
  return major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 287)));
}

export function withClaudeModProbe(env, {
  enabled = false,
  pluginDir,
  delimiter = path.delimiter,
} = {}) {
  const next = { ...env };
  if (!enabled || !pluginDir) return next;

  const dirs = String(next.CLAUDE_CODE_PLUGIN_DIRS || "")
    .split(delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
  if (!dirs.includes(pluginDir)) dirs.push(pluginDir);
  next.CLAUDE_CODE_PLUGIN_DIRS = dirs.join(delimiter);
  return next;
}

export function readClaudeModProbe(file = DEFAULT_CLAUDE_MOD_PROBE_FILE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function clearClaudeModProbe(file = DEFAULT_CLAUDE_MOD_PROBE_FILE) {
  try {
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}
