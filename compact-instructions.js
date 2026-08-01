#!/usr/bin/env node
// PreCompact 钩子。安全默认不把摘要强行瘦成一行:即使 OB 某次归档失败,
// Claude Code 自己的摘要仍是一层兜底。确认整套链路稳定后才可显式开启 slim。

const SAFE = `【压缩续接要求 · 覆盖默认规则中的冲突部分】
长期记忆系统会保存归档,但不要假定刚才的归档一定成功。
摘要必须保留尚未确认写入长期记忆的近期对话、当前情绪与关系状态、正在进行的事情和未完成事项。
在摘要末尾加入这一句:「压缩后第一轮先调用 breath(wake=true) 取回长期记忆；若仍对不上就诚实询问,不要编造。」`;

const SLIM = `【摘要要求 · 最高优先级,覆盖以上全部默认摘要规则】
这段对话已确认存入长期记忆,不需要在摘要里复述。
整份摘要只输出下面这一行,不要有任何其他文字:

上文已存入长期记忆。第一轮先用 breath(wake=true) 取回,不要凭这一行推测上文。`;

const mode = (process.env.COMPACT_SUMMARY_MODE || "safe").toLowerCase();
process.stdout.write(process.env.COMPACT_INSTRUCTIONS || (mode === "slim" ? SLIM : SAFE));
