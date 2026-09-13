import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

import {
  registerStatusRoute,
  relativeAge,
  renderStatusForTool,
  singaporeTimestamp,
  StatusStore,
} from "../status.js";

const WRITTEN_AT = "2026-09-13T11:09:00.000Z"; // 19:09 in Singapore

function fixture(t, now = Date.parse(WRITTEN_AT)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kelivo-status-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { value: now };
  const store = new StatusStore({
    file: path.join(dir, "private", "now.json"),
    now: () => clock.value,
  });
  return { dir, clock, store };
}

test("status is a single atomic private record with a server timestamp", (t) => {
  const f = fixture(t);
  assert.deepEqual(f.store.read(), { kind: "none" });
  const first = f.store.write("  到家 / 沙发\r\n灯没开  ");
  assert.equal(first.text, "到家 / 沙发\n灯没开");
  assert.equal(first.writtenAt, WRITTEN_AT);
  assert.equal(fs.statSync(f.store.file).mode & 0o777, 0o600);

  f.clock.value += 60_000;
  f.store.write("腰躺平了");
  const saved = JSON.parse(fs.readFileSync(f.store.file, "utf8"));
  assert.equal(saved.text, "腰躺平了");
  assert.equal(fs.readdirSync(path.dirname(f.store.file)).length, 1);
});

test("empty and overlong status values are rejected without replacing the prior value", (t) => {
  const f = fixture(t);
  f.store.write("保留这条");
  assert.throws(() => f.store.write("   "), /不能为空/);
  assert.throws(() => f.store.write("好".repeat(501)), /500/);
  assert.equal(f.store.read().text, "保留这条");
});

test("look distinguishes current, stale, visible-expired and hidden-expired states", (t) => {
  const f = fixture(t);
  f.store.write("到家 / 沙发 / 灯没开 / 腰躺平了");

  f.clock.value = Date.parse(WRITTEN_AT) + 3 * 60_000;
  let output = renderStatusForTool(f.store.read());
  assert.match(output, /内容：到家/);
  assert.match(output, /写于：3 分钟前（2026-09-13 19:09，新加坡）/);
  assert.match(output, /【当前 · 3 分钟前】/);

  f.clock.value = Date.parse(WRITTEN_AT) + (3 * 60 + 12) * 60_000;
  output = renderStatusForTool(f.store.read());
  assert.match(output, /内容：到家/);
  assert.match(output, /【较旧 · 3 小时 12 分钟前 · 不可自动当作此刻】/);

  f.clock.value = Date.parse(WRITTEN_AT) + (10 * 60 + 5) * 60_000;
  output = renderStatusForTool(f.store.read());
  assert.match(output, /内容：到家/);
  assert.match(output, /【已过期 · 10 小时 5 分钟前 · 不可视为此刻】/);

  f.clock.value = Date.parse(WRITTEN_AT) + (24 * 60 + 1) * 60_000;
  output = renderStatusForTool(f.store.read());
  assert.doesNotMatch(output, /内容：到家/);
  assert.match(output, /正文不再返回/);
  assert.match(output, /【已过期 · 24 小时 1 分钟前 · 不可视为此刻】/);
});

test("look never conflates no status with a read failure", (t) => {
  const f = fixture(t);
  assert.equal(
    renderStatusForTool(f.store.read()),
    "[临时状态｜不要写入长期记忆]\n她没有留下状态。\n这只表示没有状态；不要推测原因、情绪或意图，也不要因此向她追问。",
  );
  fs.mkdirSync(path.dirname(f.store.file), { recursive: true });
  fs.writeFileSync(f.store.file, "not-json");
  const output = renderStatusForTool(f.store.read());
  assert.match(output, /look 暂时无法读取状态/);
  assert.match(output, /不等于她没有留下状态/);
  assert.match(output, /不要自动重试/);
});

test("relative and absolute time are fixed to Singapore", () => {
  assert.equal(singaporeTimestamp(WRITTEN_AT), "2026-09-13 19:09");
  assert.equal(relativeAge(59_000), "刚刚");
  assert.equal(relativeAge(61_000), "1 分钟前");
  assert.equal(relativeAge((8 * 60 + 9) * 60_000), "8 小时 9 分钟前");
});

test("the iPhone write endpoint is separately authenticated and does not expose text", async (t) => {
  const f = fixture(t);
  const app = express();
  registerStatusRoute(app, {
    store: f.store,
    writeToken: "shortcut-secret",
    json: express.json,
  });
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const denied = await fetch(`${base}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "not-json",
  });
  assert.equal(denied.status, 401);
  assert.deepEqual(f.store.read(), { kind: "none" });

  const accepted = await fetch(`${base}/status`, {
    method: "POST",
    headers: {
      "Authorization": "Bearer shortcut-secret",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: "到家了" }),
  });
  assert.equal(accepted.status, 201);
  const body = await accepted.json();
  assert.deepEqual(body, {
    ok: true,
    writtenAt: WRITTEN_AT,
    writtenAtSingapore: "2026-09-13 19:09",
    timeZone: "Asia/Singapore",
  });
  assert.equal(JSON.stringify(body).includes("到家了"), false);
  assert.equal(f.store.read().text, "到家了");
});

test("the iPhone write endpoint unwraps only narrow text wrappers", async (t) => {
  const f = fixture(t);
  const app = express();
  registerStatusRoute(app, {
    store: f.store,
    writeToken: "shortcut-secret",
    json: express.json,
  });
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/status`;
  const headers = {
    "Authorization": "Bearer shortcut-secret",
    "Content-Type": "application/json",
  };

  const wrapped = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: { text: ["GPT / 到家了"] } }),
  });
  assert.equal(wrapped.status, 201);
  assert.equal(f.store.read().text, "GPT / 到家了");

  const arbitrary = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: { unrelated: "不会写入" } }),
  });
  assert.equal(arbitrary.status, 400);
  assert.equal(f.store.read().text, "GPT / 到家了");
});

test("the write endpoint fails closed when its separate token is absent", async (t) => {
  const f = fixture(t);
  const app = express();
  registerStatusRoute(app, { store: f.store, writeToken: "", json: express.json });
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-status-key": "anything" },
    body: JSON.stringify({ text: "不会写入" }),
  });
  assert.equal(response.status, 503);
  assert.deepEqual(f.store.read(), { kind: "none" });
});
