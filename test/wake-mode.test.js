import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import {
  activeHoursForWakeMode,
  normalizeWakeMode,
  WAKE_MODE_ALWAYS,
  WAKE_MODE_DAY,
  WakeModeStore,
  wakeModeAllowsNow,
} from "../wake-mode.js";

test("wake mode defaults to the daytime Singapore window", () => {
  assert.equal(normalizeWakeMode(), WAKE_MODE_DAY);
  assert.equal(activeHoursForWakeMode(WAKE_MODE_DAY), "08:00-24:00");
  assert.equal(wakeModeAllowsNow(WAKE_MODE_DAY, Date.parse("2026-08-08T00:00:00Z")), true);
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
