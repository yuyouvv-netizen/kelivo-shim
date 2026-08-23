import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import express from "express";

import { registerWakeAdmin } from "../wake-admin.js";

async function startAdmin() {
  const app = express();
  let mode = "day";
  const changes = [];
  registerWakeAdmin(app, {
    shimKey: "secret-key",
    urlencoded: express.urlencoded,
    getStatus: () => ({ mode, checkMin: 10, idleMin: 50, bark: true }),
    setMode: (next) => {
      mode = next;
      changes.push(next);
      return { ok: true, mode: next };
    },
    log() {},
  });
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    base: `http://127.0.0.1:${server.address().port}/admin/wake`,
    close: async () => { server.close(); await once(server, "close"); },
    changes,
    mode: () => mode,
  };
}

async function login(admin) {
  const response = await fetch(`${admin.base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ key: "secret-key" }),
  });
  assert.equal(response.status, 303);
  const cookie = response.headers.get("set-cookie").split(";", 1)[0];
  const page = await fetch(admin.base, { headers: { cookie } });
  const html = await page.text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
  assert.ok(csrf);
  return { cookie, csrf, html };
}

test("wake page requires the configured shim key", async (t) => {
  const admin = await startAdmin();
  t.after(admin.close);
  const response = await fetch(`${admin.base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ key: "wrong" }),
  });
  assert.equal(response.status, 401);
  assert.deepEqual(admin.changes, []);
});

test("wake page shows the current safe daytime mode", async (t) => {
  const admin = await startAdmin();
  t.after(admin.close);
  const { html } = await login(admin);
  assert.match(html, /当前模式/);
  assert.match(html, /白天 08:00–24:00/);
  assert.match(html, /全天模式（24 小时）/);
});

test("wake switch requires csrf and changes mode without a restart", async (t) => {
  const admin = await startAdmin();
  t.after(admin.close);
  const { cookie, csrf } = await login(admin);
  const rejected = await fetch(`${admin.base}/mode`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf: "wrong", mode: "always" }),
  });
  assert.equal(rejected.status, 403);
  assert.deepEqual(admin.changes, []);

  const accepted = await fetch(`${admin.base}/mode`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf, mode: "always" }),
  });
  assert.equal(accepted.status, 303);
  assert.equal(accepted.headers.get("location"), "/admin/wake?saved=1");
  assert.equal(admin.mode(), "always");
  assert.deepEqual(admin.changes, ["always"]);
});

test("wake switch rejects unknown modes", async (t) => {
  const admin = await startAdmin();
  t.after(admin.close);
  const { cookie, csrf } = await login(admin);
  const response = await fetch(`${admin.base}/mode`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf, mode: "night-only" }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(admin.changes, []);
});
