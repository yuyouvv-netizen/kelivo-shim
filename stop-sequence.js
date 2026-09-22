import fs from "fs";
import path from "path";

import { validSessionId } from "./session-state.js";

export const DEFAULT_STOP_SEQUENCE = "user[消息时间";
export const STOP_SEQUENCE_NOTICE_MARKER = "<!-- kelivo:stop-sequence-notice -->";
export const STOP_SEQUENCE_NOTICE =
  `⚠️〔异常续写已拦截〕这一轮没有可安全显示的正文，原生会话仍保留。${STOP_SEQUENCE_NOTICE_MARKER}`;

export function isStopSequenceNotice(value) {
  return typeof value === "string" && value.includes(STOP_SEQUENCE_NOTICE_MARKER);
}

export function stopSequenceFromEnv(value) {
  if (value === undefined) return DEFAULT_STOP_SEQUENCE;
  const text = String(value);
  if (!text.trim() || text.trim() === "0") return null;
  return text;
}

export function withStopSequenceExtraBody(raw, sequence) {
  const text = String(raw || "").trim();
  let body = {};
  if (text) {
    body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("CLAUDE_CODE_EXTRA_BODY must be a JSON object");
    }
  }
  if (!sequence) return text || "";
  if (body.stop_sequences !== undefined && !Array.isArray(body.stop_sequences)) {
    throw new Error("CLAUDE_CODE_EXTRA_BODY.stop_sequences must be an array");
  }
  const existing = (body.stop_sequences || []).filter((item) => typeof item === "string" && item);
  body.stop_sequences = [...new Set([...existing, sequence])];
  return JSON.stringify(body);
}

const EMPTY = Object.freeze({ tracked: false, count: 0, lastAt: null });

export class StopSequenceStateStore {
  constructor({ file, log = () => {} } = {}) {
    if (!file) throw new Error("stop sequence state file is required");
    this.file = file;
    this.log = log;
    this.state = this.#load();
  }

  forSession(sessionId) {
    if (!validSessionId(sessionId) || this.state?.sessionId !== sessionId) return { ...EMPTY };
    return {
      tracked: true,
      count: Math.max(0, Math.trunc(Number(this.state.count) || 0)),
      lastAt: typeof this.state.lastAt === "string" ? this.state.lastAt : null,
    };
  }

  recordHit(sessionId) {
    if (!validSessionId(sessionId)) return { ...EMPTY, persisted: false };
    const current = this.forSession(sessionId);
    const next = {
      version: 1,
      sessionId,
      count: current.count + 1,
      lastAt: new Date().toISOString(),
    };
    this.state = next;

    const dir = path.dirname(this.file);
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(temp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
      fs.renameSync(temp, this.file);
      return { tracked: true, count: next.count, lastAt: next.lastAt, persisted: true };
    } catch (error) {
      this.log("[stop-sequence] state save failed", error?.message || String(error));
      try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch {}
      return { tracked: true, count: next.count, lastAt: next.lastAt, persisted: false };
    }
  }

  #load() {
    try {
      const state = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (state?.version !== 1 || !validSessionId(state.sessionId)) return null;
      return state;
    } catch {
      return null;
    }
  }
}
