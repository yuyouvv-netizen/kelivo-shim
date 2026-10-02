// node --test 跑；MiniMax 请求用注入的 fetch mock，不碰真实网络。
import { test } from "node:test";
import assert from "node:assert/strict";
import { minimaxTtsMp3, splitVoiceSegments, voiceFallbackText } from "../voice.js";

test("纯文字:整段原样、单段", () => {
  const segs = splitVoiceSegments("今天怎么样?\n早点睡。");
  assert.deepEqual(segs, [{ type: "text", content: "今天怎么样?\n早点睡。" }]);
});

test("单语音段:只出一个 voice 段,内容去掉首尾空白", () => {
  const segs = splitVoiceSegments("[语音] Good night — I'm right here. [/语音]");
  assert.deepEqual(segs, [{ type: "voice", content: "Good night — I'm right here." }]);
});

test("中文和 MiniMax 控制标签都保留在 voice 段", () => {
  const content = "又又，先别急。<#0.35#>(breath)慢慢说，我在听。";
  assert.deepEqual(splitVoiceSegments(`[语音]${content}[/语音]`), [
    { type: "voice", content },
  ]);
});

test("TTS 失败时清理控制标签再降级成文字", () => {
  assert.equal(
    voiceFallbackText("又又，<#0.35#>(breath)慢慢说。\n(chuckle)Come here."),
    "又又， 慢慢说。\nCome here.",
  );
});

test("文字+语音混排:按出现顺序", () => {
  const segs = splitVoiceSegments("先睡吧。\n[语音]Go to sleep.[/语音]\n明天见。");
  assert.deepEqual(segs, [
    { type: "text", content: "先睡吧。\n" },
    { type: "voice", content: "Go to sleep." },
    { type: "text", content: "\n明天见。" },
  ]);
});

test("多个语音段:各自独立、顺序保持", () => {
  const segs = splitVoiceSegments("[语音]One.[/语音]中间插一句[语音]Two.[/语音]");
  assert.deepEqual(segs, [
    { type: "voice", content: "One." },
    { type: "text", content: "中间插一句" },
    { type: "voice", content: "Two." },
  ]);
});

test("未闭合标记:视为普通文本,不吞字", () => {
  const raw = "喏[语音]this never closes";
  assert.deepEqual(splitVoiceSegments(raw), [{ type: "text", content: raw }]);
});

test("全角/半角括号与斜杠混用:宽松匹配", () => {
  const segs = splitVoiceSegments("【语音】Hey.[/语音]好了【语音】Bye.【／语音】");
  assert.deepEqual(segs, [
    { type: "voice", content: "Hey." },
    { type: "text", content: "好了" },
    { type: "voice", content: "Bye." },
  ]);
});

test("空语音段:丢弃,不发空语音", () => {
  const segs = splitVoiceSegments("前[语音]  [/语音]后");
  assert.deepEqual(segs, [
    { type: "text", content: "前" },
    { type: "text", content: "后" },
  ]);
});

test("语音内容里的换行保留(交给 TTS 当停顿素材)", () => {
  const segs = splitVoiceSegments("[语音]Line one.\nLine two.[/语音]");
  assert.deepEqual(segs, [{ type: "voice", content: "Line one.\nLine two." }]);
});

test("代码里的语音标记只是示例,不会抽出孤立语音段", () => {
  const raw = "示例：`[语音]...[/语音]`\n真的：[语音]I am here.[/语音]";
  assert.deepEqual(splitVoiceSegments(raw), [
    { type: "text", content: "示例：`[语音]...[/语音]`\n真的：" },
    { type: "voice", content: "I am here." },
  ]);
  const fenced = "```\n[语音]...[/语音]\n```";
  assert.deepEqual(splitVoiceSegments(fenced), [{ type: "text", content: fenced }]);
});

test("MiniMax 请求包含可热调音色参数与双语文本", async () => {
  let request;
  const audio = await minimaxTtsMp3({
    text: "别急。<#0.3#>(breath) I'm here.",
    apiKey: "test-key",
    voiceId: "yuke-v1",
    modelId: "speech-2.8-hd",
    voiceSettings: { speed: 0.95, vol: 1.1, pitch: 0 },
    apiHost: "https://example.test/",
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({
        data: { audio: Buffer.from("fake-mp3").toString("hex") },
        base_resp: { status_code: 0 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.equal(request.url, "https://example.test/v1/t2a_v2");
  assert.equal(request.options.headers.Authorization, "Bearer test-key");
  assert.equal(request.body.text, "别急。<#0.3#>(breath) I'm here.");
  assert.deepEqual(request.body.voice_setting, {
    voice_id: "yuke-v1", speed: 0.95, vol: 1.1, pitch: 0,
  });
  assert.deepEqual(request.body.audio_setting, {
    sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1,
  });
  assert.equal(audio.toString(), "fake-mp3");
});

test("MiniMax 业务错误不会被误当成音频", async () => {
  await assert.rejects(
    minimaxTtsMp3({
      text: "test", apiKey: "key", voiceId: "voice",
      fetchImpl: async () => new Response(JSON.stringify({
        base_resp: { status_code: 1002, status_msg: "invalid api key" },
      }), { status: 200 }),
    }),
    /invalid api key/,
  );
});
