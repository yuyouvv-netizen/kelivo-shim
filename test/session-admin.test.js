import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import express from "express";

import { registerSessionAdmin } from "../session-admin.js";

async function startAdmin({
  startFreshSession = () => ({ ok: true }),
  setEffort = (effort) => ({ ok: true, effort }),
} = {}) {
  const app = express();
  let starts = 0;
  let lastFresh = null;
  let effortChanges = 0;
  registerSessionAdmin(app, {
    shimKey: "secret-key",
    urlencoded: express.urlencoded,
    getStatus: () => ({
      model: "claude-opus-4-6",
      effort: "medium",
      models: ["claude-opus-4-6", "claude-opus-5"],
      efforts: ["low", "medium", "high", "max"],
      busy: false,
    }),
    startFreshSession: (settings) => {
      starts += 1;
      lastFresh = settings;
      return startFreshSession(settings);
    },
    setEffort: (effort) => {
      effortChanges += 1;
      return setEffort(effort);
    },
    log() {},
  });
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    base: `http://127.0.0.1:${server.address().port}/admin/session`,
    close: async () => { server.close(); await once(server, "close"); },
    starts: () => starts,
    lastFresh: () => lastFresh,
    effortChanges: () => effortChanges,
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
    body: new URLSearchParams({
      csrf,
      model: "claude-opus-5",
      effort: "high",
      confirm: "yes",
    }),
  });
  assert.equal(accepted.status, 303);
  assert.equal(accepted.headers.get("location"), "/admin/session?fresh=1");
  assert.equal(admin.starts(), 1);
  assert.deepEqual(admin.lastFresh(), { model: "claude-opus-5", effort: "high" });
});

test("session page exposes model and effort controls without Telegram commands", async (t) => {
  const admin = await startAdmin();
  t.after(admin.close);
  const { cookie } = await login(admin);
  const html = await fetch(admin.base, { headers: { cookie } }).then((response) => response.text());
  assert.match(html, /会话与模型/);
  assert.match(html, /Claude Opus 5/);
  assert.match(html, /保存档位并继续当前会话/);
  assert.match(html, /确认放下当前会话/);
  assert.match(html, /Telegram 或 Kelivo/);
});

test("effort change requires csrf and does not release the session", async (t) => {
  const admin = await startAdmin();
  t.after(admin.close);
  const { cookie, csrf } = await login(admin);
  const response = await fetch(`${admin.base}/effort`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf, effort: "high" }),
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/admin/session?effort=1");
  assert.equal(admin.effortChanges(), 1);
  assert.equal(admin.starts(), 0);
});

test("fresh-session switch requires an explicit confirmation", async (t) => {
  const admin = await startAdmin();
  t.after(admin.close);
  const { cookie, csrf } = await login(admin);
  const response = await fetch(`${admin.base}/fresh`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf, model: "claude-opus-5", effort: "high" }),
  });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /勾选确认/);
  assert.equal(admin.starts(), 0);
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
    body: new URLSearchParams({
      csrf,
      model: "claude-opus-4-6",
      effort: "medium",
      confirm: "yes",
    }),
  });
  assert.equal(response.status, 409);
  assert.match(await response.text(), /正在回复/);
  assert.equal(admin.starts(), 1);
});
