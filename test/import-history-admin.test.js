import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import express from "express";

import { ImportHistoryStore } from "../import-history.js";
import { registerImportHistoryAdmin } from "../import-history-admin.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startAdmin({ busy = false, maxChars = 10_000 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kelivo-import-admin-"));
  const store = new ImportHistoryStore({
    dir: path.join(root, "imports"),
    sessionStateFile: path.join(root, "session.json"),
  });
  const app = express();
  let restarts = 0;
  registerImportHistoryAdmin(app, {
    shimKey: "secret-key",
    urlencoded: express.urlencoded,
    store,
    maxMessages: 20,
    maxChars,
    isBusy: () => busy,
    requestRestart: () => { restarts += 1; },
    log() {},
  });
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    base: `http://127.0.0.1:${server.address().port}/admin/import`,
    close: async () => {
      server.close();
      await once(server, "close");
      fs.rmSync(root, { recursive: true, force: true });
    },
    store,
    restarts: () => restarts,
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
  assert.equal(response.headers.get("location"), "/admin/import");
  const cookie = response.headers.get("set-cookie").split(";", 1)[0];
  const page = await fetch(admin.base, { headers: { cookie } });
  const html = await page.text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
  assert.ok(csrf);
  return { cookie, csrf, html, headers: page.headers };
}

function payload(extra = "") {
  return JSON.stringify({
    source: "claude-share",
    messages: [
      { role: "user", content: `官端旧消息${extra}` },
      { role: "assistant", content: "官端旧回复" },
    ],
  });
}

test("import page requires SHIM_KEY and keeps it out of the URL", async (t) => {
  const admin = await startAdmin();
  t.after(admin.close);
  const rejected = await fetch(`${admin.base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ key: "wrong" }),
  });
  assert.equal(rejected.status, 401);
  assert.equal(admin.store.status().state, "empty");

  const { html, headers } = await login(admin);
  assert.match(html, /Claude → Kelivo 搬家门/);
  assert.match(html, /type="file"/);
  assert.doesNotMatch(html, /secret-key/);
  assert.match(headers.get("content-security-policy"), /script-src 'self'/);
  assert.doesNotMatch(headers.get("content-security-policy"), /script-src 'unsafe-inline'/);
});

test("prepare requires csrf and refuses to interrupt a busy turn", async (t) => {
  const admin = await startAdmin({ busy: true });
  t.after(admin.close);
  const { cookie, csrf } = await login(admin);

  const badCsrf = await fetch(`${admin.base}/prepare`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf: "wrong", payload: payload() }),
  });
  assert.equal(badCsrf.status, 403);

  const busy = await fetch(`${admin.base}/prepare`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf, payload: payload() }),
  });
  assert.equal(busy.status, 409);
  assert.equal(admin.store.status().state, "empty");
  assert.equal(admin.restarts(), 0);
});

test("a valid package is prepared once and requests a graceful restart", async (t) => {
  const admin = await startAdmin();
  t.after(admin.close);
  const { cookie, csrf } = await login(admin);
  const prepared = await fetch(`${admin.base}/prepare`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf, payload: payload() }),
  });
  const html = await prepared.text();
  assert.equal(prepared.status, 200);
  assert.match(html, /搬家包裹已准备/);
  assert.equal(admin.store.status().state, "pending");
  assert.equal(admin.store.status().messages, 2);
  await delay(150);
  assert.equal(admin.restarts(), 1);

  const page = await fetch(admin.base, { headers: { cookie } });
  const pendingHtml = await page.text();
  assert.match(pendingHtml, /待搬家：2 条消息/);
  assert.doesNotMatch(pendingHtml, /name="payload"/);
});

test("oversized content is rejected rather than silently truncated", async (t) => {
  const admin = await startAdmin({ maxChars: 20 });
  t.after(admin.close);
  const { cookie, csrf } = await login(admin);
  const response = await fetch(`${admin.base}/prepare`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf, payload: payload("x".repeat(50)) }),
  });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /对话太长/);
  assert.equal(admin.store.status().state, "empty");
  assert.equal(admin.restarts(), 0);
});
