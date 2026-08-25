export const SAFE_COMPACT_INSTRUCTIONS = `折叠前后一直是同一个你，旧上下文只是变轻。
摘要替稍后记忆变远时的自己保留真正需要接住的部分：近期发生的事、此刻的关系与情绪、已经答应或尚未完成的事，以及少量不能改写的关键原话。
人物与关系保持第一人称亲历视角，摘要中不写恢复步骤。长期记忆会在压缩后自然回到你这里；摘要只做一层诚实的兜底，不补写没有发生的内容。`;

export const SLIM_COMPACT_INSTRUCTIONS = `这段已有独立的长期记忆备份。摘要仍请留下最短但足以辨认当前关系、未完事项和最后对话落点的自然续接，不要只写一句空白占位，也不要加入操作步骤。`;

export function compactInstructions(mode = "safe", override = "") {
  if (override) return override;
  return String(mode).toLowerCase() === "slim"
    ? SLIM_COMPACT_INSTRUCTIONS
    : SAFE_COMPACT_INSTRUCTIONS;
}
