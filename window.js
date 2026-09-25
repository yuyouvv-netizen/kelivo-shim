// Claude Code 的窗口用量必须从每次 API 请求自己的 message_start 事件取。
// result.usage 是一整轮(含多次工具调用)的累加值,拿它会把窗口虚报数倍。

// Opus 4.7 及之后已确认的型号和 Fable 5 在 Anthropic 直连路径原生使用 1M。
// Opus 4.6 普通版仍是 200K，只有显式 [1m] 才启用扩展窗口。
// 未知型号保守按 200K，避免旧部署遗留的 1M 环境变量错过归档线。
export const DEFAULT_AUTO_COMPACT_WINDOW = 200000;
export const EXTENDED_AUTO_COMPACT_WINDOW = 1000000;
export const COMPACT_OUTPUT_RESERVE = 20000;
export const COMPACT_BUFFER = 13000;

const NATIVE_EXTENDED_MODELS = new Set([
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-opus-5-5",
  "claude-fable-5",
]);

export function hasExtendedContext(model = "") {
  const name = String(model).trim().toLowerCase();
  return NATIVE_EXTENDED_MODELS.has(name) || /\[1m\]$/.test(name);
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
