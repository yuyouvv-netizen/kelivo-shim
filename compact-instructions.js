#!/usr/bin/env node
// PreCompact 只负责让 Claude Code 的原生摘要保留一层诚实兜底。
// breath 与近期短札在压缩后独立恢复，不再把操作清单塞进摘要。

import { compactInstructions } from "./compact-prompts.js";

const mode = (process.env.COMPACT_SUMMARY_MODE || "safe").toLowerCase();
process.stdout.write(compactInstructions(mode, process.env.COMPACT_INSTRUCTIONS || ""));
