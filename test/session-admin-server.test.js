import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";

const root = path.resolve(import.meta.dirname, "..");
const fakeClaude = path.join(root, "fixtures", "fake-claude.js");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = http.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  server.close();
  await once(server, "close");
  return port;
}

async function chat(base, text) {
  const response = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": "secret-key" },
    body: JSON.stringify({
      model: "claude-opus-4-6",
      stream: false,
      messages: [{ role: "user", content: text }],
    }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

test("manual switch releases the saved session and waits for a fresh 4.6 message", { timeout: 15_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kelivo-fresh-session-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, "session.json");
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      SHIM_KEY: "secret-key",
      CLAUDE_BIN: fakeClaude,
      CLAUDE_CONFIG_DIR: path.join(dir, "claude"),
      TURN_STATE_DIR: path.join(dir, "turn-state"),
      SESSION_STATE_FILE: stateFile,
      SESSION_BACKUP_DIR: path.join(dir, "backups"),
      SESSION_RESUME: "1",
      SESSION_BACKUPS: "0",
      COMPACT_HOOK: "0",
      TURN_TIMEOUT_MS: "0",
      WAKE_CHECK_MIN: "9999",
      BRAIN_MODELS: "claude-opus-4-6,claude-opus-5",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });

  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  for (let i = 0; i < 100 && !output.includes("kelivo-shim on"); i++) await delay(20);
  assert.match(output, /kelivo-shim on/);

  const base = `http://127.0.0.1:${port}`;
  await chat(base, "旧会话");
  const oldId = JSON.parse(fs.readFileSync(stateFile, "utf8")).sessionId;

  const login = await fetch(`${base}/admin/session/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ key: "secret-key" }),
  });
  assert.equal(login.status, 303);
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const adminPage = await fetch(`${base}/admin/session`, { headers: { cookie } });
  const csrf = (await adminPage.text()).match(/name="csrf" value="([^"]+)"/)?.[1];
  assert.ok(csrf);

  const switched = await fetch(`${base}/admin/session/fresh`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf }),
  });
  assert.equal(switched.status, 303);
  assert.equal(fs.existsSync(stateFile), false);

  const pending = await fetch(`${base}/debug`).then((response) => response.json());
  assert.equal(pending.session.awaitingFirstMessage, true);
  assert.equal(pending.session.idSuffix, null);
  assert.equal(pending.session.freshModel, "claude-opus-4-6");

  await chat(base, "全新会话的第一句话");
  const newId = JSON.parse(fs.readFileSync(stateFile, "utf8")).sessionId;
  assert.notEqual(newId, oldId);
  const ready = await fetch(`${base}/debug`).then((response) => response.json());
  assert.equal(ready.session.awaitingFirstMessage, false);
  assert.equal(ready.session.confirmed, true);

  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(3000)]);
});
