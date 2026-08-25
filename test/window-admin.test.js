import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";

import { registerWindowAdmin, tokenK, windowPage, windowStage } from "../window-admin.js";

async function startAdmin(express, getStatus = () => ({
  model: "claude-opus-4-6",
  tokens: 61200,
  limit: 167000,
  pct: 37,
  warnPct: 80,
  archivePct: 85,
  compactions: 1,
  lastCompactAt: "2026-08-24T01:30:00.000Z",
  lastCompactPreTokens: 166400,
})) {
  const app = express();
  registerWindowAdmin(app, {
    shimKey: "secret-key",
    urlencoded: express.urlencoded,
    getStatus,
    log() {},
  });
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    base: `http://127.0.0.1:${server.address().port}/admin/window`,
    close: async () => { server.close(); await once(server, "close"); },
  };
}

async function login(admin, key = "secret-key") {
  const response = await fetch(`${admin.base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ key }),
  });
  return { response, cookie: response.headers.get("set-cookie")?.split(";", 1)[0] };
}

function fakeApp() {
  const routes = new Map();
  return {
    routes,
    use() {},
    get(path, handler) { routes.set(`GET ${path}`, handler); },
    post(path, handler) { routes.set(`POST ${path}`, handler); },
  };
}

function fakeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    redirectTo: "",
    status(code) { this.statusCode = code; return this; },
    type() { return this; },
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    send(body) { this.body = String(body); return this; },
    redirect(code, location) { this.statusCode = code; this.redirectTo = location; return this; },
  };
}

test("window progress helpers report K values and bounded stages", () => {
  assert.equal(tokenK(61200), "61.2K");
  assert.match(windowStage({ tokens: 61200, limit: 167000, pct: 37 }).text, /空间充足/);
  assert.match(windowStage({ tokens: 143000, limit: 167000, pct: 86, autoArchived: true }).text, /续接信已经保存/);
  const html = windowPage({ tokens: 300000, limit: 167000, pct: 180, warnPct: 80, archivePct: 85 });
  assert.match(html, /aria-valuenow="100"/);
  assert.doesNotMatch(html, /width:180%/);
});

test("window page shows a passive model and thinking receipt", () => {
  const html = windowPage({
    model: "claude-opus-4-6",
    effort: "high",
    claudeCodeVersion: "2.1.206",
    tokens: 10,
    limit: 167000,
    attestation: {
      requestedModel: "claude-opus-4-6",
      configuredModel: "claude-opus-4-6",
      upstreamModel: "claude-opus-4-6",
      requestedEffort: "high",
      effectiveEffort: "high",
      effortSource: "kelivo-output-config",
      thinkingDisplay: "summarized",
      thinkingSeen: true,
      signatureSeen: true,
      localTraceEnabled: true,
      status: "completed",
      completedAt: "2026-08-25T09:30:00.000Z",
    },
  });
  assert.match(html, /模型与思考验真/);
  assert.match(html, /上游实际模型/);
  assert.match(html, /一致 ✓/);
  assert.match(html, /重度（high）/);
  assert.match(html, /上游签名标记/);
  assert.match(html, /已收到 ✓/);
  assert.match(html, /2\.1\.206/);
  assert.match(html, /本地 OB 工具轨迹/);
});

test("window page shows the Bark name and pauses refresh while editing", () => {
  const overview = windowPage({ aiName: "小克", barkEnabled: true });
  assert.match(overview, /Bark 通知名字/);
  assert.match(overview, /现在显示：<strong>小克<\/strong>/);
  assert.match(overview, /http-equiv="refresh"/);

  const editing = windowPage(
    { aiName: "小克", barkEnabled: true },
    { session: { csrf: "csrf-token" }, editName: true },
  );
  assert.match(editing, /name="csrf" value="csrf-token"/);
  assert.match(editing, /name="name" value="小克"/);
  assert.match(editing, /修改名字时已暂停自动刷新/);
  assert.doesNotMatch(editing, /http-equiv="refresh"/);
});

test("window progress page requires SHIM_KEY and performs no write action", async (t) => {
  let express;
  try {
    express = (await import("express")).default;
  } catch {
    t.skip("express dependency is not installed in this local checkout");
    return;
  }
  let reads = 0;
  const admin = await startAdmin(express, () => {
    reads += 1;
    return { model: "claude-opus-4-6", tokens: 61200, limit: 167000, pct: 37, warnPct: 80, archivePct: 85 };
  });
  t.after(admin.close);

  const wrong = await login(admin, "wrong");
  assert.equal(wrong.response.status, 401);
  assert.equal(reads, 0);

  const accepted = await login(admin);
  assert.equal(accepted.response.status, 303);
  const page = await fetch(admin.base, { headers: { cookie: accepted.cookie } });
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.equal(reads, 1);
  assert.match(html, /37%/);
  assert.match(html, /61\.2K \/ 167\.0K/);
  assert.match(html, /每 15 秒自动刷新/);
  assert.match(html, /不会给小克发送消息/);
});

test("window page saves a Bark name with its session CSRF token", () => {
  let name = "TA";
  const app = fakeApp();
  registerWindowAdmin(app, {
    shimKey: "secret-key",
    urlencoded: () => (_req, _res, next) => next(),
    getStatus: () => ({ aiName: name, barkEnabled: true }),
    setAiName: (next) => {
      name = String(next).trim();
      return { ok: true, name };
    },
    log() {},
  });

  const loginResponse = fakeResponse();
  app.routes.get("POST /admin/window/login")({ body: { key: "secret-key" }, headers: {} }, loginResponse);
  assert.equal(loginResponse.statusCode, 303);
  const cookie = loginResponse.headers["set-cookie"].split(";", 1)[0];

  const editResponse = fakeResponse();
  app.routes.get("GET /admin/window")({ query: { editName: "1" }, headers: { cookie } }, editResponse);
  const csrf = editResponse.body.match(/name="csrf" value="([^"]+)"/)?.[1];
  assert.ok(csrf);

  const savedResponse = fakeResponse();
  app.routes.get("POST /admin/window/name")({ body: { csrf, name: "小克" }, headers: { cookie } }, savedResponse);
  assert.equal(savedResponse.statusCode, 303);
  assert.equal(savedResponse.redirectTo, "/admin/window?nameSaved=1");
  assert.equal(name, "小克");
});
