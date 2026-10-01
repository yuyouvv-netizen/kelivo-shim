import test from "node:test";
import assert from "node:assert/strict";

import { telegramParagraphBubbles, telegramTextToHtml } from "../telegram-format.js";

test("Telegram HTML renders common bold markers without trusting model HTML", () => {
  assert.equal(
    telegramTextToHtml("**同一个大脑** <不是标签> & 安全"),
    "<b>同一个大脑</b> &lt;不是标签&gt; &amp; 安全",
  );
});

test("Telegram paragraph bubbles keep ordinary line breaks together", () => {
  assert.deepEqual(
    telegramParagraphBubbles("第一行\n仍是同一段\n\n第二个完整段落"),
    ["第一行\n仍是同一段", "第二个完整段落"],
  );
});

test("Telegram paragraph bubbles do not emit standalone dividers and respect the cap", () => {
  assert.deepEqual(
    telegramParagraphBubbles("第一段\n\n——\n\n第二段\n\n第三段", 2),
    ["第一段\n\n——", "第二段\n\n第三段"],
  );
});
