import fs from "node:fs";
import path from "node:path";

function validText(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

export function loadFreshSessionState(file) {
  if (!file) return null;
  try {
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    if (state?.version !== 1) return null;
    if (!validText(state.model, 256) || !validText(state.effort, 32)) return null;
    if (typeof state.system !== "string" || state.system.length > 2_000_000) return null;
    return {
      model: state.model,
      effort: state.effort,
      system: state.system,
      requestedAt: typeof state.requestedAt === "string" ? state.requestedAt : null,
    };
  } catch {
    return null;
  }
}

export function saveFreshSessionState(file, { model, effort, system = "" } = {}) {
  if (!file || !validText(model, 256) || !validText(effort, 32) ||
      typeof system !== "string" || system.length > 2_000_000) return false;
  const dir = path.dirname(file);
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temp, JSON.stringify({
      version: 1,
      model,
      effort,
      system,
      requestedAt: new Date().toISOString(),
    }, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temp, file);
    return true;
  } catch {
    try { fs.unlinkSync(temp); } catch {}
    return false;
  }
}

export function clearFreshSessionState(file) {
  if (!file) return true;
  try { fs.unlinkSync(file); return true; }
  catch (error) { return error?.code === "ENOENT"; }
}
