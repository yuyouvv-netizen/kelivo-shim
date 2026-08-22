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

test("default model list exposes Opus 5 without changing the current default", { timeout: 10_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kelivo-models-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const port = await freePort();
  const env = {
    ...process.env,
    PORT: String(port),
    CLAUDE_BIN: fakeClaude,
    TURN_STATE_DIR: path.join(dir, "turn-state"),
    SESSION_STATE_FILE: path.join(dir, "session.json"),
    SESSION_BACKUP_DIR: path.join(dir, "backups"),
    SESSION_RESUME: "0",
    SESSION_BACKUPS: "0",
    COMPACT_HOOK: "0",
    TURN_TIMEOUT_MS: "0",
    WAKE_CHECK_MIN: "9999",
  };
  delete env.BRAIN_MODEL;
  delete env.BRAIN_MODELS;

  const child = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });

  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  for (let i = 0; i < 100 && !output.includes("kelivo-shim on"); i++) await delay(20);
  assert.match(output, /kelivo-shim on/);

  const response = await fetch(`http://127.0.0.1:${port}/v1/models`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.data.map((model) => model.id), [
    "claude-opus-4-6",
    "claude-opus-4-8",
    "claude-opus-5",
    "claude-fable-5",
  ]);
  assert.equal(payload.first_id, "claude-opus-4-6");
  assert.equal(payload.has_more, false);

  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(3000)]);
});
