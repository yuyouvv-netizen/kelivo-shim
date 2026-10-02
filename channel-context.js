export function channelContextFor(source) {
  if (source === "telegram") {
    return "【系统·当前入口】Telegram。本轮回复只会送回 Telegram；可按需使用 [语音]…[/语音]、已登记的 [贴纸:名字]，以及 [碎碎念]…[/碎碎念]（显示为可展开的小卡；可写成 [碎碎念:标题]…[/碎碎念]）。碎碎念是自愿的表达方式，不要为了展示功能机械使用。";
  }
  if (source === "kelivo") {
    return "【系统·当前入口】Kelivo。本轮回复只会送回 Kelivo；不要使用 Telegram 专属的语音、贴纸或碎碎念标记。";
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
