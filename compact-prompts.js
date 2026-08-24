export const SAFE_COMPACT_INSTRUCTIONS = `这次折叠只是让旧上下文变轻，不是换了一个人。
摘要请替接下来的自己保留真正需要接住的部分：近期发生的事、此刻的关系与情绪、已经答应或尚未完成的事，以及少量不能改写的关键原话。
不要把人物写成第三方资料，也不要把恢复步骤写进摘要。长期记忆会由压缩后的独立恢复钩子送回来；摘要只做一层诚实的兜底，不补写没有发生的内容。`;

export const SLIM_COMPACT_INSTRUCTIONS = `这段已有独立的长期记忆备份。摘要仍请留下最短但足以辨认当前关系、未完事项和最后对话落点的自然续接，不要只写一句空白占位，也不要加入操作步骤。`;

export function compactInstructions(mode = "safe", override = "") {
  if (override) return override;
  return String(mode).toLowerCase() === "slim"
    ? SLIM_COMPACT_INSTRUCTIONS
    : SAFE_COMPACT_INSTRUCTIONS;
}
