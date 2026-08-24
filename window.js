// Claude Code 的窗口用量必须从每次 API 请求自己的 message_start 事件取。
// result.usage 是一整轮(含多次工具调用)的累加值,拿它会把窗口虚报数倍。

// 普通订阅路径的 Claude Code 会话是标准 200K。只有模型名显式带 [1m]
// 才按扩展上下文处理；这样旧部署里遗留的 1M 环境变量不会让 shim 误以为
// 还有八十多万 token，错过真实的归档与压缩线。
export const DEFAULT_AUTO_COMPACT_WINDOW = 200000;
export const EXTENDED_AUTO_COMPACT_WINDOW = 1000000;
export const COMPACT_OUTPUT_RESERVE = 20000;
export const COMPACT_BUFFER = 13000;

export function hasExtendedContext(model = "") {
  return /\[1m\]\s*$/i.test(String(model));
}

export function contextWindowForModel(model, configuredWindow = DEFAULT_AUTO_COMPACT_WINDOW) {
  const configured = Number(configuredWindow);
  const requested = configured > 0 ? configured : DEFAULT_AUTO_COMPACT_WINDOW;
  if (hasExtendedContext(model)) {
    return Math.max(requested, EXTENDED_AUTO_COMPACT_WINDOW);
  }
  return Math.min(requested, DEFAULT_AUTO_COMPACT_WINDOW);
}

export function compactThreshold(autoCompactWindow = DEFAULT_AUTO_COMPACT_WINDOW) {
  const n = Number(autoCompactWindow);
  if (!(n > COMPACT_OUTPUT_RESERVE + COMPACT_BUFFER)) return 0;
  return n - COMPACT_OUTPUT_RESERVE - COMPACT_BUFFER;
}

export function monitorLimitForModel(model, configuredWindow, configuredLimit) {
  const nativeLimit = compactThreshold(contextWindowForModel(model, configuredWindow));
  const requested = Number(configuredLimit);
  if (!(requested > 0)) return nativeLimit;
  return Math.min(requested, nativeLimit);
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
