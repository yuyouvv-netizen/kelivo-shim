import fs from "fs";
import path from "path";
import { createHash, randomUUID } from "crypto";

// Completed replies are kept only long enough for a genuine transport
// reconnect. A later identical message should be treated as a fresh user turn.
export const DEFAULT_MAILBOX_TTL_MS = 3 * 60 * 1000;
export const DEFAULT_MAILBOX_MAX = 5;
const MAX_EVENT_COUNT = 80;
const MAX_EVENT_TEXT = 4000;
const MAX_RECOVERY_TEXT = 12000;
const MAX_MAILBOX_TEXT = 240000;

function atomicWrite(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temp, file);
    return true;
  } catch {
    try { fs.unlinkSync(temp); } catch {}
    return false;
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}

function clipped(value, max = MAX_EVENT_TEXT) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return text.length > max ? text.slice(0, max) + "…" : text;
}

export function requestFingerprint({ messages, system, model, effort }) {
  const normalized = [...(messages || [])];
  // A manual resend can leave two identical user messages at the tail. Treat
  // that as the same transport attempt until an assistant reply intervenes.
  while (normalized.length >= 2) {
    const last = normalized.at(-1), previous = normalized.at(-2);
    if (last?.role !== "user" || previous?.role !== "user" ||
        JSON.stringify(last.content) !== JSON.stringify(previous.content)) break;
    normalized.pop();
  }
  return createHash("sha256").update(JSON.stringify({
    model: model || "", effort: effort || "", system: system || "", messages: normalized,
  })).digest("hex");
}

export class TurnStateStore {
  constructor({
    dir,
    mailboxTtlMs = DEFAULT_MAILBOX_TTL_MS,
    mailboxMax = DEFAULT_MAILBOX_MAX,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  }) {
    this.dir = dir;
    this.currentFile = path.join(dir, "current-turn.json");
    this.mailboxFile = path.join(dir, "mailbox.json");
    this.mailboxTtlMs = mailboxTtlMs;
    this.mailboxMax = mailboxMax;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.current = readJson(this.currentFile, null);
    this.mailbox = readJson(this.mailboxFile, []);
    if (!Array.isArray(this.mailbox)) this.mailbox = [];
    this.flushTimer = null;
    this.#pruneMailbox();
  }

  begin({ requestKey, source, input, model, sessionId }) {
    this.flush();
    this.current = {
      version: 1,
      turnId: randomUUID(),
      requestKey: requestKey || null,
      source: source || "unknown",
      model: model || null,
      sessionId: sessionId || null,
      status: "active",
      startedAt: new Date(this.now()).toISOString(),
      updatedAt: new Date(this.now()).toISOString(),
      input: clipped(input, MAX_RECOVERY_TEXT),
      responseText: "",
      events: [],
    };
    this.#persistCurrent();
    return this.current.turnId;
  }

  event(type, data = {}) {
    if (!this.current) return;
    const event = { at: new Date(this.now()).toISOString(), type };
    for (const [key, value] of Object.entries(data)) {
      event[key] = typeof value === "string" ? clipped(value) : value;
    }
    this.current.events.push(event);
    this.current.events = this.current.events.slice(-MAX_EVENT_COUNT);
    this.current.updatedAt = event.at;
    this.#persistCurrent();
  }

  updateResponse(text) {
    if (!this.current) return;
    this.current.responseText = clipped(text, MAX_RECOVERY_TEXT);
    this.current.updatedAt = new Date(this.now()).toISOString();
    if (this.flushTimer !== null) return;
    this.flushTimer = this.setTimer(() => {
      this.flushTimer = null;
      this.#persistCurrent();
    }, 500);
    this.flushTimer?.unref?.();
  }

  mark(status, extra = {}) {
    if (!this.current) return;
    this.current.status = status;
    Object.assign(this.current, extra);
    this.current.updatedAt = new Date(this.now()).toISOString();
    this.#persistCurrent();
  }

  complete({ requestKey, fullText, usage, delivered, replayable = true, status = "completed" }) {
    if (!this.current) return;
    this.current.status = status;
    this.current.responseText = clipped(fullText || "", MAX_RECOVERY_TEXT);
    this.current.delivered = !!delivered;
    this.current.completedAt = new Date(this.now()).toISOString();
    this.current.updatedAt = this.current.completedAt;
    this.#persistCurrent();
    if (replayable && requestKey && fullText) {
      this.mailbox = this.mailbox.filter((entry) => entry.requestKey !== requestKey);
      this.mailbox.push({
        requestKey,
        fullText: clipped(fullText, MAX_MAILBOX_TEXT),
        usage: usage || null,
        wasDelivered: !!delivered,
        createdAt: this.now(),
      });
      this.#pruneMailbox();
      this.#persistMailbox();
    }
  }

  findReplay(requestKey) {
    this.#pruneMailbox();
    return this.mailbox.find((entry) => entry.requestKey === requestKey) || null;
  }

  markReplayed(requestKey) {
    const before = this.mailbox.length;
    this.mailbox = this.mailbox.filter((entry) => entry.requestKey !== requestKey);
    if (this.mailbox.length !== before) this.#persistMailbox();
  }

  flush() {
    if (this.flushTimer !== null) this.clearTimer(this.flushTimer);
    this.flushTimer = null;
    this.#persistCurrent();
    this.#persistMailbox();
  }

  debug() {
    this.#pruneMailbox();
    return {
      currentStatus: this.current?.status || null,
      currentTurnId: this.current?.turnId?.slice(-8) || null,
      cachedReplies: this.mailbox.length,
      mailboxTtlMs: this.mailboxTtlMs,
    };
  }

  #pruneMailbox() {
    const cutoff = this.now() - this.mailboxTtlMs;
    this.mailbox = this.mailbox
      .filter((entry) => Number(entry.createdAt) > cutoff)
      .slice(-this.mailboxMax);
  }

  #persistCurrent() {
    if (this.current) atomicWrite(this.currentFile, this.current);
  }

  #persistMailbox() {
    atomicWrite(this.mailboxFile, this.mailbox);
  }
}
