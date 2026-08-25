import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { AiNameStore, normalizeAiName } from "../ai-name.js";

test("AI names keep Unicode while removing unsafe whitespace and controls", () => {
  assert.equal(normalizeAiName("  小\n克 🤍  "), "小克 🤍");
  assert.equal(normalizeAiName("\u0000\u0007", "TA"), "TA");
  assert.equal(normalizeAiName("又".repeat(33), "TA"), "TA");
});

test("AI name changes persist privately and survive a new store", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kelivo-ai-name-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "private", "ai-name.json");
  const store = new AiNameStore({ file, defaultName: "TA" });

  assert.equal(store.get(), "TA");
  assert.deepEqual(store.set(" 小克 "), { ok: true, name: "小克" });
  assert.equal(store.get(), "小克");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).name, "小克");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(new AiNameStore({ file, defaultName: "TA" }).get(), "小克");

  const invalid = store.set("又".repeat(33));
  assert.equal(invalid.ok, false);
  assert.equal(invalid.status, 400);
  assert.equal(store.get(), "小克");
});
