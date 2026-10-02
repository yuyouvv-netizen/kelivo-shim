import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  clearFreshSessionState,
  loadFreshSessionState,
  saveFreshSessionState,
} from "../fresh-session-state.js";

test("pending fresh runtime is private, restart-safe and removable", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kelivo-fresh-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "private", "manual-fresh.json");

  assert.equal(saveFreshSessionState(file, {
    model: "claude-opus-5",
    effort: "high",
    system: "private worldbook",
  }), true);
  const loaded = loadFreshSessionState(file);
  assert.deepEqual(loaded, {
    model: "claude-opus-5",
    effort: "high",
    system: "private worldbook",
    requestedAt: loaded.requestedAt,
  });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(clearFreshSessionState(file), true);
  assert.equal(loadFreshSessionState(file), null);
});

test("invalid pending runtime is rejected", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kelivo-fresh-runtime-invalid-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "manual-fresh.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, model: "", effort: "high", system: "" }));
  assert.equal(loadFreshSessionState(file), null);
});
