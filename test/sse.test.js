import { EventEmitter } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAnthropicSSE,
  DEFAULT_SSE_HEARTBEAT_MS,
  MAX_SSE_HEARTBEAT_MS,
  MIN_SSE_HEARTBEAT_MS,
  sseHeartbeatMsFromEnv,
} from "../sse.js";

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.headers = {};
    this.chunks = [];
    this.flushed = false;
    this.writableEnded = false;
    this.destroyed = false;
  }
  setHeader(name, value) { this.headers[name] = value; }
  flushHeaders() { this.flushed = true; }
  write(chunk) { this.chunks.push(chunk); return true; }
  end() { this.writableEnded = true; this.emit("close"); }
}

test("SSE heartbeat env uses a safe default and bounds", () => {
  assert.equal(sseHeartbeatMsFromEnv(undefined), DEFAULT_SSE_HEARTBEAT_MS);
  assert.equal(sseHeartbeatMsFromEnv("bad"), DEFAULT_SSE_HEARTBEAT_MS);
  assert.equal(sseHeartbeatMsFromEnv("0"), 0);
  assert.equal(sseHeartbeatMsFromEnv("1"), MIN_SSE_HEARTBEAT_MS);
  assert.equal(sseHeartbeatMsFromEnv(String(MAX_SSE_HEARTBEAT_MS * 2)), MAX_SSE_HEARTBEAT_MS);
});

test("SSE flushes headers immediately and writes comments while Claude is silent", () => {
  const res = new FakeResponse();
  let heartbeatFn;
  let cleared = false;
  const sse = createAnthropicSSE(res, {
    model: "claude-test",
    heartbeatMs: 10,
    makeId: () => "11111111-1111-4111-8111-111111111111",
    setTimer(fn) { heartbeatFn = fn; return 7; },
    clearTimer(id) { assert.equal(id, 7); cleared = true; },
  });

  assert.equal(res.flushed, true);
  assert.equal(res.headers["X-Accel-Buffering"], "no");
  assert.deepEqual(res.chunks, [": connected\n\n"]);
  heartbeatFn();
  assert.equal(res.chunks.at(-1), ": keep-alive\n\n");

  sse.text("好");
  sse.finish({ output_tokens: 1 });
  assert.equal(cleared, true);
  assert.equal(res.writableEnded, true);
  assert.match(res.chunks.join(""), /event: message_start/);
  assert.match(res.chunks.join(""), /"text":"好"/);
  assert.match(res.chunks.join(""), /event: message_stop/);
});

test("SSE stops writing when the client closes", () => {
  const res = new FakeResponse();
  let heartbeatFn;
  const sse = createAnthropicSSE(res, {
    model: "claude-test",
    heartbeatMs: 10,
    setTimer(fn) { heartbeatFn = fn; return 1; },
    clearTimer() {},
  });
  res.emit("close");
  heartbeatFn();
  sse.text("不会写入");
  assert.deepEqual(res.chunks, [": connected\n\n"]);
});
