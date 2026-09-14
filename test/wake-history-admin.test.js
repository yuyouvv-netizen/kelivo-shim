import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import express from "express";

import { registerWakeHistoryAdmin } from "../wake-history-admin.js";

async function startAdmin() {
  const app = express();
  const runs = [
    {
      id: "wake-1",
      startedAt: "2026-09-14T10:00:00.000Z",
      completedAt: "2026-09-14T10:01:00.000Z",
      status: "silent",
      tools: ["mcp__browser__x_read_home", "mcp__status__look"],
    },
  ];
  registerWakeHistoryAdmin(app, {
    shimKey: "secret-key",
    urlencoded: express.urlencoded,
    getRuns: () => runs,
    log() {},
  });
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    base: `http://127.0.0.1:${server.address().port}/admin/wake-history`,
    close: async () => { server.close(); await once(server, "close"); },
  };
}

test("wake history page requires SHIM_KEY and reveals only short tool names", async (t) => {
  const admin = await startAdmin();
  t.after(admin.close);

  const denied = await fetch(`${admin.base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ key: "wrong" }),
  });
  assert.equal(denied.status, 401);

  const login = await fetch(`${admin.base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ key: "secret-key" }),
  });
  assert.equal(login.status, 303);
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const response = await fetch(admin.base, { headers: { cookie } });
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
  assert.match(html, /x_read_home/);
  assert.match(html, />look</);
  assert.match(html, /保持沉默/);
  assert.doesNotMatch(html, /mcp__browser__/);
  assert.doesNotMatch(html, /not-recorded/);
  assert.match(html, /不会给小克发送消息/);
});
