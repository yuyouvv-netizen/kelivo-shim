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

test("Kelivo effort reaches Claude Code and the phone receipt uses upstream evidence", { timeout: 15_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kelivo-attestation-"));
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
      FAKE_CLAUDE_THINKING: "1",
      TURN_STATE_DIR: path.join(dir, "turn-state"),
      SESSION_STATE_FILE: path.join(dir, "session.json"),
      SESSION_BACKUP_DIR: path.join(dir, "backups"),
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
  async function ask(content, effort) {
    const response = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "secret-key" },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        stream: false,
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort },
        messages: [{ role: "user", content }],
      }),
    });
    assert.equal(response.status, 200);
    assert.match(JSON.stringify(await response.json()), /原来那封联网回复/);
  }

  await ask("请重点想想", "high");
  await ask("这次中度想想", "medium");

  const launches = fs.readFileSync(argsFile, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(launches.length, 2);
  assert.equal(flagValue(launches[0], "--effort"), "high");
  assert.equal(flagValue(launches[1], "--effort"), "medium");
  assert.equal(flagValue(launches[1], "--resume"), flagValue(launches[0], "--session-id"));

  const debug = await fetch(`${base}/debug`).then((response) => response.json());
  assert.equal(debug.attestation.requestedModel, "claude-opus-4-6");
  assert.equal(debug.attestation.upstreamModel, "claude-opus-4-6");
  assert.equal(debug.attestation.requestedEffort, "medium");
  assert.equal(debug.attestation.effectiveEffort, "medium");
  assert.equal(debug.attestation.thinkingSeen, true);
  assert.equal(debug.attestation.signatureSeen, true);
  assert.equal(debug.attestation.signatureLength, "signed-upstream-thinking".length);

  const login = await fetch(`${base}/admin/window/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ key: "secret-key" }),
  });
  assert.equal(login.status, 303);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  const page = await fetch(`${base}/admin/window`, { headers: { cookie } }).then((response) => response.text());
  assert.match(page, /模型与思考验真/);
  assert.match(page, /上游实际模型/);
  assert.match(page, /一致 ✓/);
  assert.match(page, /中度（medium）/);
  assert.match(page, /已收到 ✓/);

  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(3000)]);
});
