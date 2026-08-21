import fs from "fs";
import path from "path";

export const DEFAULT_IMPORT_DIR = "/persona/import-history";

function textOf(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("")
    .trim();
}

export function normalizeImportedMessages(input) {
  const raw = Array.isArray(input) ? input : input?.messages;
  if (!Array.isArray(raw)) throw new Error("messages must be an array");
  const messages = raw
    .filter((m) => m && (m.role === "user" || m.role === "assistant"))
    .map((m) => ({ role: m.role, content: textOf(m.content) }))
    .filter((m) => m.content);
  if (messages.length < 2) throw new Error("need at least two non-empty user/assistant messages");
  return messages;
}

export function mergeImportedMessages(imported, current) {
  const now = Array.isArray(current) ? current : [];
  return [...normalizeImportedMessages(imported), ...now];
}

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function jsonRead(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}
function jsonWrite(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export class ImportHistoryStore {
  constructor({ dir = DEFAULT_IMPORT_DIR, sessionStateFile = "/persona/claude-state/shim-session.json" } = {}) {
    this.dir = dir;
    this.pendingFile = path.join(dir, "pending.json");
    this.statusFile = path.join(dir, "status.json");
    this.sessionStateFile = sessionStateFile;
    this.preImportSessionFile = path.join(dir, "pre-import-session.json");
  }

  status() {
    const pending = this.loadPending();
    const last = jsonRead(this.statusFile) || {};
    return {
      state: pending ? "pending" : (last.state || "empty"),
      messages: pending?.messages?.length ?? last.messages ?? 0,
      chars: pending?.chars ?? last.chars ?? 0,
      createdAt: pending?.createdAt ?? last.createdAt ?? null,
      consumedAt: last.consumedAt ?? null,
      source: pending?.source ?? last.source ?? null,
    };
  }

  loadPending() { return jsonRead(this.pendingFile); }

  prepare(payload) {
    const messages = normalizeImportedMessages(payload);
    const chars = messages.reduce((n, m) => n + m.content.length, 0);
    const record = {
      version: 1,
      source: String(payload?.source || "claude-share").slice(0, 80),
      createdAt: new Date().toISOString(),
      messages,
      chars,
    };
    ensureDir(this.dir);
    if (fs.existsSync(this.sessionStateFile)) {
      fs.copyFileSync(this.sessionStateFile, this.preImportSessionFile);
      fs.unlinkSync(this.sessionStateFile);
    }
    jsonWrite(this.pendingFile, record);
    jsonWrite(this.statusFile, {
      state: "pending", messages: messages.length, chars,
      createdAt: record.createdAt, consumedAt: null, source: record.source,
    });
    return this.status();
  }

  consume() {
    const pending = this.loadPending();
    if (!pending) return null;
    try { fs.unlinkSync(this.pendingFile); } catch {}
    jsonWrite(this.statusFile, {
      state: "consumed", messages: pending.messages.length, chars: pending.chars,
      createdAt: pending.createdAt, consumedAt: new Date().toISOString(), source: pending.source,
    });
    return pending;
  }

  clear() {
    try { fs.unlinkSync(this.pendingFile); } catch {}
    jsonWrite(this.statusFile, { state: "cleared", messages: 0, chars: 0,
      createdAt: null, consumedAt: null, source: null });
    return this.status();
  }
}
