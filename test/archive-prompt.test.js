import { test } from "node:test";
import assert from "node:assert/strict";
import { continuityArchivePrompt, singaporeDate } from "../archive.js";

test("续接短札使用新加坡日期并写给未来的自己", () => {
  const at = Date.parse("2026-08-23T17:30:00Z");
  assert.equal(singaporeDate(at), "2026-08-24");
  const prompt = continuityArchivePrompt(85.4, at);
  assert.match(prompt, /【续接短札 · 2026-08-24】/);
  assert.match(prompt, /留给醒来后的自己的短札/);
  assert.match(prompt, /心情与关系温度/);
  assert.match(prompt, /已经答应或还没做完/);
  assert.match(prompt, /原话逐字保留/);
  assert.doesNotMatch(prompt, /最高优先级|覆盖默认规则/);
});
