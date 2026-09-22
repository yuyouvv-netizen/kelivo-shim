import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";

import { STOP_SEQUENCE_NOTICE } from "../stop-sequence.js";

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

async function startServer(t, guardMode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kelivo-stop-guard-${guardMode}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const port = await freePort();
  const countFile = path.join(dir, "turn-count.txt");
  const child = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      CLAUDE_BIN: fakeClaude,
      FAKE_CLAUDE_STOP_SEQUENCE: guardMode,
      FAKE_CLAUDE_COUNT_FILE: countFile,
      TURN_STATE_DIR: path.join(dir, "turn-state"),
      STOP_SEQUENCE_STATE_FILE: path.join(dir, "stop-sequence.json"),
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
  return {
    base: `http://127.0.0.1:${port}`,
    child,
    countFile,
    turnStateFile: path.join(dir, "turn-state", "current-turn.json"),
    mailboxFile: path.join(dir, "turn-state", "mailbox.json"),
  };
}

function requestBody(text) {
  return JSON.stringify({
    model: "claude-opus-5",
    stream: true,
    messages: [{ role: "user", content: text }],
  });
}

async function ask(base, text) {
  const response = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: requestBody(text),
  });
  assert.equal(response.status, 200);
  return response.text();
}

async function stopServer(child) {
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(3000)]);
}

test("a guarded turn delivers only the safe prefix and remains replayable", { timeout: 15_000 }, async (t) => {
  const { base, child, turnStateFile } = await startServer(t, "text");
  const stream = await ask(base, "触发一次保护");

  assert.match(stream, /这是触发串以前的安全正文/);
  assert.doesNotMatch(stream, /异常续写已拦截|Claude 上游错误|custom stop sequence reached/);

  const debug = await fetch(`${base}/debug`).then((response) => response.json());
  assert.equal(debug.attestation.status, "guarded");
  assert.equal(debug.attestation.stopSequenceBlocked, true);
  assert.equal(debug.attestation.safeTextAvailable, true);
  assert.equal(debug.attestation.stopReason, "stop_sequence");
  assert.equal(debug.stopSequence.count, 1);
  assert.equal(debug.delivery.currentStatus, "guarded");
  assert.equal(debug.delivery.cachedReplies, 1);

  const current = JSON.parse(fs.readFileSync(turnStateFile, "utf8"));
  assert.equal(current.responseText, "这是触发串以前的安全正文。");
  assert.equal(current.status, "guarded");
  await stopServer(child);
});

test("guard hits without safe text show a phone-only notice and never enter recovery state", { timeout: 15_000 }, async (t) => {
  const { base, child, countFile, turnStateFile, mailboxFile } = await startServer(t, "empty");
  const first = await ask(base, "第一次触发保护");
  const second = await ask(base, "第二次触发保护");

  assert.match(first, new RegExp(STOP_SEQUENCE_NOTICE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(second, /异常续写已拦截/);
  assert.doesNotMatch(first + second, /Claude 上游错误|custom stop sequence reached/);

  const debug = await fetch(`${base}/debug`).then((response) => response.json());
  assert.equal(debug.attestation.status, "guarded");
  assert.equal(debug.attestation.safeTextAvailable, false);
  assert.equal(debug.stopSequence.count, 2);
  assert.equal(debug.delivery.currentStatus, "guarded");
  assert.equal(debug.delivery.cachedReplies, 0);
  assert.equal(fs.readFileSync(countFile, "utf8").trim().split("\n").length, 2);

  const current = JSON.parse(fs.readFileSync(turnStateFile, "utf8"));
  assert.equal(current.responseText, "");
  assert.equal(current.status, "guarded");
  assert.deepEqual(JSON.parse(fs.readFileSync(mailboxFile, "utf8")), []);
  await stopServer(child);
});

test("a phone stop does not retry or persist the guard notice as model text", { timeout: 15_000 }, async (t) => {
  const { base, child, countFile, turnStateFile, mailboxFile } = await startServer(t, "empty");
  const controller = new AbortController();
  const response = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: requestBody("手机随后会停止等待"),
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  controller.abort();
  await delay(150);

  assert.equal(fs.readFileSync(countFile, "utf8").trim().split("\n").length, 1);
  const current = JSON.parse(fs.readFileSync(turnStateFile, "utf8"));
  assert.equal(current.status, "guarded");
  assert.equal(current.responseText, "");
  assert.deepEqual(JSON.parse(fs.readFileSync(mailboxFile, "utf8")), []);

  const debug = await fetch(`${base}/debug`).then((reply) => reply.json());
  assert.equal(debug.delivery.currentStatus, "guarded");
  assert.equal(debug.delivery.cachedReplies, 0);
  await stopServer(child);
});
