export function channelContextFor(source) {
  if (source === "telegram") {
    return "【系统·当前入口】Telegram。本轮回复只会送回 Telegram；可按需使用 [语音]…[/语音] 与已登记的 [贴纸:名字]。语音支持中英文；需要自然气口时可在语音段内少量使用 <#0.3#>、(breath)、(chuckle)，不要每句都加。";
  }
  if (source === "kelivo") {
    return "【系统·当前入口】Kelivo。本轮回复只会送回 Kelivo；不要使用 Telegram 专属的语音或贴纸标记。";
  }
  return "";
}

export function withChannelContext(text, source) {
  const context = channelContextFor(source);
  const body = String(text || "");
  return context ? `${context}\n${body}` : body;
}

export function channelTurnGuard(source, {
  needsKelivoHistory = false,
  awaitingFreshKelivo = false,
} = {}) {
  if (source !== "telegram") return "";
  if (awaitingFreshKelivo) {
    return "⚠️〔新会话在等 Kelivo〕请先回到 Kelivo 发送新会话的第一句话；完成后 Telegram 会继续共用这个会话。";
  }
  if (needsKelivoHistory) {
    return "⚠️〔需要 Kelivo 恢复〕原生会话暂时无法续接。请回到原 Kelivo 对话发送下一句话，让它携带完整历史完成恢复；Telegram 不会擅自开启失忆的新会话。";
  }
  return "";
}
