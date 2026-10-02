import test from "node:test";
import assert from "node:assert/strict";

import {
  channelContextFor,
  channelTurnGuard,
  withChannelContext,
} from "../channel-context.js";

test("Telegram turns advertise only Telegram-native presentation", () => {
  const result = withChannelContext("你好", "telegram");
  assert.match(result, /当前入口】Telegram/);
  assert.match(result, /\[语音\]/);
  assert.match(result, /\[贴纸:名字\]/);
  assert.equal(result.endsWith("\n你好"), true);
});

test("Kelivo turns explicitly suppress Telegram-only markers", () => {
  const result = withChannelContext("你好", "kelivo");
  assert.match(result, /当前入口】Kelivo/);
  assert.match(result, /不要使用 Telegram 专属/);
});

test("internal turns are not mislabeled as either chat frontend", () => {
  assert.equal(channelContextFor("wake"), "");
  assert.equal(withChannelContext("系统轮次", "archive"), "系统轮次");
});

test("Telegram cannot create a memoryless fallback session", () => {
  assert.match(channelTurnGuard("telegram", { needsKelivoHistory: true }), /需要 Kelivo 恢复/);
  assert.equal(channelTurnGuard("kelivo", { needsKelivoHistory: true }), "");
  assert.equal(channelTurnGuard("telegram"), "");
});

test("an explicitly released fresh session may start from Telegram", () => {
  assert.equal(channelTurnGuard("telegram", { awaitingFreshKelivo: true }), "");
});
