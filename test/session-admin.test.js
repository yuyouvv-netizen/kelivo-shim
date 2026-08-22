import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import express from "express";

import { registerSessionAdmin } from "../session-admin.js";

async function startAdmin({ startFreshSession = () => ({ ok: true }) } = {}) {
  const app = express();
  let starts = 0;
  registerSessionAdmin(app, {
    shimKey: "secret-key",
    urlencoded: express.urlencoded,
    getStatus: () => ({ model: "claude-opus-4-6", busy: false }),
    startFreshSession: () => { starts += 1; return startFreshSession(); },
    log() {},
  });
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    base: `http://127.0.0.1:${server.address().port}/admin/session`,
    close: async () => { server.close(); await once(server, "close"); },
    starts: () => starts,
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
  return { cookie, csrf };
}

test("fresh-session page requires the configured shim key", async (t) => {
  const admin = await startAdmin();
  t.after(admin.close);
  const response = await fetch(`${admin.base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ key: "wrong" }),
  });
  assert.equal(response.status, 401);
  assert.equal(admin.starts(), 0);
});

test("fresh-session switch requires csrf and runs exactly once", async (t) => {
  const admin = await startAdmin();
  t.after(admin.close);
  const { cookie, csrf } = await login(admin);

  const rejected = await fetch(`${admin.base}/fresh`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf: "wrong" }),
  });
  assert.equal(rejected.status, 403);
  assert.equal(admin.starts(), 0);

  const accepted = await fetch(`${admin.base}/fresh`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf }),
  });
  assert.equal(accepted.status, 303);
  assert.equal(accepted.headers.get("location"), "/admin/session?fresh=1");
  assert.equal(admin.starts(), 1);
});

test("busy backend refuses the fresh-session switch", async (t) => {
  const admin = await startAdmin({
    startFreshSession: () => ({ ok: false, status: 409, error: "正在回复，请等这一轮结束。" }),
  });
  t.after(admin.close);
  const { cookie, csrf } = await login(admin);
  const response = await fetch(`${admin.base}/fresh`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf }),
  });
  assert.equal(response.status, 409);
  assert.match(await response.text(), /正在回复/);
  assert.equal(admin.starts(), 1);
});
