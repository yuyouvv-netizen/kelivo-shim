import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
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

async function startServer(t, mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kelivo-${mode}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      CLAUDE_BIN: fakeClaude,
      FAKE_CLAUDE_EMPTY_SUCCESS: mode === "empty" ? "1" : "0",
      FAKE_CLAUDE_THINKING_EMPTY_SUCCESS: mode === "thinking-empty" ? "1" : "0",
      FAKE_CLAUDE_API_ERROR: mode === "api-error" ? "1" : "0",
      FAKE_CLAUDE_RESULT_ONLY_TEXT: mode === "result-only" ? "1" : "0",
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
  for (let i = 0; i < 100 && !output.includes("kelivo-shim on"); i++) await delay(20);
  assert.match(output, /kelivo-shim on/);
  return { base: `http://127.0.0.1:${port}`, child, output: () => output };
}

async function ask(base) {
  const response = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-opus-4-6",
      stream: false,
      messages: [{ role: "user", content: "只回复在" }],
    }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

test("a zero-token success becomes a visible non-replayable empty-result", { timeout: 20_000 }, async (t) => {
  const { base, child } = await startServer(t, "empty");
  const body = await ask(base);
  assert.match(body.content[0].text, /Claude 上游空回/);
  assert.match(body.content[0].text, /原生会话仍保留/);

  const debug = await fetch(`${base}/debug`).then((response) => response.json());
  assert.equal(debug.attestation.status, "empty-result");
  assert.equal(debug.attestation.emptyResult, true);
  assert.equal(debug.attestation.isError, false);
  assert.equal(debug.attestation.apiErrorStatus, null);
  assert.equal(debug.attestation.terminalReason, "completed");
  assert.equal(debug.delivery.currentStatus, "empty-result");
  assert.equal(debug.delivery.cachedReplies, 0);

  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(3000)]);
});

test("a successful result envelope restores text missing from stream events", { timeout: 20_000 }, async (t) => {
  const { base, child } = await startServer(t, "result-only");
  const response = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-opus-4-6",
      stream: true,
      messages: [{ role: "user", content: "请思考后回复" }],
    }),
  });
  assert.equal(response.status, 200);
  const stream = await response.text();
  assert.match(stream, /我已经写完，正在交付。/);
  assert.match(stream, /只出现在最终结果里的正文/);
  assert.doesNotMatch(stream, /Claude 上游空回/);

  const debug = await fetch(`${base}/debug`).then((reply) => reply.json());
  assert.equal(debug.attestation.status, "completed");
  assert.equal(debug.attestation.emptyResult, false);
  assert.equal(debug.delivery.currentStatus, "completed");

  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(3000)]);
});

test("thinking with zero final text becomes a visible diagnostic without replay", { timeout: 20_000 }, async (t) => {
  const { base, child, output } = await startServer(t, "thinking-empty");
  const body = await ask(base);
  assert.match(body.content[0].text, /⚠️〔本轮空回〕/);
  assert.match(body.content[0].text, /达到输出上限/);
  assert.match(body.content[0].text, /原生会话仍保留/);
  assert.equal(body.stop_reason, "max_tokens");

  const debug = await fetch(`${base}/debug`).then((response) => response.json());
  assert.equal(debug.attestation.status, "empty-result");
  assert.equal(debug.attestation.emptyResult, true);
  assert.equal(debug.attestation.emptyAfterThinking, true);
  assert.equal(debug.attestation.stopReason, "max_tokens");
  assert.equal(debug.attestation.stopReasonSource, "stream");
  assert.equal(debug.attestation.lastTool, "mcp__browser__x_read_post");
  assert.equal(debug.attestation.toolCallCount, 1);
  assert.deepEqual(debug.attestation.tokenUsage, {
    inputTokens: 420,
    outputTokens: 64,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 120,
    thinkingTokens: 64,
    maxOutputTokens: 64,
  });
  assert.equal(debug.delivery.currentStatus, "empty-result");
  assert.equal(debug.delivery.cachedReplies, 0);
  assert.match(output(), /\[delivery\] turn finished \{"src":"kelivo"/);
  assert.match(output(), /"stopReason":"max_tokens"/);
  assert.match(output(), /"lastTool":"mcp__browser__x_read_post"/);

  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(3000)]);
});

test("a success envelope carrying an API error exposes the real upstream fields", { timeout: 20_000 }, async (t) => {
  const { base, child } = await startServer(t, "api-error");
  const body = await ask(base);
  assert.match(body.content[0].text, /Claude 上游限流/);
  assert.match(body.content[0].text, /HTTP 429/);

  const debug = await fetch(`${base}/debug`).then((response) => response.json());
  assert.equal(debug.attestation.status, "upstream-error");
  assert.equal(debug.attestation.isError, true);
  assert.equal(debug.attestation.apiErrorStatus, 429);
  assert.equal(debug.attestation.terminalReason, "api_error");
  assert.match(debug.attestation.errorMessage, /rate limit reached/);
  assert.equal(debug.delivery.currentStatus, "upstream-error");

  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(3000)]);
});
