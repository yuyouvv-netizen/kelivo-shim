import test from "node:test";
import assert from "node:assert/strict";

import { telegramParagraphBubbles, telegramTextToHtml } from "../telegram-format.js";

test("Telegram HTML renders common bold markers without trusting model HTML", () => {
  assert.equal(
    telegramTextToHtml("**同一个大脑** <不是标签> & 安全"),
    "<b>同一个大脑</b> &lt;不是标签&gt; &amp; 安全",
  );
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
    telegramParagraphBubbles("第一段。\n——\n第二段不是——真的不是——第三段。"),
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

test("Telegram paragraph bubbles balance excess parts instead of creating a giant tail", () => {
  const paragraph = "这一小段包含一个完整意思并且应该作为可以安全合并的单位。".repeat(3);
  const bubbles = telegramParagraphBubbles(Array(8).fill(paragraph).join("\n\n"), 2, 120);
  assert.equal(bubbles.length, 2);
  assert.match(bubbles[0], /。$/);
  assert.match(bubbles[1], /。$/);
  assert.ok(Math.abs(bubbles[0].length - bubbles[1].length) < paragraph.length * 2);
});
