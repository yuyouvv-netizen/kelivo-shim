import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { configureStatusMcp } from "../status-mcp-config.js";

test("status MCP is merged without replacing private peer services", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kelivo-status-mcp-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = path.join(dir, "runtime.json");
  const persistentDir = path.join(dir, "persona");
  const persistent = path.join(persistentDir, ".mcp.json");
  fs.mkdirSync(persistentDir);
  fs.writeFileSync(runtime, JSON.stringify({
    mcpServers: { ombre: { type: "http", url: "https://memory.example/mcp" } },
  }));
  fs.writeFileSync(persistent, JSON.stringify({
    mcpServers: { toy: { type: "http", url: "https://toy.example/mcp/private" } },
  }));
  const script = path.join(dir, "status-mcp.js");
  const statusFile = path.join(persistentDir, "status", "now.json");

  const result = configureStatusMcp({
    env: { STATUS_FILE: statusFile },
    files: [runtime, persistent],
    script,
  });
  assert.deepEqual(result.updatedFiles, [runtime, persistent]);
  const expected = {
    command: "node",
    args: [script],
    env: { STATUS_FILE: statusFile },
  };
  const runtimeConfig = JSON.parse(fs.readFileSync(runtime, "utf8"));
  const persistentConfig = JSON.parse(fs.readFileSync(persistent, "utf8"));
  assert.deepEqual(runtimeConfig.mcpServers.status, expected);
  assert.deepEqual(persistentConfig.mcpServers.status, expected);
  assert.ok(runtimeConfig.mcpServers.ombre);
  assert.ok(persistentConfig.mcpServers.toy);
  assert.equal(fs.statSync(runtime).mode & 0o777, 0o600);
  assert.equal(fs.statSync(persistent).mode & 0o777, 0o600);
  assert.deepEqual(configureStatusMcp({
    env: { STATUS_FILE: statusFile },
    files: [runtime, persistent],
    script,
  }).updatedFiles, []);
});

test("status MCP rejects relative storage paths", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kelivo-status-mcp-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = path.join(dir, "runtime.json");
  fs.writeFileSync(runtime, JSON.stringify({ mcpServers: {} }));
  assert.throws(() => configureStatusMcp({
    env: { STATUS_FILE: "relative/now.json" },
    files: [runtime],
    script: path.join(dir, "status-mcp.js"),
  }), /must be absolute/);
});
