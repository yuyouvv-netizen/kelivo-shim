import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
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

test("only wake turns record tool names without inputs or results", { timeout: 15_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kelivo-wake-server-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fakeClaudeBin = path.join(dir, "fake-claude");
  fs.writeFileSync(
    fakeClaudeBin,
    `#!/usr/bin/env node\nimport ${JSON.stringify(pathToFileURL(fakeClaude).href)};\n`,
    { mode: 0o700 },
  );
  const historyFile = path.join(dir, "wake-history.json");
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      SHIM_KEY: "secret-key",
      CLAUDE_BIN: fakeClaudeBin,
      FAKE_CLAUDE_TOOLS: "mcp__browser__x_read_home,mcp__status__look,mcp__browser__x_read_home",
      WAKE_HISTORY_FILE: historyFile,
      WAKE_MODE_FILE: path.join(dir, "wake-mode.json"),
      WAKE_MODE_DEFAULT: "always",
      TURN_STATE_DIR: path.join(dir, "turn-state"),
      SESSION_STATE_FILE: path.join(dir, "session.json"),
      SESSION_BACKUP_DIR: path.join(dir, "backups"),
      CLAUDE_CONFIG_DIR: path.join(dir, "claude"),
      SESSION_RESUME: "0",
      SESSION_BACKUPS: "0",
      COMPACT_HOOK: "0",
      TURN_TIMEOUT_MS: "0",
      WAKE_CHECK_MIN: "9999",
      WAKE_IDLE_MIN: "9999",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });

  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  for (let i = 0; i < 150 && !output.includes("kelivo-shim on"); i += 1) await delay(20);
  assert.match(output, /kelivo-shim on/);

  const base = `http://127.0.0.1:${port}`;
  let ordinary;
  try {
    ordinary = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "secret-key" },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        stream: false,
        messages: [{ role: "user", content: "普通对话不应进入心跳记录" }],
      }),
    });
  } catch (error) {
    throw new Error(`ordinary request failed: ${error?.message || error}\n${output}`);
  }
  assert.equal(ordinary.status, 200);
  assert.equal(fs.existsSync(historyFile), false);

  const heartbeat = await fetch(`${base}/hb?key=secret-key`, { method: "POST" });
  assert.deepEqual(await heartbeat.json(), {
    ok: true,
    triggered: true,
    waitingForHistory: false,
    reason: "forced",
  });
  for (let i = 0; i < 100; i += 1) {
    if (fs.existsSync(historyFile)) {
      const data = JSON.parse(fs.readFileSync(historyFile, "utf8"));
      if (data.runs?.[0]?.status !== "running") break;
    }
    await delay(20);
  }

  const saved = fs.readFileSync(historyFile, "utf8");
  const data = JSON.parse(saved);
  assert.equal(data.runs.length, 1);
  assert.equal(data.runs[0].status, "spoke");
  assert.deepEqual(data.runs[0].tools, ["mcp__browser__x_read_home", "mcp__status__look"]);
  assert.equal(saved.includes("not-recorded"), false);
  assert.equal(saved.includes("普通对话不应进入心跳记录"), false);

  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(3000)]);
});
