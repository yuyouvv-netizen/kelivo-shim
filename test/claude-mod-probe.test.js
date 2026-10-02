import assert from "node:assert/strict";
import test from "node:test";

import { register } from "../mods/kelivo-probe/hooks/register.js";

test("metadata probe observes events without changing or storing prompt text", async () => {
  const hooks = new Map();
  register((event, handler) => hooks.set(event, handler));

  let receipt = null;
  const api = {
    fs: {
      write: async (_file, value) => {
        receipt = JSON.parse(value);
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

  assert.equal(receipt.loaded, true);
  assert.deepEqual(receipt.sections, ["communication"]);
  assert.deepEqual(receipt.attachments.date, { count: 1, origins: ["engine"] });
  assert.deepEqual(receipt.compose, [{ id: "communication", scope: "main" }]);
  assert.deepEqual(receipt.usage, { tokens: 1234, window: 200000, percent: 0.617 });
  assert.doesNotMatch(JSON.stringify(receipt), /private|must-not-be-written/);
});
