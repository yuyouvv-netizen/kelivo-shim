const CONTENT_BLOCK = /<content>\s*([\s\S]*?)\s*<\/content>/i;

// Kelivo 会把自动标题生成也发给当前聊天供应商。对 resident claude shim
// 来说这不是一轮真实对话，必须在进入常驻进程前截断，否则整段历史会被
// 当作用户消息重复写进上下文。
export function isKelivoTitleRequest(text) {
  const value = typeof text === "string" ? text : "";
  if (!CONTENT_BLOCK.test(value)) return false;

  const english = /summari[sz]e[\s\S]{0,160}conversation[\s\S]{0,160}(?:short|chinese)[\s-]*title/i.test(value);
  const chinese = /(?:总结|概括)[\s\S]{0,100}(?:对话|会话)[\s\S]{0,100}标题/.test(value);
  const directReply = /reply directly with the title/i.test(value) || /只(?:回复|输出).*标题/.test(value);
  const shortLimit = /title[\s\S]{0,100}(?:not exceed|within)\s*\d+\s*(?:chinese\s*)?characters/i.test(value) ||
    /标题[\s\S]{0,60}(?:不超过|以内)\s*\d+\s*个?字/.test(value);

  return (english || chinese) && (directReply || shortLimit);
}

function contentOf(text) {
  if (typeof text !== "string") return "";
  // 默认提示词的第一行会把 `<content>` 当作名词提到一次；真正的正文块在
  // 提示词末尾，所以从最后一对标签取值。
  const lower = text.toLowerCase();
  const start = lower.lastIndexOf("<content>");
  const end = lower.lastIndexOf("</content>");
  if (start < 0 || end <= start) return "";
  return text.slice(start + "<content>".length, end).trim();
}

function cleanCandidate(text) {
  return String(text || "")
    .replace(/【时间[^】]*】/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[`*_>#~|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function userMessages(content) {
  const out = [];
  const pattern = /(?:^|\n{2,})User:\s*([\s\S]*?)(?=\n{2,}(?:User|Assistant):\s*|$)/gi;
  for (const match of content.matchAll(pattern)) {
    const value = cleanCandidate(match[1]);
    if (value) out.push(value);
  }
  return out;
}

function titleChars(text) {
  return Array.from(cleanCandidate(text)).filter((char) => /[\p{L}\p{N}]/u.test(char));
}

export function localTitleForRequest(text, maxChars = 10) {
  const content = contentOf(text);
  const candidates = userMessages(content);
  // 自动标题通常只在首轮生成；若客户端重试到长对话阶段，取信息量最大的
  // 用户消息比拿称呼或简短应答更有意义。
  const source = candidates.sort((a, b) => titleChars(b).length - titleChars(a).length)[0] || content;
  const chars = titleChars(source).slice(0, Math.max(1, maxChars));
  return chars.join("") || "新对话";
}
