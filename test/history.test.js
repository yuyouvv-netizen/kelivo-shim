import { test } from "node:test";
import assert from "node:assert/strict";
import { contentToText, recoveryTranscript, withRecoveredHistory } from "../history.js";

test("只提取文本块", () => {
  assert.equal(contentToText([
    { type: "text", text: "前" },
    { type: "image", source: {} },
    { type: "text", text: "后" },
  ]), "前后");
});

test("恢复历史排除当前最后一条用户消息", () => {
  const history = recoveryTranscript([
    { role: "user", content: "第一句" },
    { role: "assistant", content: [{ type: "text", text: "第一答" }] },
    { role: "user", content: "现在这句" },
  ]);
  assert.equal(history.messages, 2);
  assert.match(history.text, /第一句/);
  assert.match(history.text, /第一答/);
  assert.doesNotMatch(history.text, /现在这句/);
});

test("没有旧历史时不包装当前消息", () => {
  const history = recoveryTranscript([{ role: "user", content: "第一句" }]);
  assert.equal(history.text, "");
  assert.equal(withRecoveredHistory("第一句", history), "第一句");
});

test("按最近消息数截断并明确标记", () => {
  const history = recoveryTranscript([
    { role: "user", content: "很早" },
    { role: "assistant", content: "中间" },
    { role: "user", content: "较近" },
    { role: "assistant", content: "最近回复" },
    { role: "user", content: "当前" },
  ], { maxMessages: 2, maxChars: 1000 });
  assert.equal(history.messages, 2);
  assert.equal(history.truncated, true);
  assert.doesNotMatch(history.text, /很早|中间/);
  assert.match(withRecoveredHistory("当前", history), /较早内容以 OB 长期记忆为准/);
});

test("字符上限保留靠近当前消息的尾部", () => {
  const history = recoveryTranscript([
    { role: "user", content: "A".repeat(200) + "结尾" },
    { role: "user", content: "当前" },
  ], { maxChars: 40 });
  assert.ok(history.chars <= 40);
  assert.match(history.text, /结尾/);
  assert.equal(history.truncated, true);
});

test("默认接收 Kelivo 实际提供的全部历史而不是只取最近 128 条", () => {
  const prior = Array.from({ length: 150 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: `历史-${index}`,
  }));
  const history = recoveryTranscript([...prior, { role: "user", content: "当前" }]);
  assert.equal(history.messages, 150);
  assert.equal(history.truncated, false);
  assert.match(history.text, /历史-0/);
  assert.match(history.text, /历史-149/);
});
