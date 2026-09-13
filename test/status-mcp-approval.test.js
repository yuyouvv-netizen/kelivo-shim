import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { approveStatusMcp } from "../status-mcp-approval.js";

test("status MCP approval is added without replacing Claude settings", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kelivo-status-mcp-approval-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const settingsFile = path.join(dir, "settings.json");
  fs.writeFileSync(settingsFile, JSON.stringify({
    permissions: { allow: ["WebFetch"] },
    enabledMcpjsonServers: ["ombre", "status"],
    disabledMcpjsonServers: ["fish", "status"],
  }));

  const result = approveStatusMcp({ settingsFile });
  assert.equal(result.approved, true);
  assert.equal(result.updated, true);
  assert.equal(result.settingsFile, settingsFile);

  const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  assert.deepEqual(settings.permissions, { allow: ["WebFetch"] });
  assert.deepEqual(settings.enabledMcpjsonServers, ["ombre", "status"]);
  assert.deepEqual(settings.disabledMcpjsonServers, ["fish"]);
  assert.equal(fs.statSync(settingsFile).mode & 0o777, 0o600);
  assert.equal(approveStatusMcp({ settingsFile }).updated, false);
});

test("status MCP approval creates the config directory when absent", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kelivo-status-mcp-approval-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configDir = path.join(dir, "claude");

  const result = approveStatusMcp({ env: { CLAUDE_CONFIG_DIR: configDir } });
  const settings = JSON.parse(fs.readFileSync(result.settingsFile, "utf8"));
  assert.deepEqual(settings, { enabledMcpjsonServers: ["status"] });
});

test("status MCP approval rejects a non-object settings document", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kelivo-status-mcp-approval-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const settingsFile = path.join(dir, "settings.json");
  fs.writeFileSync(settingsFile, "[]\n");

  assert.throws(() => approveStatusMcp({ settingsFile }), /JSON object/);
  assert.equal(fs.readFileSync(settingsFile, "utf8"), "[]\n");
});
