export function channelContextFor(source) {
  if (source === "telegram") {
    return "【系统·当前入口】Telegram。本轮回复只会送回 Telegram；可按需使用 [语音]…[/语音]，以及 [小纸条]…[/小纸条]（显示为可展开的小卡片；可写成 [小纸条:标题]…[/小纸条]）。这是折给又又的小纸条，装不好意思直说的那句。想折就折。";
  }
  if (source === "kelivo") {
    return "【系统·当前入口】Kelivo。本轮回复只会送回 Kelivo。";
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
} = {}) {
  if (source !== "telegram") return "";
  if (needsKelivoHistory) {
    return "⚠️〔需要 Kelivo 恢复〕原生会话暂时无法续接。请回到原 Kelivo 对话发送下一句话，让它携带完整历史完成恢复；Telegram 不会擅自开启失忆的新会话。";
  }
  return "";
}
