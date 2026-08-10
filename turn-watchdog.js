export const DEFAULT_TURN_TIMEOUT_MS = 5 * 60 * 1000;
export const MIN_TURN_TIMEOUT_MS = 30 * 1000;
export const MAX_TURN_TIMEOUT_MS = 30 * 60 * 1000;
// Continuity is more valuable than rescuing one reply quickly. After asking
// Claude Code to interrupt only the current turn, give the resident process a
// full minute to settle and flush its native session before a hard restart.
export const DEFAULT_INTERRUPT_GRACE_MS = 60 * 1000;
export const MIN_INTERRUPT_GRACE_MS = 1000;
export const MAX_INTERRUPT_GRACE_MS = 5 * 60 * 1000;
export const BEIJING_WAKE_START_HOUR = 8;
export const BEIJING_WAKE_END_HOUR = 24;

export function isBeijingWakeWindow(nowMs = Date.now()) {
  const beijingHour = new Date(nowMs + 8 * 60 * 60 * 1000).getUTCHours();
  return beijingHour >= BEIJING_WAKE_START_HOUR && beijingHour < BEIJING_WAKE_END_HOUR;
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
  }

  arm(token) {
    this.disarm();
    this.active = token;
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
    return true;
  }

  #schedule(token) {
    if (!(this.timeoutMs > 0)) return;
    this.timer = this.setTimer(() => {
      if (this.active !== token) return;
      this.timer = null;
      this.active = null;
      this.onTimeout(token);
    }, this.timeoutMs);
    this.timer?.unref?.();
  }
}
