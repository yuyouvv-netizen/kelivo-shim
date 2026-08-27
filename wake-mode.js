import fs from "fs";
import path from "path";

import { isSingaporeWakeWindow } from "./turn-watchdog.js";

export const WAKE_MODE_DAY = "day";
export const WAKE_MODE_ALWAYS = "always";
export const AUTONOMOUS_WAKE_INSTRUCTION =
  "这轮是留给你自己的。你可以找她，或做一件此刻自己想做的小事：整理记忆、逛花园论坛、调用啵啵鸟等。是否调用工具、是否告诉又又，由你决定。不必为了完成心跳而机械行动，没什么想做的就只回【沉默】。";

export function autonomousWakePrompt({ now, idleUserMin, sinceSpokeMin = null }) {
  const sinceSpoke = Number.isFinite(sinceSpokeMin)
    ? `，你上次主动开口是约 ${Math.round(sinceSpokeMin)} 分钟前`
    : "";
  return `【系统·自主时间】现在新加坡时间 ${now}，她已约 ${Math.round(idleUserMin)} 分钟没有消息${sinceSpoke}。\n\n${AUTONOMOUS_WAKE_INSTRUCTION}`;
}

export function normalizeWakeMode(raw, fallback = WAKE_MODE_DAY) {
  const mode = String(raw || "").trim().toLowerCase();
  return mode === WAKE_MODE_DAY || mode === WAKE_MODE_ALWAYS ? mode : fallback;
}

export function activeHoursForWakeMode(mode) {
  return normalizeWakeMode(mode) === WAKE_MODE_ALWAYS ? "00:00-24:00" : "06:00-24:00";
}

export function wakeModeAllowsNow(mode, nowMs = Date.now()) {
  return normalizeWakeMode(mode) === WAKE_MODE_ALWAYS || isSingaporeWakeWindow(nowMs);
}

export class WakeModeStore {
  constructor({ file, defaultMode = WAKE_MODE_DAY, log = () => {} } = {}) {
    if (!file) throw new Error("wake mode file is required");
    this.file = file;
    this.defaultMode = normalizeWakeMode(defaultMode);
    this.log = log;
    this.mode = this.#load();
  }

  get() {
    return this.mode;
  }

  activeHours() {
    return activeHoursForWakeMode(this.mode);
  }

  allows(nowMs = Date.now()) {
    return wakeModeAllowsNow(this.mode, nowMs);
  }

  set(raw) {
    const mode = normalizeWakeMode(raw, null);
    if (!mode) return { ok: false, status: 400, error: "未知的心跳模式。" };
    try {
      this.#persist(mode);
      this.mode = mode;
      this.log("[wake-mode] changed", mode);
      return { ok: true, mode, activeHoursSingapore: this.activeHours() };
    } catch (error) {
      this.log("[wake-mode] save failed", error?.message || String(error));
      return { ok: false, status: 500, error: "心跳设置没有保存，请稍后再试。" };
    }
  }

  #load() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return normalizeWakeMode(saved?.mode, this.defaultMode);
    } catch {
      return this.defaultMode;
    }
  }

  #persist(mode) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify({ mode, updatedAt: new Date().toISOString() }, null, 2) + "\n", {
        encoding: "utf8",
        mode: 0o600,
      });
      fs.renameSync(temp, this.file);
    } finally {
      try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch {}
    }
  }
}
