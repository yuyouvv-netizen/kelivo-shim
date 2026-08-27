import test from "node:test";
import assert from "node:assert/strict";

import { diagnoseBirdMcp } from "../bird-mcp-diagnostic.js";

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
  });
}

test("bird diagnostic completes a read-only initialize and tools/list handshake", async () => {
  const calls = [];
  const responses = [
    jsonResponse({
      jsonrpc: "2.0", id: 1,
      result: {
        protocolVersion: "2025-03-26",
        serverInfo: { name: "sx119b-safe-bridge", version: "1.1.0" },
      },
    }, { headers: { "mcp-session-id": "private-session" } }),
    new Response(null, { status: 202 }),
    jsonResponse({
      jsonrpc: "2.0", id: 2,
      result: { tools: [{ name: "toy_control" }, { name: "toy_status" }] },
    }),
  ];
  const result = await diagnoseBirdMcp({
    url: "https://bridge.example/mcp/private-path",
    fetchImpl: async (_url, init) => {
      calls.push(init);
      return responses.shift();
    },
  });

  assert.deepEqual(result, {
    configured: true,
    ready: true,
    status: "ok",
    pathLooksLikeMcp: true,
    protocolVersion: "2025-03-26",
    serverName: "sx119b-safe-bridge",
    toolNames: ["toy_control", "toy_status"],
  });
  assert.deepEqual(calls.map((call) => JSON.parse(call.body).method), [
    "initialize", "notifications/initialized", "tools/list",
  ]);
  assert.equal(calls[2].headers["MCP-Session-Id"], "private-session");
});

test("bird diagnostic reports a wrong private MCP path without exposing it", async () => {
  const result = await diagnoseBirdMcp({
    url: "https://bridge.example/not-the-secret-mcp-path",
    fetchImpl: async () => new Response("not found", { status: 404 }),
  });
  assert.deepEqual(result, {
    configured: true,
    ready: false,
    status: "http-error",
    pathLooksLikeMcp: false,
    httpStatus: 404,
  });
  assert.equal(JSON.stringify(result).includes("not-the-secret-mcp-path"), false);
});

test("bird diagnostic requires both expected tools", async () => {
  const responses = [
    jsonResponse({
      jsonrpc: "2.0", id: 1,
      result: { protocolVersion: "2025-03-26", serverInfo: { name: "other" } },
    }),
    new Response(null, { status: 202 }),
    jsonResponse({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "toy_status" }] } }),
  ];
  const result = await diagnoseBirdMcp({
    url: "https://bridge.example/mcp/private-path",
    fetchImpl: async () => responses.shift(),
  });
  assert.equal(result.ready, false);
  assert.equal(result.status, "unexpected-tools");
  assert.deepEqual(result.toolNames, ["toy_status"]);
});
