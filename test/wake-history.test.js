import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { WakeHistoryStore } from "../wake-history.js";

test("wake history stores only unique tool names for the latest three wakes", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kelivo-wake-history-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "private", "wake-history.json");
  let now = Date.parse("2026-09-14T10:00:00Z");
  const store = new WakeHistoryStore({ file, now: () => now });

  for (let index = 0; index < 4; index += 1) {
    const run = store.start();
    store.addTool(run.id, "mcp__browser__x_read_home");
    store.addTool(run.id, "mcp__browser__x_read_home");
    store.addTool(run.id, `tool-${index}`);
    store.finish(run.id, index === 3 ? "silent" : "spoke");
    now += 60_000;
  }

  const runs = store.list();
  assert.equal(runs.length, 3);
  assert.equal(runs[0].status, "silent");
  assert.deepEqual(runs[0].tools, ["mcp__browser__x_read_home", "tool-3"]);
  assert.deepEqual(runs[2].tools, ["mcp__browser__x_read_home", "tool-1"]);
  assert.equal(JSON.stringify(runs).includes("tool-0"), false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const saved = fs.readFileSync(file, "utf8");
  assert.equal(saved.includes("not-recorded"), false);
  assert.deepEqual(new WakeHistoryStore({ file }).list().map((run) => run.tools), runs.map((run) => run.tools));
});

test("wake history marks a running wake as interrupted by a service restart", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kelivo-wake-recover-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "wake-history.json");
  let now = Date.parse("2026-09-14T11:00:00Z");
  const first = new WakeHistoryStore({ file, now: () => now });
  first.start();

  now += 30_000;
  const restored = new WakeHistoryStore({ file, now: () => now });
  assert.equal(restored.recoverIncomplete(), true);
  assert.equal(restored.list()[0].status, "service-restarted");
  assert.equal(restored.list()[0].completedAt, "2026-09-14T11:00:30.000Z");
  assert.equal(restored.recoverIncomplete(), false);
});
