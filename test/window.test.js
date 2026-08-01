import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_AUTO_COMPACT_WINDOW,
  compactThreshold,
  prefixFromMessageStart,
  prefixOf,
  windowPct,
} from "../window.js";

const messageStart = (usage) => ({ type: "message_start", message: { usage } });

test("1M auto-compact 窗口对应 967k 真实压缩线", () => {
  assert.equal(compactThreshold(DEFAULT_AUTO_COMPACT_WINDOW), 967000);
});

test("message_start 给出单次请求的真实前缀", () => {
  assert.equal(prefixFromMessageStart(messageStart({
    input_tokens: 5,
    cache_read_input_tokens: 53725,
    cache_creation_input_tokens: 217,
  })), 53947);
});

test("多次工具调用取最大单次前缀,不取 result 累加值", () => {
  const calls = [53725, 53725, 53947].map((n) => messageStart({ cache_read_input_tokens: n }));
  assert.equal(Math.max(...calls.map(prefixFromMessageStart)), 53947);
  assert.equal(windowPct(53947, 967000), 6);
  assert.ok(windowPct(161206, 967000) < 85, "旧版累加虚报在 1M 窗口下也不应触发归档");
});

test("缺字段和非 message_start 安全返回 0", () => {
  assert.equal(prefixOf({ cache_read_input_tokens: 500 }), 500);
  assert.equal(prefixOf(null), 0);
  assert.equal(prefixFromMessageStart({ type: "message_delta" }), 0);
  assert.equal(windowPct(1000, 0), 0);
});
