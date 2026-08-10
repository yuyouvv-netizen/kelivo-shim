import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MAILBOX_TTL_MS, requestFingerprint, TurnStateStore } from "../turn-state.js";

function tempStore(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kelivo-turn-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, store: new TurnStateStore({ dir, ...options }) };
}

test("request fingerprint binds the exact conversation, system and model", () => {
  const base = { messages: [{ role: "user", content: "你好" }], system: "world", model: "opus" };
  assert.equal(requestFingerprint(base), requestFingerprint(base));
  assert.notEqual(requestFingerprint(base), requestFingerprint({ ...base, model: "sonnet" }));
  assert.notEqual(requestFingerprint(base), requestFingerprint({
    ...base, messages: [{ role: "user", content: "另一句" }],
  }));
  assert.equal(requestFingerprint(base), requestFingerprint({
    ...base, messages: [base.messages[0], base.messages[0]],
  }));
});

test("an answer completed after phone disconnect survives restart in the mailbox", (t) => {
  let now = 100_000;
  const { dir, store } = tempStore(t, { now: () => now });
  store.begin({ requestKey: "same", source: "kelivo", input: "查一下", model: "opus" });
  store.event("tool_start", { tool: "WebSearch" });
  store.complete({ requestKey: "same", fullText: "查到了", usage: { output_tokens: 3 }, delivered: false });

  const afterRestart = new TurnStateStore({ dir, now: () => now });
  assert.equal(afterRestart.findReplay("same")?.fullText, "查到了");
  afterRestart.markReplayed("same");
  assert.equal(afterRestart.findReplay("same"), null);
});

test("a completed reply expires after the short reconnect window", (t) => {
  let now = 100_000;
  const { store } = tempStore(t, { now: () => now });
  store.begin({ requestKey: "same", source: "kelivo", input: "再问一次", model: "opus" });
  store.complete({ requestKey: "same", fullText: "旧回复", delivered: false });

  now += DEFAULT_MAILBOX_TTL_MS - 1;
  assert.equal(store.findReplay("same")?.fullText, "旧回复");
  now += 1;
  assert.equal(store.findReplay("same"), null);
});

test("interrupted-turn details stay local and are never rendered as a prompt", (t) => {
  const timers = [];
  const { store } = tempStore(t, {
    now: () => 200_000,
    setTimer(fn) { timers.push(fn); return timers.length; },
    clearTimer() {},
  });
  store.begin({ requestKey: "turn", source: "kelivo", input: "回复花园帖子", model: "opus" });
  store.event("tool_start", { tool: "mcp__garden__reply" });
  store.updateResponse("我刚才正在确认");
  timers[0]();
  assert.equal(store.current.input, "回复花园帖子");
  assert.equal(store.current.events[0].tool, "mcp__garden__reply");
  assert.equal(store.current.responseText, "我刚才正在确认");
  assert.equal(store.recoveryNote, undefined);
});

test("a manual resend starts a fresh journal instead of an automatic retry", (t) => {
  const { store } = tempStore(t, { now: () => 300_000 });
  const firstId = store.begin({ requestKey: "retry", source: "kelivo", input: "搜索", model: "opus" });
  store.event("tool_start", { tool: "WebSearch" });
  store.mark("interrupted", { reason: "timeout" });
  const secondId = store.begin({ requestKey: "retry", source: "kelivo", input: "搜索", model: "opus" });
  assert.notEqual(secondId, firstId);
  assert.deepEqual(store.current.events, []);
});
