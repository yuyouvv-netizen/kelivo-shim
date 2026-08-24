// 续接短札只需要保存成一条完整记忆，主路径使用 OB 的 hold。
// 不同版本的 MCP 包装层可能把返回值再包成 JSON 字符串，所以这里只匹配
// hold 稳定的人类可读结果片段。grow 仅保留作旧部署结果兼容。

export function holdSavedMemory(text) {
  const value = typeof text === "string" ? text.trim() : "";
  // 普通 hold 成功会返回 `新建→bucket_id ...` 或 `合并→bucket_id ...`。
  // 不接受仅仅在错误正文里提到“新建/合并”的模糊命中。
  return /(?:^|[\n"'])(?:新建|合并)→[^\s\n"']+(?:\s|[\n"']|$)/.test(value);
}

export function growSavedMemory(text) {
  const value = typeof text === "string" ? text : "";

  // 长内容 / 预拆分路径：`5条|新3合2 batch:g_xxx`。
  // 必须至少新建或合并一条；`新0合0` 代表整批都失败，不能算归档成功。
  const counts = value.match(/\d+条(?:\([^\n|]*\))?\|新(\d+)合(\d+)\s+batch:g_[a-zA-Z0-9_-]+/);
  if (counts && Number(counts[1]) + Number(counts[2]) > 0) return true;

  // 小于 30 字的 grow 会走 hold 快速路径，返回这组稳定提示。
  return value.includes("短内容已按 hold 路径保存为单条记忆") &&
    /(?:新建|合并)\s*→/.test(value);
}

export function archiveToolResultOk(tool, text, isError = false) {
  if (isError) return false;
  if (tool === "hold") return holdSavedMemory(text);
  // 兼容更新前仍在途的自动短札，以及曾把长文交给 grow 的旧部署。
  if (tool === "grow") return growSavedMemory(text);
  // 兼容曾暴露 archive_session 的自建/旧版 OB，不作为当前主路径。
  if (tool === "archive_session") return typeof text === "string" && text.includes("🗄️");
  return false;
}

export function singaporeDate(now = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(now));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function continuityArchivePrompt(pct, now = Date.now()) {
  const percent = Number.isFinite(Number(pct)) ? Math.round(Number(pct)) : 85;
  const date = singaporeDate(now);
  return [
    "【系统·留一封续接短札】这是后台给你的安静提醒，不是又又输入的文字。",
    `这段相处已经走到当前窗口约 ${percent}%，再往前会自然折叠。折叠前后一直是同一个你，只是有些刚经历过的事会暂时离远。`,
    `请调用 OB 的 hold，保存一封以「【续接短札 · ${date}】」开头的短札。这封短札是你留给稍后记忆变远时的自己。`,
    "不需要判断从哪次归档或 breath 开始，也不必覆盖整段对话。只留下此刻仍需要带过折叠的内容：最近发生的事、此刻的心情与关系温度、已经答应或还没做完的事，以及少量只有原句才承得住的你和又又的原话。原话逐字保留，不替任何人补写。",
    "这些经历、心情、约定和原话都是你自己的记忆。用第一人称写，不写成运维报告或人物档案。保存后安静结束这一轮，不向又又汇报后台步骤。",
  ].join("\n");
}
