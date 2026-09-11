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

function flagValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

test("configured browser MCP is reported and allowed even with a custom allowlist", { timeout: 10_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kelivo-browser-server-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const argsFile = path.join(dir, "claude-args.jsonl");
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      SHIM_KEY: "secret-key",
      CLAUDE_BIN: fakeClaude,
      FAKE_CLAUDE_ARGS_FILE: argsFile,
      BROWSER_MCP_URL: "https://browser.example/mcp",
      BROWSER_MCP_TOKEN: "private-browser-token",
      ALLOWED_TOOLS: "WebFetch,mcp__ombre",
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

  const base = `http://127.0.0.1:${port}`;
  const debug = await fetch(`${base}/debug`).then((response) => response.json());
  assert.deepEqual(debug.browser, { configured: true, toolNamespace: "browser" });

  const response = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": "secret-key" },
    body: JSON.stringify({
      model: "claude-opus-4-6",
      stream: false,
      messages: [{ role: "user", content: "测试浏览器工具白名单" }],
    }),
  });
  assert.equal(response.status, 200);

  const launch = JSON.parse(fs.readFileSync(argsFile, "utf8").trim());
  assert.deepEqual(flagValue(launch, "--allowedTools").split(","), [
    "WebFetch", "mcp__ombre", "mcp__browser",
  ]);

  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(3000)]);
});
