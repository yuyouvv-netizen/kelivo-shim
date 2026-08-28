import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  legacyWindowFlags,
  WindowThresholdStateStore,
} from "../window-threshold-state.js";

const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";

test("window warning and archive receipts survive a process restart for the same session", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kelivo-window-state-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "private", "window-thresholds.json");
  const first = new WindowThresholdStateStore({ file });

  assert.deepEqual(first.forSession(SESSION_A), {
    tracked: false, warned: false, archived: false,
  });
  assert.equal(first.save(SESSION_A, { warned: true, archived: true }), true);
  assert.deepEqual(new WindowThresholdStateStore({ file }).forSession(SESSION_A), {
    tracked: true, warned: true, archived: true,
  });
  assert.deepEqual(new WindowThresholdStateStore({ file }).forSession(SESSION_B), {
    tracked: false, warned: false, archived: false,
  });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("a real compact boundary resets both receipts for the same native session", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kelivo-window-state-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "window-thresholds.json");
  const store = new WindowThresholdStateStore({ file });

  store.save(SESSION_A, { warned: true, archived: true });
  assert.equal(store.reset(SESSION_A), true);
  assert.deepEqual(new WindowThresholdStateStore({ file }).forSession(SESSION_A), {
    tracked: true, warned: false, archived: false,
  });
});

test("the first high-water observation of a legacy resumed session is adopted without replaying actions", () => {
  assert.deepEqual(legacyWindowFlags({ pct: 84, warnPct: 85, archivePct: 90 }), {
    warned: false, archived: false,
  });
  assert.deepEqual(legacyWindowFlags({ pct: 87, warnPct: 85, archivePct: 90 }), {
    warned: true, archived: false,
  });
  assert.deepEqual(legacyWindowFlags({ pct: 96, warnPct: 85, archivePct: 90 }), {
    warned: true, archived: true,
  });
});
