import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TURN_TIMEOUT_MS,
  MAX_TURN_TIMEOUT_MS,
  MIN_TURN_TIMEOUT_MS,
  TurnWatchdog,
  turnTimeoutMsFromEnv,
} from "../turn-watchdog.js";

function fakeTimers() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimer(fn) {
      const id = nextId++;
      timers.set(id, fn);
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    fire(id) {
      const fn = timers.get(id);
      timers.delete(id);
      fn?.();
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
