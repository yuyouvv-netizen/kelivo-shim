import test from "node:test";
import assert from "node:assert/strict";

import { telegramToolLabel, telegramToolStatusText } from "../telegram-tools.js";

test("Telegram tool labels hide MCP plumbing behind short human names", () => {
  assert.equal(telegramToolLabel("mcp__ombre__letter_write"), "记忆 · 续接信");
  assert.equal(telegramToolLabel("mcp__gmail__search_emails"), "邮箱 · search emails");
  assert.equal(telegramToolLabel("WebSearch"), "网页搜索");
});

test("Telegram tool status stays compact, unique and honest about errors", () => {
  const names = ["WebSearch", "WebSearch", "mcp__status__look"];
  assert.equal(telegramToolStatusText(names), "⌛ 正在使用：网页搜索 · 状态 · 查看");
  assert.equal(
    telegramToolStatusText(names, { done: true, errors: 1 }),
    "⚠️ 已使用：网页搜索 · 状态 · 查看（1 项报错）",
  );
});
