export const DEFAULT_TURN_TIMEOUT_MS = 5 * 60 * 1000;
export const MIN_TURN_TIMEOUT_MS = 30 * 1000;
export const MAX_TURN_TIMEOUT_MS = 30 * 60 * 1000;

export function turnTimeoutMsFromEnv(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return DEFAULT_TURN_TIMEOUT_MS;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_TURN_TIMEOUT_MS;
  if (value === 0) return 0;
  return Math.min(MAX_TURN_TIMEOUT_MS, Math.max(MIN_TURN_TIMEOUT_MS, Math.round(value)));
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
