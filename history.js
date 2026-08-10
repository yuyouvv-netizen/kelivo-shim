// Kelivo 会在 /v1/messages 请求里带上当前聊天的历史。常驻 Claude 进程活着时
// 不需要重复喂;只有进程刚启动/意外重启后才把这份历史作为一次恢复材料送进去。

export function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

export function recoveryTranscript(messages, options = {}) {
  // When Kelivo already supplied a bounded chat history, keep every message it
  // gave us by default. A deployment may still set an explicit cap, and the
  // character budget remains the final guard against overflowing Claude's real
  // context window.
  const requestedMax = options.maxMessages;
  const maxMessages = requestedMax === undefined || requestedMax === null || requestedMax === ""
    ? Number.POSITIVE_INFINITY
    : Math.max(0, Number(requestedMax));
  const maxChars = Math.max(0, Number(options.maxChars ?? 240000));
  const list = Array.isArray(messages) ? messages : [];
  let currentIndex = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.role === "user") { currentIndex = i; break; }
  }
  if (currentIndex <= 0 || maxMessages === 0 || maxChars === 0) {
    return { text: "", messages: 0, chars: 0, truncated: false };
  }

  const eligible = list.slice(0, currentIndex)
    .filter((m) => m?.role === "user" || m?.role === "assistant")
    .map((m) => ({ role: m.role, text: contentToText(m.content).trim() }))
    .filter((m) => m.text);
  const candidates = Number.isFinite(maxMessages) ? eligible.slice(-maxMessages) : eligible;

  const picked = [];
  let remaining = maxChars;
  let truncated = candidates.length < eligible.length;
  for (let i = candidates.length - 1; i >= 0 && remaining > 0; i--) {
    const m = candidates[i];
    const label = m.role === "user" ? "【对方此前的消息】" : "【你此前的回复】";
    const overhead = label.length + 2;
    if (remaining <= overhead) { truncated = true; break; }
    let body = m.text;
    const room = remaining - overhead;
    if (body.length > room) {
      body = `…${body.slice(-(room - 1))}`;
      truncated = true;
    }
    const rendered = `${label}\n${body}`;
    picked.unshift(rendered);
    remaining -= rendered.length + 2;
  }
  if (picked.length < candidates.length) truncated = true;
  const text = picked.join("\n\n");
  return { text, messages: picked.length, chars: text.length, truncated };
}

export function withRecoveredHistory(currentText, recovery) {
  if (!recovery?.text) return currentText;
  const cut = recovery.truncated
    ? "（Kelivo 只提供了最近一段，较早内容以 OB 长期记忆为准。）\n"
    : "";
  return [
    "【系统·进程重启后的会话恢复】",
    "这是 shim 从同一个 Kelivo 对话里取回的真实历史，不是对方刚刚重新说了一遍。只用它恢复上下文，不要逐条复述或回答；直接接续最末尾的当前消息。",
    cut + recovery.text,
    "【当前新消息】",
    currentText,
  ].join("\n\n");
}
