export const DEFAULT_TURN_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_COMPACT_TURN_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_COMPACT_WATCHDOG_PCT = 95;
export const MIN_TURN_TIMEOUT_MS = 30 * 1000;
export const MAX_TURN_TIMEOUT_MS = 30 * 60 * 1000;
// Continuity is more valuable than rescuing one reply quickly. After asking
// Claude Code to interrupt only the current turn, give the resident process a
// full minute to settle and flush its native session before a hard restart.
export const DEFAULT_INTERRUPT_GRACE_MS = 60 * 1000;
export const MIN_INTERRUPT_GRACE_MS = 1000;
export const MAX_INTERRUPT_GRACE_MS = 5 * 60 * 1000;
export const SINGAPORE_WAKE_START_HOUR = 6;
export const SINGAPORE_WAKE_END_HOUR = 24;

export function isSingaporeWakeWindow(nowMs = Date.now()) {
  const singaporeHour = new Date(nowMs + 8 * 60 * 60 * 1000).getUTCHours();
  return singaporeHour >= SINGAPORE_WAKE_START_HOUR && singaporeHour < SINGAPORE_WAKE_END_HOUR;
}

export function turnTimeoutMsFromEnv(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return DEFAULT_TURN_TIMEOUT_MS;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_TURN_TIMEOUT_MS;
  if (value === 0) return 0;
  return Math.min(MAX_TURN_TIMEOUT_MS, Math.max(MIN_TURN_TIMEOUT_MS, Math.round(value)));
}

export function compactTurnTimeoutMsFromEnv(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return DEFAULT_COMPACT_TURN_TIMEOUT_MS;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_COMPACT_TURN_TIMEOUT_MS;
  return Math.min(MAX_TURN_TIMEOUT_MS, Math.max(MIN_TURN_TIMEOUT_MS, Math.round(value)));
}

export function compactWatchdogPctFromEnv(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return DEFAULT_COMPACT_WATCHDOG_PCT;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_COMPACT_WATCHDOG_PCT;
  return Math.min(100, Math.max(1, Math.round(value)));
}

export function watchdogTimeoutForTurn({
  tokens = 0,
  limit = 0,
  archiveReceipt = false,
  defaultTimeoutMs = DEFAULT_TURN_TIMEOUT_MS,
  compactTimeoutMs = DEFAULT_COMPACT_TURN_TIMEOUT_MS,
  compactPct = DEFAULT_COMPACT_WATCHDOG_PCT,
} = {}) {
  const normal = Number(defaultTimeoutMs) || 0;
  if (!(normal > 0)) return 0;
  const knownPct = Number(limit) > 0 && Number(tokens) > 0
    ? (Number(tokens) / Number(limit)) * 100 : 0;
  // Immediately after a restart the shim has not observed token usage yet.
  // A persisted archive receipt proves this resumed session was already high,
  // so protect its first turn too; the next result restores an exact number.
  const resumedHighWater = !(Number(tokens) > 0) && archiveReceipt === true;
  if (knownPct < Number(compactPct) && !resumedHighWater) return normal;
  return Math.max(normal, Number(compactTimeoutMs) || 0);
}

export function interruptGraceMsFromEnv(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return DEFAULT_INTERRUPT_GRACE_MS;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_INTERRUPT_GRACE_MS;
  return Math.min(MAX_INTERRUPT_GRACE_MS, Math.max(MIN_INTERRUPT_GRACE_MS, Math.round(value)));
}

export function interruptControlRequest(requestId) {
  return {
    type: "control_request",
    request_id: requestId,
    request: { subtype: "interrupt" },
  };
}

// A wake must never create the resident process: only a real Kelivo turn has
// the recovery transcript needed to make a freshly spawned process safe.
// `force` skips the idle threshold only; every process/history/queue gate stays
// in force. Returning the reason keeps the manual /hb endpoint truthful.
export function autonomousWakeStatus({
  hasProcess,
  busy,
  queueLength,
  needsHistory,
  idleTurnMs,
  idleThresholdMs,
  withinWakeWindow = true,
  force = false,
}) {
  const waitingForHistory = !hasProcess || needsHistory;
  if (!hasProcess) return { triggered: false, waitingForHistory, reason: "no-resident-process" };
  if (needsHistory) return { triggered: false, waitingForHistory, reason: "waiting-for-history" };
  if (!withinWakeWindow) return { triggered: false, waitingForHistory, reason: "quiet-hours" };
  if (busy) return { triggered: false, waitingForHistory, reason: "busy" };
  if (queueLength > 0) return { triggered: false, waitingForHistory, reason: "queued" };
  if (!force && idleTurnMs < idleThresholdMs) {
    return { triggered: false, waitingForHistory, reason: "not-idle" };
  }
  return { triggered: true, waitingForHistory, reason: force ? "forced" : "idle" };
}

// Inactivity watchdog for one resident-Claude turn. touch() replaces the old
// timer, so a stale callback can never terminate a later turn.
export class TurnWatchdog {
  constructor({ timeoutMs, onTimeout, setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.timeoutMs = timeoutMs;
    this.onTimeout = onTimeout;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.active = null;
    this.timer = null;
    this.activeTimeoutMs = timeoutMs;
  }

  arm(token, timeoutMs = this.timeoutMs) {
    this.disarm();
    this.active = token;
    this.activeTimeoutMs = Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : this.timeoutMs;
    this.#schedule(token);
  }

  touch(token) {
    if (this.active !== token) return false;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.#schedule(token);
    return true;
  }

  disarm(token) {
    if (token !== undefined && this.active !== token) return false;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.active = null;
    this.activeTimeoutMs = this.timeoutMs;
    return true;
  }

  #schedule(token) {
    if (!(this.activeTimeoutMs > 0)) return;
    this.timer = this.setTimer(() => {
      if (this.active !== token) return;
      this.timer = null;
      this.active = null;
      this.onTimeout(token);
    }, this.activeTimeoutMs);
    this.timer?.unref?.();
  }
}
