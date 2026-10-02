// voice.js — [语音] 标记解析 + MiniMax TTS(Telegram 语音条用)
//
// 回复文本里 [语音]…[/语音] 包住的段落转成 MP3 语音，其余照常发文字，
// 顺序保持混排。MiniMax 的停顿与声音标签原样送入 TTS；失败时调用方降级为
// 干净文字，不把 <#0.4#>、(breath) 之类控制符展示给用户。

import { markdownCodeContains, markdownCodeRanges } from "./markdown-code.js";

// 宽松匹配：方括号接受半角 [] 与全角 【】 混用，斜杠接受半角/全角。
// 未闭合的开标记匹配不上 → 原样当普通文本，不吞字。
const VOICE_RE = /[\[【]\s*语音\s*[\]】]([\s\S]*?)[\[【]\s*[/／]\s*语音\s*[\]】]/g;

// MiniMax speech-2.8 的显式停顿和常用声音标签。只在 TTS 失败、降级为文字时
// 清掉；真正合成时必须原样保留，模型才会做出换气、轻笑和自然断句。
const PAUSE_RE = /<#\s*\d+(?:\.\d+)?\s*#>/gi;
const SOUND_TAG_RE = /\((?:laughs|chuckle|coughs|clear-throat|groans|breath|pant|inhale|exhale|gasps|sniffs|sighs|snorts|burps|lip-smacking|humming|hissing|emm|sneezes)\)/gi;

// 把一轮回复切成 [{ type: "text"|"voice", content }] 有序段落。
// 空白的语音段丢弃；中英文都可以直接合成。
export function splitVoiceSegments(text) {
  const segs = [];
  let last = 0;
  const codeRanges = markdownCodeRanges(text);
  VOICE_RE.lastIndex = 0;
  for (let m; (m = VOICE_RE.exec(text)); ) {
    if (markdownCodeContains(codeRanges, m.index)) continue;
    if (m.index > last) segs.push({ type: "text", content: text.slice(last, m.index) });
    const inner = m[1].trim();
    if (inner) segs.push({ type: "voice", content: inner });
    last = m.index + m[0].length;
  }
  if (last < text.length) segs.push({ type: "text", content: text.slice(last) });
  return segs;
}

export function voiceFallbackText(text) {
  return String(text || "")
    .replace(PAUSE_RE, " ")
    .replace(SOUND_TAG_RE, " ")
    .replace(/[ \t]+([，。！？；：,.!?;:])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

const responseError = (status, body) => {
  const detail = typeof body === "string" ? body : JSON.stringify(body);
  return new Error(`minimax ${status}: ${detail.slice(0, 240)}`);
};

// MiniMax TTS → MP3 Buffer。Telegram Bot API 的 sendVoice 可直接接收 MP3，
// 因此不依赖 ffmpeg，也不会因容器里缺少转码器而失败。
export async function minimaxTtsMp3({
  text,
  apiKey,
  voiceId,
  modelId = "speech-2.8-hd",
  voiceSettings = {},
  apiHost = "https://api.minimax.io",
  fetchImpl = fetch,
}) {
  if (!apiKey) throw new Error("MINIMAX_API_KEY is missing");
  if (!voiceId) throw new Error("MINIMAX_VOICE_ID is missing");

  const voiceSetting = {
    voice_id: voiceId,
    speed: voiceSettings.speed ?? 1,
    vol: voiceSettings.vol ?? 1,
    pitch: voiceSettings.pitch ?? 0,
  };
  const r = await fetchImpl(`${apiHost.replace(/\/$/, "")}/v1/t2a_v2`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: modelId,
      text,
      stream: false,
      language_boost: "auto",
      output_format: "hex",
      voice_setting: voiceSetting,
      audio_setting: {
        sample_rate: 32000,
        bitrate: 128000,
        format: "mp3",
        channel: 1,
      },
    }),
    signal: AbortSignal.timeout(60000),
  });

  const raw = await r.text();
  let body;
  try { body = JSON.parse(raw); }
  catch { throw responseError(r.status, raw); }
  if (!r.ok) throw responseError(r.status, body);
  if (body?.base_resp?.status_code && body.base_resp.status_code !== 0) {
    throw responseError(r.status, body.base_resp);
  }

  const hex = body?.data?.audio;
  if (typeof hex !== "string" || !hex.length || hex.length % 2 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error("minimax returned no valid audio");
  }
  return Buffer.from(hex, "hex");
}

export async function ttsVoiceAudio(options) {
  return {
    data: await minimaxTtsMp3(options),
    mimeType: "audio/mpeg",
    filename: "voice.mp3",
  };
}
