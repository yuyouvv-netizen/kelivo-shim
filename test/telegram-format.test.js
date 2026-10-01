import test from "node:test";
import assert from "node:assert/strict";

import {
  isTelegramHtmlParseError,
  telegramParagraphBubbles,
  telegramTextToHtml,
  telegramTextToPlain,
  telegramTransportChunks,
} from "../telegram-format.js";

test("Telegram HTML renders common bold markers without trusting model HTML", () => {
  assert.equal(
    telegramTextToHtml("**同一个大脑** <不是标签> & 安全"),
    "<b>同一个大脑</b> &lt;不是标签&gt; &amp; 安全",
  );
  assert.equal(telegramTextToPlain("**同一个大脑** <保留原文>"), "同一个大脑 <保留原文>");
  assert.equal(isTelegramHtmlParseError({
    ok: false, error_code: 400, description: "Bad Request: can't parse entities",
  }), true);
  assert.equal(isTelegramHtmlParseError({
    ok: false, error_code: 429, description: "Too Many Requests",
  }), false);
});

test("Telegram paragraph bubbles keep ordinary line breaks and pack short thoughts", () => {
  assert.deepEqual(
    telegramParagraphBubbles("第一行\n仍是同一段\n\n第二个完整段落"),
    ["第一行\n仍是同一段\n\n第二个完整段落"],
  );
});

test("Telegram paragraph bubbles do not emit standalone punctuation and respect the cap", () => {
  const first = "第一段没有结束所以这里仍然不能切开".repeat(8);
  const source = `${first}\n\n...\n\n直到这里才结束。\n\n——\n\n第二段已经完整结束。\n\n第三段也完整结束。`;
  const bubbles = telegramParagraphBubbles(source, 2, 120);
  assert.equal(bubbles.length, 2);
  assert.equal(bubbles[0], `${first}\n\n...\n\n直到这里才结束。`);
  assert.equal(bubbles[1], "第二段已经完整结束。\n\n第三段也完整结束。");
});

test("Telegram hides standalone em-dash dividers but preserves meaningful dashes", () => {
  assert.deepEqual(
    telegramParagraphBubbles("第一段。\n——\n---\n第二段不是——真的不是——第三段。"),
    ["第一段。\n第二段不是——真的不是——第三段。"],
  );
  assert.deepEqual(
    telegramParagraphBubbles("```\n——\n```"),
    ["```\n——\n```"],
  );
});

test("Telegram paragraph bubbles split dense prose only at sentence endings", () => {
  const sentence = "这一句话会把一个意思完整地讲清楚而且不会在半路被截断。";
  const source = sentence.repeat(8);
  const bubbles = telegramParagraphBubbles(source, 12, 120);
  assert.ok(bubbles.length > 1);
  assert.ok(bubbles.every((bubble) => bubble.endsWith("。")));
  assert.equal(bubbles.join(""), source);
});

test("Telegram paragraph bubbles never split through a paired bold span", () => {
  const source = `**${"粗体里的完整句子不会被从标记中间切开。".repeat(12)}**`;
  assert.deepEqual(telegramParagraphBubbles(source, 12, 120), [source]);
});

test("Telegram transport prefers blank lines, preserves whitespace and protects bold", () => {
  const first = "甲".repeat(180);
  const second = "乙".repeat(180);
  const third = "**加粗内容完整保留。**";
  const source = `${first}\n\n${second}\n${third}`;
  const chunks = telegramTransportChunks(source, 256);
  assert.deepEqual(chunks, [`${first}\n\n`, `${second}\n${third}`]);
  assert.equal(chunks.join(""), source);
  assert.ok(chunks.every((chunk) => (chunk.match(/\*\*/g)?.length || 0) % 2 === 0));
});

test("Telegram transport falls back only at complete sentence endings", () => {
  const sentence = "这一句会完整结束而且不会从中间被切开。";
  const source = sentence.repeat(20);
  const chunks = telegramTransportChunks(source, 256);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.endsWith("。")));
  assert.equal(chunks.join(""), source);
});

test("Telegram transport rejects an impossible unbroken mega-line", () => {
  assert.throws(
    () => telegramTransportChunks("没".repeat(500), 256),
    { code: "TELEGRAM_UNBREAKABLE_TEXT" },
  );
});

test("Telegram paragraph bubbles balance excess parts instead of creating a giant tail", () => {
  const paragraph = "这一小段包含一个完整意思并且应该作为可以安全合并的单位。".repeat(3);
  const bubbles = telegramParagraphBubbles(Array(8).fill(paragraph).join("\n\n"), 2, 120);
  assert.equal(bubbles.length, 2);
  assert.match(bubbles[0], /。$/);
  assert.match(bubbles[1], /。$/);
  assert.ok(Math.abs(bubbles[0].length - bubbles[1].length) < paragraph.length * 2);
});

test("Telegram paragraph bubbles rebalance a tiny final orphan by whole parts", () => {
  const first = `${"甲".repeat(119)}。`;
  const second = `${"乙".repeat(109)}。`;
  const third = `${"丙".repeat(29)}。`;
  assert.deepEqual(
    telegramParagraphBubbles(`${first}\n\n${second}\n\n${third}`, 12, 260),
    [first, `${second}\n\n${third}`],
  );
});
