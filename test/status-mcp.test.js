import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(import.meta.dirname, "..");

test("stdio MCP exposes exactly one parameterless look tool", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kelivo-status-mcp-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "now.json");
  const client = new Client({ name: "status-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "status-mcp.js")],
    env: { ...process.env, STATUS_FILE: file },
  });
  await client.connect(transport);
  t.after(() => client.close());

  const listed = await client.listTools();
  assert.equal(listed.tools.length, 1);
  assert.equal(listed.tools[0].name, "look");
  assert.deepEqual(listed.tools[0].inputSchema, {
    type: "object",
    properties: {},
    additionalProperties: false,
  });
  assert.match(listed.tools[0].description, /不要轮询/);
  assert.match(listed.tools[0].description, /不得写入 OB/);

  const empty = await client.callTool({ name: "look", arguments: {} });
  assert.equal(empty.isError, false);
  assert.match(empty.content[0].text, /她没有留下状态/);
  assert.match(empty.content[0].text, /不要因此向她追问/);
});
