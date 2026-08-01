// Claude Code 的窗口用量必须从每次 API 请求自己的 message_start 事件取。
// result.usage 是一整轮(含多次工具调用)的累加值,拿它会把窗口虚报数倍。

// 当前默认模型都是 1M 上下文。本 shim 明确把 Claude Code 的 auto-compact 窗口
// 固定为 1M,避免不同版本的 "auto" 策略悄悄变化后,归档阈值和真实压缩线错位。
export const DEFAULT_AUTO_COMPACT_WINDOW = 1000000;
export const COMPACT_OUTPUT_RESERVE = 20000;
export const COMPACT_BUFFER = 13000;

export function compactThreshold(autoCompactWindow = DEFAULT_AUTO_COMPACT_WINDOW) {
  const n = Number(autoCompactWindow);
  if (!(n > COMPACT_OUTPUT_RESERVE + COMPACT_BUFFER)) return 0;
  return n - COMPACT_OUTPUT_RESERVE - COMPACT_BUFFER;
}

export const prefixOf = (usage) =>
  (usage?.input_tokens || 0) +
  (usage?.cache_read_input_tokens || 0) +
  (usage?.cache_creation_input_tokens || 0);

export function prefixFromMessageStart(event) {
  if (!event || event.type !== "message_start") return 0;
  return prefixOf(event.message?.usage);
}

export const windowPct = (tokens, limit) =>
  limit > 0 ? Math.round((tokens / limit) * 100) : 0;
