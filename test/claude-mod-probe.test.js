import assert from "node:assert/strict";
import test from "node:test";

import { register } from "../mods/kelivo-probe/hooks/register.js";

test("metadata probe observes events without changing or storing prompt text", async () => {
  const hooks = new Map();
  register((event, handler) => hooks.set(event, handler));

  const writes = new Map();
  const api = {
    fs: {
      write: async (file, value) => {
        writes.set(file, JSON.parse(value));
      },
    },
    session: {
      usage: async () => ({
        context: { tokens: 1234, window: 200000, percent: 0.617 },
        cost: { secret: "must-not-be-written" },
      }),
    },
  };

  const start = { reason: "startup" };
  assert.equal(await hooks.get("session.start")(api, start, async (event) => event), start);

  const sectionResult = { text: "private system prompt" };
  assert.equal(await hooks.get("prompt.section")(
    api,
    { name: "communication" },
    async () => sectionResult,
  ), sectionResult);

  const attachment = {
    type: "date",
    origin: { kind: "engine" },
    text: "private reminder text",
  };
  assert.equal(await hooks.get("prompt.attachment")(
    api,
    attachment,
    async (event) => event,
  ), attachment);

  const composeResult = {
    sections: [{ id: "communication", scope: "main", text: "private composed text" }],
  };
  assert.equal(await hooks.get("prompt.compose")(
    api,
    {},
    async () => composeResult,
  ), composeResult);

  const measure = { reason: "turn" };
  assert.equal(await hooks.get("session.measure")(
    api,
    measure,
    async (event) => event,
  ), measure);

  const toolDescription = {
    description: "Read a post without modifying it.",
  };
  assert.equal(await hooks.get("tool.describe")(
    api,
    {
      tool: "mcp__browser__x_read_post",
      origin: { kind: "mcp" },
      description: "A stale description that Claude will not receive.",
    },
    async () => toolDescription,
  ), toolDescription);

  const receipt = writes.get("/tmp/kelivo-claude-mod-probe.json");
  assert.equal(receipt.loaded, true);
  assert.deepEqual(receipt.sections, ["communication"]);
  assert.deepEqual(receipt.attachments.date, { count: 1, origins: ["engine"] });
  assert.deepEqual(receipt.compose, [{ id: "communication", scope: "main" }]);
  assert.deepEqual(receipt.usage, { tokens: 1234, window: 200000, percent: 0.617 });
  assert.doesNotMatch(JSON.stringify(receipt), /private|must-not-be-written/);

  const audit = writes.get("/tmp/kelivo-claude-mod-tools.json");
  assert.equal(audit.count, 1);
  assert.deepEqual(audit.tools, [{
    name: "mcp__browser__x_read_post",
    description: "Read a post without modifying it.",
    chars: 33,
    origin: "mcp",
  }]);
  assert.doesNotMatch(JSON.stringify(audit), /stale/);
});
