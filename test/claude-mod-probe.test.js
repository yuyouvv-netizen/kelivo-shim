import assert from "node:assert/strict";
import test from "node:test";

import { register } from "../mods/kelivo-probe/hooks/register.js";
import {
  TOOL_DESCRIPTION_OVERRIDES,
  compactToolDescription,
} from "../mods/kelivo-probe/tool-descriptions.js";

process.env.CLAUDE_MOD_AUDIT_ENABLED = "1";

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
    originalChars: 33,
    savedChars: 0,
    compacted: false,
    origin: "mcp",
  }]);
  assert.doesNotMatch(JSON.stringify(audit), /stale/);
});

test("tool descriptions compact only an explicit allowlist", async () => {
  const hooks = new Map();
  register((event, handler) => hooks.set(event, handler));

  const writes = new Map();
  const api = {
    fs: {
      write: async (file, value) => writes.set(file, JSON.parse(value)),
    },
  };
  const originalDescription = "A deliberately long web-search description that contains repeated guidance.";
  const original = {
    description: originalDescription,
    untouched: true,
  };
  const compacted = await hooks.get("tool.describe")(
    api,
    { tool: "WebSearch", origin: { kind: "builtin" } },
    async () => original,
  );

  assert.notEqual(compacted, original);
  assert.equal(compacted.description, TOOL_DESCRIPTION_OVERRIDES.WebSearch);
  assert.equal(compacted.untouched, true);
  assert.equal(original.description, originalDescription);

  const audit = writes.get("/tmp/kelivo-claude-mod-tools.json");
  const entry = audit.tools.find((tool) => tool.name === "WebSearch");
  assert.equal(entry.originalChars, Array.from(originalDescription).length);
  assert.equal(entry.chars, Array.from(TOOL_DESCRIPTION_OVERRIDES.WebSearch).length);
  assert.equal(entry.compacted, true);
});

test("compacted descriptions retain behavior and safety boundaries", () => {
  assert.match(TOOL_DESCRIPTION_OVERRIDES.WebSearch, /Sources/);
  assert.match(TOOL_DESCRIPTION_OVERRIDES.WebSearch, /current year/);
  assert.match(TOOL_DESCRIPTION_OVERRIDES.mcp__garden__create_thread, /without publishing/);
  assert.match(TOOL_DESCRIPTION_OVERRIDES.mcp__garden__create_thread, /tags required/);
  assert.match(TOOL_DESCRIPTION_OVERRIDES.mcp__ombre__hold, /明确决定/);
  assert.match(TOOL_DESCRIPTION_OVERRIDES.mcp__ombre__hold, /逐字保存/);
  assert.equal(
    compactToolDescription("mcp__browser__x_like_post", "keep this exact boundary"),
    "keep this exact boundary",
  );
});
