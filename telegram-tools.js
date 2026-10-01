const PROVIDER_LABELS = Object.freeze({
  ombre: "记忆",
  gmail: "邮箱",
  garden: "花园",
  browser: "浏览器",
  status: "状态",
  toy: "啵啵鸟",
  x: "X",
});

const ACTION_LABELS = Object.freeze({
  breath: "回忆",
  hold: "记住",
  grow: "整理",
  letter_write: "续接信",
  look: "查看",
  WebSearch: "网页搜索",
  WebFetch: "读取网页",
});

export function telegramToolLabel(raw) {
  const name = String(raw || "unknown-tool").trim();
  if (ACTION_LABELS[name]) return ACTION_LABELS[name];
  const match = /^mcp__([^_]+)__(.+)$/.exec(name);
  if (!match) return name.replace(/^mcp__/, "").replace(/_/g, " ").slice(0, 32);
  const provider = PROVIDER_LABELS[match[1]] || match[1];
  const action = ACTION_LABELS[match[2]] || match[2].replace(/_/g, " ");
  return `${provider} · ${action}`.slice(0, 40);
}

export function telegramToolStatusText(names, { done = false, errors = 0 } = {}) {
  const unique = [...new Set((names || []).map(telegramToolLabel).filter(Boolean))];
  const shown = unique.slice(0, 6);
  const more = unique.length > shown.length ? ` 等 ${unique.length} 项` : "";
  const tools = `${shown.join(" · ")}${more}` || "工具";
  if (done && errors > 0) return `⚠️ 已使用：${tools}（${errors} 项报错）`;
  return done ? `✓ 已使用：${tools}` : `⌛ 正在使用：${tools}`;
}
