// Ombre Brain 当前公开的“长内容归档”工具是 grow。不同版本的 MCP 包装层
// 可能把返回值再包成 JSON 字符串，所以这里只匹配稳定的人类可读结果片段。

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
  if (tool === "grow") return growSavedMemory(text);
  // 兼容曾暴露 archive_session 的自建/旧版 OB，不作为当前主路径。
  if (tool === "archive_session") return typeof text === "string" && text.includes("🗄️");
  return false;
}
