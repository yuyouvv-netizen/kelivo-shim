#!/usr/bin/env node

import { COMPACT_RECOVERY_CONTEXT } from "./compact-recovery-text.js";

// SessionStart(compact) 的最后一层语义兜底。MCP hook 的 breath / breath_search
// 结果会与这段文字一起进入上下文；这里不要求模型自己再执行一遍工具。
process.stdout.write(COMPACT_RECOVERY_CONTEXT);
