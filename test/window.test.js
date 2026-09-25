import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_AUTO_COMPACT_WINDOW,
  compactThreshold,
  contextWindowForModel,
  hasExtendedContext,
  monitorLimitForModel,
  prefixFromMessageStart,
  prefixOf,
  windowPct,
} from "../window.js";

const messageStart = (usage) => ({ type: "message_start", message: { usage } });

test("标准 200K auto-compact 窗口对应约 167k 真实压缩线", () => {
  assert.equal(DEFAULT_AUTO_COMPACT_WINDOW, 200000);
  assert.equal(compactThreshold(DEFAULT_AUTO_COMPACT_WINDOW), 167000);
  assert.equal(windowPct(142000, 167000), 85);
});

test("普通 4.6 与未知型号仍夹住旧的 1M 配置", () => {
  assert.equal(contextWindowForModel("claude-opus-4-6", 1000000), 200000);
  assert.equal(contextWindowForModel("claude-unknown-model", 1000000), 200000);
  assert.equal(contextWindowForModel("claude-opus-4-6[1m]", 200000), 1000000);
  assert.equal(hasExtendedContext("claude-opus-4-6[1m]"), true);
  assert.equal(hasExtendedContext("claude-opus-4-6"), false);
});

test("原生 1M 型号的压缩线和 85%/90% 提醒随模型扩展", () => {
  for (const model of [
    "claude-opus-4-7", "claude-opus-4-8", "claude-opus-5",
    "claude-opus-5-5", "claude-fable-5",
  ]) {
    assert.equal(contextWindowForModel(model, 200000), 1000000, model);
    assert.equal(monitorLimitForModel(model, 200000), 967000, model);
    assert.equal(windowPct(822000, monitorLimitForModel(model, 200000)), 85, model);
    assert.equal(windowPct(870300, monitorLimitForModel(model, 200000)), 90, model);
  }
});

test("监测线不会被遗留的 967k WINDOW_LIMIT 撑过原生压缩线", () => {
  assert.equal(monitorLimitForModel("claude-opus-4-6", 1000000, 967000), 167000);
  assert.equal(monitorLimitForModel("claude-opus-4-6", 200000, 150000), 150000);
  assert.equal(monitorLimitForModel("claude-opus-5-5", 200000, 967000), 967000);
  assert.equal(monitorLimitForModel("claude-opus-5-5", 200000, 150000), 150000);
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
  assert.equal(windowPct(53947, 167000), 32);
  assert.ok(windowPct(161206, 167000) >= 85, "接近原生压缩线时必须已经触发归档");
});

test("缺字段和非 message_start 安全返回 0", () => {
  assert.equal(prefixOf({ cache_read_input_tokens: 500 }), 500);
  assert.equal(prefixOf(null), 0);
  assert.equal(prefixFromMessageStart({ type: "message_delta" }), 0);
  assert.equal(windowPct(1000, 0), 0);
});
