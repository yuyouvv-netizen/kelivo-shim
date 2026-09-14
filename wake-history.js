import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const DEFAULT_WAKE_HISTORY_FILE = "/persona/wake-history.json";
export const DEFAULT_WAKE_HISTORY_LIMIT = 3;

const FINAL_STATUSES = new Set([
  "silent",
  "spoke",
  "completed",
  "interrupted",
  "timeout",
  "process-exit",
  "service-restarted",
  "upstream-error",
  "empty-result",
]);

function cleanToolName(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 160);
}

function validIso(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function sanitizeRun(value) {
  if (!value || typeof value !== "object" || !validIso(value.startedAt)) return null;
  const tools = Array.isArray(value.tools)
    ? [...new Set(value.tools.map(cleanToolName).filter(Boolean))].slice(0, 64)
    : [];
  const status = value.status === "running" || FINAL_STATUSES.has(value.status)
    ? value.status
    : "completed";
  return {
    id: typeof value.id === "string" && value.id ? value.id.slice(0, 100) : randomUUID(),
    startedAt: new Date(value.startedAt).toISOString(),
    completedAt: validIso(value.completedAt) ? new Date(value.completedAt).toISOString() : null,
    status,
    tools,
  };
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temp, file);
    fs.chmodSync(file, 0o600);
  } finally {
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch {}
  }
}

export class WakeHistoryStore {
  constructor({
    file = DEFAULT_WAKE_HISTORY_FILE,
    limit = DEFAULT_WAKE_HISTORY_LIMIT,
    now = () => Date.now(),
  } = {}) {
    if (!file) throw new Error("wake history file is required");
    this.file = file;
    this.limit = Math.max(1, Math.min(20, Math.trunc(Number(limit) || DEFAULT_WAKE_HISTORY_LIMIT)));
    this.now = now;
    this.runs = this.#load();
  }

  list() {
    return this.runs.map((run) => ({ ...run, tools: [...run.tools] }));
  }

  start() {
    const record = {
      id: randomUUID(),
      startedAt: new Date(this.now()).toISOString(),
      completedAt: null,
      status: "running",
      tools: [],
    };
    this.runs = [record, ...this.runs].slice(0, this.limit);
    this.#persist();
    return { ...record, tools: [] };
  }

  addTool(id, value) {
    const tool = cleanToolName(value);
    const record = this.runs.find((run) => run.id === id);
    if (!record || !tool || record.tools.includes(tool)) return false;
    record.tools.push(tool);
    record.tools = record.tools.slice(0, 64);
    this.#persist();
    return true;
  }

  finish(id, status = "completed") {
    const record = this.runs.find((run) => run.id === id);
    if (!record || record.status !== "running") return false;
    record.status = FINAL_STATUSES.has(status) ? status : "completed";
    record.completedAt = new Date(this.now()).toISOString();
    this.#persist();
    return true;
  }

  recoverIncomplete() {
    let changed = false;
    for (const record of this.runs) {
      if (record.status !== "running") continue;
      record.status = "service-restarted";
      record.completedAt = new Date(this.now()).toISOString();
      changed = true;
    }
    if (changed) this.#persist();
    return changed;
  }

  #load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (parsed?.version !== 1 || !Array.isArray(parsed.runs)) return [];
      return parsed.runs.map(sanitizeRun).filter(Boolean).slice(0, this.limit);
    } catch {
      return [];
    }
  }

  #persist() {
    writeJsonAtomic(this.file, { version: 1, runs: this.runs });
  }
}
