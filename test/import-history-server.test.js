import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";

import { ImportHistoryStore } from "../import-history.js";

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

test("pending import is authenticated, isolated and replay-safe", { timeout: 15_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kelivo-import-server-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const importDir = path.join(dir, "imports");
  const stateFile = path.join(dir, "session.json");
  const countFile = path.join(dir, "turn-count.txt");
  const inputFile = path.join(dir, "turn-inputs.jsonl");
  const store = new ImportHistoryStore({ dir: importDir, sessionStateFile: stateFile });
  store.prepare({
    source: "claude-share",
    messages: [
      { role: "user", content: "官端旧消息" },
      { role: "assistant", content: "官端旧回复" },
    ],
  });

  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      SHIM_KEY: "secret-key",
      CLAUDE_BIN: fakeClaude,
      FAKE_CLAUDE_COUNT_FILE: countFile,
      FAKE_CLAUDE_INPUT_FILE: inputFile,
      IMPORT_HISTORY_DIR: importDir,
      CLAUDE_CONFIG_DIR: path.join(dir, "claude"),
      TURN_STATE_DIR: path.join(dir, "turn-state"),
      SESSION_STATE_FILE: stateFile,
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

  const base = `http://127.0.0.1:${port}`;
  const firstBody = JSON.stringify({
    model: "claude-opus-4-6",
    stream: false,
    messages: [{ role: "user", content: "接着官端说下去" }],
  });
  const unauthorized = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: firstBody,
  });
  assert.equal(unauthorized.status, 401);
  assert.equal(store.status().state, "pending");

  const heartbeat = await fetch(`${base}/hb?key=secret-key`, { method: "POST" }).then((response) => response.json());
  assert.equal(heartbeat.triggered, false);
  assert.equal(heartbeat.reason, "import-pending");

  const titlePrompt = `I will give you some dialogue content in the \`<content>\` block.
You need to summarize the conversation between user and assistant into a short title.
Reply directly with the title. The title should not exceed 10 characters.
<content>User: 空白新聊天</content>`;
  const title = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": "secret-key" },
    body: JSON.stringify({
      model: "claude-opus-4-6",
      stream: false,
      messages: [{ role: "user", content: titlePrompt }],
    }),
  });
  assert.equal(title.status, 200);
  assert.equal(store.status().state, "pending");
  assert.equal(fs.existsSync(countFile), false);

  const oldWindow = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": "secret-key" },
    body: JSON.stringify({
      model: "claude-opus-4-6",
      stream: false,
      messages: [
        { role: "user", content: "旧窗口第一句" },
        { role: "assistant", content: "旧窗口回复" },
        { role: "user", content: "旧窗口误发" },
      ],
    }),
  });
  assert.equal(oldWindow.status, 409);
  assert.equal(store.status().state, "pending");
  assert.equal(fs.existsSync(countFile), false);

  const moved = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": "secret-key" },
    body: firstBody,
  });
  assert.equal(moved.status, 200);
  assert.equal(moved.headers.get("x-kelivo-imported-history"), "2");
  assert.match(JSON.stringify(await moved.json()), /原来那封联网回复/);
  assert.equal(store.status().state, "consumed");
  assert.equal(fs.readFileSync(countFile, "utf8").trim().split("\n").length, 1);
  const modelInput = JSON.parse(fs.readFileSync(inputFile, "utf8").trim().split("\n")[0]);
  assert.match(modelInput, /官端旧消息/);
  assert.match(modelInput, /官端旧回复/);
  assert.match(modelInput, /【当前新消息】/);
  assert.match(modelInput, /接着官端说下去/);

  const retried = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": "secret-key" },
    body: firstBody,
  });
  assert.equal(retried.status, 200);
  assert.match(JSON.stringify(await retried.json()), /原来那封联网回复/);
  assert.equal(fs.readFileSync(countFile, "utf8").trim().split("\n").length, 1);

  const debug = await fetch(`${base}/debug`).then((response) => response.json());
  assert.equal(debug.import.state, "consumed");
  assert.equal(debug.import.messages, 2);
  assert.equal(JSON.stringify(debug).includes("官端旧消息"), false);

  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(3000)]);
});
