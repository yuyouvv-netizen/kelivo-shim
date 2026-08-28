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

test("disconnect recovery works and window words remain ordinary conversation", { timeout: 10_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kelivo-server-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const countFile = path.join(dir, "turn-count.txt");
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      CLAUDE_BIN: fakeClaude,
      FAKE_CLAUDE_COUNT_FILE: countFile,
      TURN_STATE_DIR: path.join(dir, "turn-state"),
      SESSION_STATE_FILE: path.join(dir, "session.json"),
      SESSION_BACKUP_DIR: path.join(dir, "backups"),
      SESSION_RESUME: "0",
      SESSION_BACKUPS: "0",
      COMPACT_HOOK: "0",
      TURN_TIMEOUT_MS: "0",
      WAKE_CHECK_MIN: "9999",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  for (let i = 0; i < 150 && !output.includes("kelivo-shim on"); i++) await delay(20);
  assert.match(output, /kelivo-shim on/);

  const body = JSON.stringify({
    model: "claude-opus-4-6",
    stream: true,
    messages: [{ role: "user", content: "帮我联网查一下" }],
  });
  const firstAbort = new AbortController();
  const first = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body,
    signal: firstAbort.signal,
  });
  assert.equal(first.status, 200);
  firstAbort.abort();
  await delay(350);

  const second = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body,
  });
  const replay = await second.text();
  assert.match(replay, /原来那封联网回复/);
  assert.equal(fs.readFileSync(countFile, "utf8").trim().split("\n").length, 1);

  const ordinary = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-opus-4-6",
      stream: true,
      messages: [{ role: "user", content: "我不想换窗口" }],
    }),
  });
  const ordinaryReply = await ordinary.text();
  assert.match(ordinaryReply, /原来那封联网回复/);
  assert.doesNotMatch(ordinaryReply, /窗口保住了|归档好了|新窗口见/);
  assert.equal(fs.readFileSync(countFile, "utf8").trim().split("\n").length, 2);

  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(3000)]);
});

test("a process exit abandons the turn without automatically resubmitting the user message", { timeout: 10_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kelivo-no-retry-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const countFile = path.join(dir, "turn-count.txt");
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      CLAUDE_BIN: fakeClaude,
      FAKE_CLAUDE_COUNT_FILE: countFile,
      FAKE_CLAUDE_EXIT_ON_TURN: "1",
      TURN_STATE_DIR: path.join(dir, "turn-state"),
      SESSION_STATE_FILE: path.join(dir, "session.json"),
      SESSION_BACKUP_DIR: path.join(dir, "backups"),
      SESSION_RESUME: "0",
      SESSION_BACKUPS: "0",
      COMPACT_HOOK: "0",
      TURN_TIMEOUT_MS: "0",
      WAKE_CHECK_MIN: "9999",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  for (let i = 0; i < 150 && !output.includes("kelivo-shim on"); i++) await delay(20);
  assert.match(output, /kelivo-shim on/);

  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-opus-4-6",
      stream: true,
      messages: [{ role: "user", content: "这轮失败就放弃，不要替我重问" }],
    }),
  });
  const text = await response.text();
  await delay(200);

  assert.match(text, /进程已断开/);
  assert.equal(fs.readFileSync(countFile, "utf8").trim().split("\n").length, 1);

  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(3000)]);
});
