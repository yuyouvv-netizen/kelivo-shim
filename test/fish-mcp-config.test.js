import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { configureFishMcp } from "../fish-mcp-config.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kelivo-fish-mcp-"));
  const runtime = path.join(dir, "runtime.json");
  const persistentDir = path.join(dir, "persona");
  const persistent = path.join(persistentDir, ".mcp.json");
  fs.mkdirSync(persistentDir);
  fs.writeFileSync(runtime, JSON.stringify({
    mcpServers: {
      ombre: { type: "http", url: "https://memory.example/mcp" },
      gmail: { command: "gmail-mcp" },
    },
  }));
  fs.writeFileSync(persistent, JSON.stringify({
    mcpServers: {
      ombre: { type: "http", url: "https://memory.example/mcp" },
      toy: { type: "http", url: "https://toy.example/mcp/private" },
    },
  }));
  return {
    runtime,
    persistent,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test("fish MCP stays disabled when neither setting is present", () => {
  assert.deepEqual(configureFishMcp({ env: {}, files: [] }), {
    configured: false,
    updatedFiles: [],
  });
});

test("fish MCP is merged without replacing existing services or persisting secrets", () => {
  const f = fixture();
  try {
    const env = {
      FISHING_MCP_URL: "https://fish.example/mcp",
      FISHING_MCP_TOKEN: "private-fish-token",
    };
    const result = configureFishMcp({ env, files: [f.runtime, f.persistent] });
    assert.equal(result.configured, true);
    assert.deepEqual(result.updatedFiles, [f.runtime, f.persistent]);

    const expected = {
      type: "http",
      url: "${FISHING_MCP_URL}",
      headers: { "X-Token": "${FISHING_MCP_TOKEN}" },
    };
    for (const file of [f.runtime, f.persistent]) {
      const config = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.deepEqual(config.mcpServers.fish, expected);
      assert.ok(config.mcpServers.ombre);
      assert.equal(fs.readFileSync(file, "utf8").includes("private-fish-token"), false);
      assert.equal(fs.readFileSync(file, "utf8").includes("fish.example"), false);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }

    assert.deepEqual(configureFishMcp({ env, files: [f.runtime, f.persistent] }), {
      configured: true,
      updatedFiles: [],
    });
  } finally {
    f.cleanup();
  }
});

test("fish MCP creates a missing persistent config from runtime", () => {
  const f = fixture();
  try {
    fs.unlinkSync(f.persistent);
    configureFishMcp({
      env: {
        FISHING_MCP_URL: "https://fish.example/mcp/",
        FISHING_MCP_TOKEN: "private-fish-token",
      },
      files: [f.runtime, f.persistent],
    });
    const persistent = JSON.parse(fs.readFileSync(f.persistent, "utf8"));
    assert.ok(persistent.mcpServers.ombre);
    assert.ok(persistent.mcpServers.gmail);
    assert.equal(persistent.mcpServers.fish.url, "${FISHING_MCP_URL}");
    assert.equal(persistent.mcpServers.fish.headers["X-Token"], "${FISHING_MCP_TOKEN}");
  } finally {
    f.cleanup();
  }
});

test("fish MCP rejects partial or unsafe settings without exposing the token", () => {
  const invalid = [
    { FISHING_MCP_URL: "https://fish.example/mcp" },
    { FISHING_MCP_TOKEN: "secret-do-not-log" },
    { FISHING_MCP_URL: "http://fish.example/mcp", FISHING_MCP_TOKEN: "secret-do-not-log" },
    { FISHING_MCP_URL: "https://user:pass@fish.example/mcp", FISHING_MCP_TOKEN: "secret-do-not-log" },
    { FISHING_MCP_URL: "https://fish.example/not-mcp", FISHING_MCP_TOKEN: "secret-do-not-log" },
    { FISHING_MCP_URL: "https://fish.example/mcp?token=bad", FISHING_MCP_TOKEN: "secret-do-not-log" },
  ];
  for (const env of invalid) {
    assert.throws(() => configureFishMcp({ env, files: ["unused"] }), (error) => {
      assert.equal(String(error).includes("secret-do-not-log"), false);
      return true;
    });
  }
});
