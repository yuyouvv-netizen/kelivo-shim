import { test } from "node:test";
import assert from "node:assert/strict";
import {
  autonomousWakeStatus,
  compactTurnTimeoutMsFromEnv,
  compactWatchdogPctFromEnv,
  DEFAULT_COMPACT_TURN_TIMEOUT_MS,
  DEFAULT_COMPACT_WATCHDOG_PCT,
  DEFAULT_INTERRUPT_GRACE_MS,
  DEFAULT_TURN_TIMEOUT_MS,
  interruptControlRequest,
  interruptGraceMsFromEnv,
  isSingaporeWakeWindow,
  MAX_INTERRUPT_GRACE_MS,
  MAX_TURN_TIMEOUT_MS,
  MIN_INTERRUPT_GRACE_MS,
  MIN_TURN_TIMEOUT_MS,
  TurnWatchdog,
  turnTimeoutMsFromEnv,
  watchdogTimeoutForTurn,
} from "../turn-watchdog.js";

const wakeState = (overrides = {}) => autonomousWakeStatus({
  hasProcess: true,
  busy: false,
  queueLength: 0,
  needsHistory: false,
  idleTurnMs: 60 * 60 * 1000,
  idleThresholdMs: 50 * 60 * 1000,
  ...overrides,
});

function fakeTimers() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimer(fn, delay) {
      const id = nextId++;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    fire(id) {
      const fn = timers.get(id)?.fn;
      timers.delete(id);
      fn?.();
    },
    delay(id) {
      return timers.get(id)?.delay;
    },
    ids() {
      return [...timers.keys()];
    },
  };
}

test("turn timeout env uses a safe default and bounds", () => {
  assert.equal(turnTimeoutMsFromEnv(undefined), DEFAULT_TURN_TIMEOUT_MS);
  assert.equal(turnTimeoutMsFromEnv("bad"), DEFAULT_TURN_TIMEOUT_MS);
  assert.equal(turnTimeoutMsFromEnv("0"), 0);
  assert.equal(turnTimeoutMsFromEnv("1"), MIN_TURN_TIMEOUT_MS);
  assert.equal(turnTimeoutMsFromEnv(String(MAX_TURN_TIMEOUT_MS * 2)), MAX_TURN_TIMEOUT_MS);
});

test("compression-aware timeout defaults to ten minutes at a 95 percent high-water mark", () => {
  assert.equal(compactTurnTimeoutMsFromEnv(undefined), DEFAULT_COMPACT_TURN_TIMEOUT_MS);
  assert.equal(compactTurnTimeoutMsFromEnv("bad"), DEFAULT_COMPACT_TURN_TIMEOUT_MS);
  assert.equal(compactWatchdogPctFromEnv(undefined), DEFAULT_COMPACT_WATCHDOG_PCT);
  assert.equal(compactWatchdogPctFromEnv("0"), 1);
  assert.equal(compactWatchdogPctFromEnv("101"), 100);

  const base = {
    limit: 167000,
    defaultTimeoutMs: 5 * 60 * 1000,
    compactTimeoutMs: 10 * 60 * 1000,
    compactPct: 95,
  };
  assert.equal(watchdogTimeoutForTurn({ ...base, tokens: 158000 }), 5 * 60 * 1000);
  assert.equal(watchdogTimeoutForTurn({ ...base, tokens: 158650 }), 10 * 60 * 1000);
  assert.equal(watchdogTimeoutForTurn({ ...base, tokens: 0, archiveReceipt: true }), 10 * 60 * 1000);
  assert.equal(watchdogTimeoutForTurn({ ...base, tokens: 0, archiveReceipt: false }), 5 * 60 * 1000);
  assert.equal(watchdogTimeoutForTurn({ ...base, tokens: 166000, defaultTimeoutMs: 0 }), 0);
});

test("interrupt grace defaults to a continuity-first full minute and stays bounded", () => {
  assert.equal(interruptGraceMsFromEnv(undefined), DEFAULT_INTERRUPT_GRACE_MS);
  assert.equal(interruptGraceMsFromEnv("bad"), DEFAULT_INTERRUPT_GRACE_MS);
  assert.equal(interruptGraceMsFromEnv("1"), MIN_INTERRUPT_GRACE_MS);
  assert.equal(interruptGraceMsFromEnv(String(MAX_INTERRUPT_GRACE_MS * 2)), MAX_INTERRUPT_GRACE_MS);
});

test("watchdog requests a Claude turn-only interrupt before process restart", () => {
  assert.deepEqual(interruptControlRequest("req-1"), {
    type: "control_request",
    request_id: "req-1",
    request: { subtype: "interrupt" },
  });
});

test("completed turn is disarmed and cannot time out later", () => {
  const timers = fakeTimers();
  const timedOut = [];
  const turn = { id: 1 };
  const watchdog = new TurnWatchdog({
    timeoutMs: 100,
    onTimeout: (token) => timedOut.push(token),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  watchdog.arm(turn);
  const [timer] = timers.ids();
  assert.equal(watchdog.disarm(turn), true);
  timers.fire(timer);
  assert.deepEqual(timedOut, []);
});

test("activity refreshes the deadline without leaking the stale timer", () => {
  const timers = fakeTimers();
  const timedOut = [];
  const turn = { id: 1 };
  const watchdog = new TurnWatchdog({
    timeoutMs: 100,
    onTimeout: (token) => timedOut.push(token),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  watchdog.arm(turn);
  const [staleTimer] = timers.ids();
  assert.equal(watchdog.touch(turn), true);
  const [freshTimer] = timers.ids();

  timers.fire(staleTimer);
  assert.deepEqual(timedOut, []);
  timers.fire(freshTimer);
  assert.deepEqual(timedOut, [turn]);
});

test("a compression turn keeps its per-turn extended timeout when activity refreshes", () => {
  const timers = fakeTimers();
  const turn = { id: 1 };
  const watchdog = new TurnWatchdog({
    timeoutMs: 5 * 60 * 1000,
    onTimeout() {},
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  watchdog.arm(turn, 10 * 60 * 1000);
  const [first] = timers.ids();
  assert.equal(timers.delay(first), 10 * 60 * 1000);
  watchdog.touch(turn);
  const [refreshed] = timers.ids();
  assert.notEqual(refreshed, first);
  assert.equal(timers.delay(refreshed), 10 * 60 * 1000);
});

test("a previous turn cannot disarm the current turn", () => {
  const timers = fakeTimers();
  const timedOut = [];
  const first = { id: 1 };
  const second = { id: 2 };
  const watchdog = new TurnWatchdog({
    timeoutMs: 100,
    onTimeout: (token) => timedOut.push(token),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  watchdog.arm(first);
  watchdog.arm(second);
  assert.equal(watchdog.disarm(first), false);
  const [timer] = timers.ids();
  timers.fire(timer);
  assert.deepEqual(timedOut, [second]);
});

test("autonomous wake requires a recovered, idle resident process with an empty queue", () => {
  assert.deepEqual(wakeState({ hasProcess: false }), {
    triggered: false, waitingForHistory: true, reason: "no-resident-process",
  });
  assert.deepEqual(wakeState({ needsHistory: true }), {
    triggered: false, waitingForHistory: true, reason: "waiting-for-history",
  });
  assert.deepEqual(wakeState({ busy: true }), {
    triggered: false, waitingForHistory: false, reason: "busy",
  });
  assert.deepEqual(wakeState({ queueLength: 1 }), {
    triggered: false, waitingForHistory: false, reason: "queued",
  });
  assert.deepEqual(wakeState(), {
    triggered: true, waitingForHistory: false, reason: "idle",
  });
});

test("autonomous wake runs only from 06:00 through 24:00 Singapore time", () => {
  assert.equal(isSingaporeWakeWindow(Date.parse("2026-08-07T21:59:59Z")), false); // 05:59
  assert.equal(isSingaporeWakeWindow(Date.parse("2026-08-07T22:00:00Z")), true); // 06:00
  assert.equal(isSingaporeWakeWindow(Date.parse("2026-08-08T15:59:59Z")), true); // 23:59
  assert.equal(isSingaporeWakeWindow(Date.parse("2026-08-08T16:00:00Z")), false); // 00:00
  assert.deepEqual(wakeState({ withinWakeWindow: false }), {
    triggered: false, waitingForHistory: false, reason: "quiet-hours",
  });
});

test("forced wake bypasses only the idle threshold", () => {
  assert.deepEqual(wakeState({ idleTurnMs: 1000 }), {
    triggered: false, waitingForHistory: false, reason: "not-idle",
  });
  assert.deepEqual(wakeState({ idleTurnMs: 1000, force: true }), {
    triggered: true, waitingForHistory: false, reason: "forced",
  });
  assert.equal(wakeState({ hasProcess: false, force: true }).triggered, false);
  assert.equal(wakeState({ needsHistory: true, force: true }).triggered, false);
  assert.equal(wakeState({ busy: true, force: true }).triggered, false);
  assert.equal(wakeState({ queueLength: 1, force: true }).triggered, false);
  assert.equal(wakeState({ withinWakeWindow: false, force: true }).triggered, false);
});
