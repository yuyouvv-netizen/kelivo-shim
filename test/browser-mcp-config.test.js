import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { configureBrowserMcp } from "../browser-mcp-config.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kelivo-browser-mcp-"));
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
    dir,
    runtime,
    persistent,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test("browser MCP stays disabled when neither setting is present", () => {
  assert.deepEqual(configureBrowserMcp({ env: {}, files: [] }), {
    configured: false,
    updatedFiles: [],
  });
});

test("browser MCP is merged into runtime and persistent configs without replacing peers", () => {
  const f = fixture();
  try {
    const env = {
      BROWSER_MCP_URL: "https://browser.example/mcp",
      BROWSER_MCP_TOKEN: "private-browser-token",
    };
    const result = configureBrowserMcp({ env, files: [f.runtime, f.persistent] });
    assert.equal(result.configured, true);
    assert.deepEqual(result.updatedFiles, [f.runtime, f.persistent]);

    const runtime = JSON.parse(fs.readFileSync(f.runtime, "utf8"));
    const persistent = JSON.parse(fs.readFileSync(f.persistent, "utf8"));
    const expected = {
      type: "http",
      url: "https://browser.example/mcp",
      headers: { "X-Token": "private-browser-token" },
    };
    assert.deepEqual(runtime.mcpServers.browser, expected);
    assert.deepEqual(persistent.mcpServers.browser, expected);
    assert.ok(runtime.mcpServers.ombre);
    assert.ok(runtime.mcpServers.gmail);
    assert.ok(persistent.mcpServers.ombre);
    assert.ok(persistent.mcpServers.toy);

    assert.deepEqual(configureBrowserMcp({ env, files: [f.runtime, f.persistent] }), {
      configured: true,
      updatedFiles: [],
    });
  } finally {
    f.cleanup();
  }
});

test("browser MCP creates a missing persistent config from the runtime config", () => {
  const f = fixture();
  try {
    fs.unlinkSync(f.persistent);
    configureBrowserMcp({
      env: {
        BROWSER_MCP_URL: "https://browser.example/mcp/",
        BROWSER_MCP_TOKEN: "private-browser-token",
      },
      files: [f.runtime, f.persistent],
    });
    const persistent = JSON.parse(fs.readFileSync(f.persistent, "utf8"));
    assert.ok(persistent.mcpServers.ombre);
    assert.ok(persistent.mcpServers.gmail);
    assert.equal(persistent.mcpServers.browser.url, "https://browser.example/mcp/");
  } finally {
    f.cleanup();
  }
});

test("browser MCP rejects partial or unsafe settings without exposing the token", () => {
  const invalid = [
    { BROWSER_MCP_URL: "https://browser.example/mcp" },
    { BROWSER_MCP_TOKEN: "secret-do-not-log" },
    { BROWSER_MCP_URL: "http://browser.example/mcp", BROWSER_MCP_TOKEN: "secret-do-not-log" },
    { BROWSER_MCP_URL: "https://user:pass@browser.example/mcp", BROWSER_MCP_TOKEN: "secret-do-not-log" },
    { BROWSER_MCP_URL: "https://browser.example/not-mcp", BROWSER_MCP_TOKEN: "secret-do-not-log" },
    { BROWSER_MCP_URL: "https://browser.example/mcp?token=bad", BROWSER_MCP_TOKEN: "secret-do-not-log" },
  ];
  for (const env of invalid) {
    assert.throws(() => configureBrowserMcp({ env, files: ["unused"] }), (error) => {
      assert.equal(String(error).includes("secret-do-not-log"), false);
      return true;
    });
  }
});
