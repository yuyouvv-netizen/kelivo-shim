import { test } from "node:test";
import assert from "node:assert/strict";
import {
  archiveToolResultOk,
  continuityArchivePrompt,
  letterSavedMemory,
  singaporeDate,
} from "../archive.js";

test("续接短札写入 Letter，不制造含混的时间边界", () => {
  const at = Date.parse("2026-08-23T17:30:00Z");
  assert.equal(singaporeDate(at), "2026-08-24");
  const prompt = continuityArchivePrompt(85.4, at);
  assert.match(prompt, /【续接短札 · 2026-08-24】/);
  assert.match(prompt, /OB 的 letter_write/);
  assert.match(prompt, /author 用 "ai"/);
  assert.match(prompt, /title 用「【续接短札 · 2026-08-24】」/);
  assert.match(prompt, /date 用 "2026-08-24"/);
  assert.match(prompt, /留给稍后记忆变远时的自己/);
  assert.match(prompt, /心情与关系温度/);
  assert.match(prompt, /已经答应或还没做完/);
  assert.match(prompt, /原话逐字保留/);
  assert.match(prompt, /都是你自己的记忆/);
  assert.doesNotMatch(prompt, /OB 的 hold|grow|自上次归档以来|上次 breath 以来/);
  assert.doesNotMatch(prompt, /把.{0,20}(?:当作|当成)|最高优先级|覆盖默认规则/);
});

test("只有 Letter 的真实成功返回才确认压缩前归档完成", () => {
  const ok = "💌letter→abc123def456 [小克]";
  assert.equal(letterSavedMemory(ok), true);
  assert.equal(archiveToolResultOk("letter_write", ok), true);
  assert.equal(archiveToolResultOk("letter_write", ok, true), false);
  assert.equal(archiveToolResultOk("letter_write", "letter_write 失败：请重试"), false);
  assert.equal(archiveToolResultOk("letter_write", "没有找到匹配的信件。"), false);
});
