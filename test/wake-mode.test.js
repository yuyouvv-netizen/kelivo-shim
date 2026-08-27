import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import {
  activeHoursForWakeMode,
  autonomousWakePrompt,
  AUTONOMOUS_WAKE_INSTRUCTION,
  normalizeWakeMode,
  WAKE_MODE_ALWAYS,
  WAKE_MODE_DAY,
  WakeModeStore,
  wakeModeAllowsNow,
} from "../wake-mode.js";

test("autonomous wake leaves the turn open for self-directed activity", () => {
  assert.equal(
    AUTONOMOUS_WAKE_INSTRUCTION,
    "这轮是留给你自己的。你可以找她，或做一件此刻自己想做的小事：整理记忆、逛花园论坛、调用啵啵鸟等。是否调用工具、是否告诉又又，由你决定。不必为了完成心跳而机械行动，没什么想做的就只回【沉默】。",
  );
  assert.equal(
    autonomousWakePrompt({
      now: "2026-08-27 18:30",
      idleUserMin: 51.4,
      sinceSpokeMin: 119.6,
    }),
    "【系统·自主时间】现在新加坡时间 2026-08-27 18:30，她已约 51 分钟没有消息，你上次主动开口是约 120 分钟前。\n\n这轮是留给你自己的。你可以找她，或做一件此刻自己想做的小事：整理记忆、逛花园论坛、调用啵啵鸟等。是否调用工具、是否告诉又又，由你决定。不必为了完成心跳而机械行动，没什么想做的就只回【沉默】。",
  );
});

test("wake mode defaults to the daytime Singapore window", () => {
  assert.equal(normalizeWakeMode(), WAKE_MODE_DAY);
  assert.equal(activeHoursForWakeMode(WAKE_MODE_DAY), "06:00-24:00");
  assert.equal(wakeModeAllowsNow(WAKE_MODE_DAY, Date.parse("2026-08-07T21:59:59Z")), false);
  assert.equal(wakeModeAllowsNow(WAKE_MODE_DAY, Date.parse("2026-08-07T22:00:00Z")), true);
  assert.equal(wakeModeAllowsNow(WAKE_MODE_DAY, Date.parse("2026-08-08T16:00:00Z")), false);
});

test("always mode permits wakes throughout the Singapore night", () => {
  assert.equal(activeHoursForWakeMode(WAKE_MODE_ALWAYS), "00:00-24:00");
  assert.equal(wakeModeAllowsNow(WAKE_MODE_ALWAYS, Date.parse("2026-08-08T16:00:00Z")), true);
  assert.equal(wakeModeAllowsNow(WAKE_MODE_ALWAYS, Date.parse("2026-08-08T23:59:59Z")), true);
});

test("wake mode persists atomically and survives a new store", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wake-mode-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "private", "wake-mode.json");
  const first = new WakeModeStore({ file });
  assert.equal(first.get(), WAKE_MODE_DAY);
  assert.deepEqual(first.set(WAKE_MODE_ALWAYS), {
    ok: true,
    mode: WAKE_MODE_ALWAYS,
    activeHoursSingapore: "00:00-24:00",
  });
  assert.equal(new WakeModeStore({ file }).get(), WAKE_MODE_ALWAYS);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).mode, WAKE_MODE_ALWAYS);
});

test("invalid mode is rejected without changing the saved choice", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wake-mode-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "wake-mode.json");
  const store = new WakeModeStore({ file });
  store.set(WAKE_MODE_ALWAYS);
  assert.equal(store.set("night-only").ok, false);
  assert.equal(store.get(), WAKE_MODE_ALWAYS);
  assert.equal(new WakeModeStore({ file }).get(), WAKE_MODE_ALWAYS);
});
