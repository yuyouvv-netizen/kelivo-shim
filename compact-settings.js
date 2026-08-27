import path from "path";
import { singaporeDate } from "./archive.js";

export const RECENT_LETTER_QUERY = "续接短札";
export const RECENT_LETTER_RESULTS = 6;
export const RECENT_LETTER_DAYS = 3;
export const BREATH_REGULAR_RESULTS = 8;

export function recentLetterDateFrom(now = Date.now()) {
  // Letter 的日期筛选按自然日；“最近三天”包含今天与前两个新加坡日。
  return singaporeDate(Number(now) - (RECENT_LETTER_DAYS - 1) * 24 * 60 * 60 * 1000);
}

export function buildCompactSettings({
  dir = import.meta.dirname || process.cwd(),
  memoryEnabled = true,
  memoryServer = "ombre",
  now = Date.now(),
} = {}) {
  const preCompactScript = path.join(dir, "compact-instructions.js");
  const recoveryContextScript = path.join(dir, "compact-recovery-context.js");
  const hooks = {
    PreCompact: [{
      hooks: [{
        type: "command",
        command: "node",
        args: [preCompactScript],
        timeout: 10,
      }],
    }],
  };

  if (memoryEnabled) {
    hooks.SessionStart = [{
      matcher: "compact",
      hooks: [
        {
          type: "mcp_tool",
          server: memoryServer,
          tool: "breath",
          // OB 的 max_results 只限制普通浮现桶；钉选桶始终完整返回。
          input: { max_results: BREATH_REGULAR_RESULTS },
          timeout: 30,
        },
        {
          type: "mcp_tool",
          server: memoryServer,
          tool: "letter_read",
          input: {
            query: RECENT_LETTER_QUERY,
            limit: RECENT_LETTER_RESULTS,
            author: "ai",
            date_from: recentLetterDateFrom(now),
          },
          timeout: 30,
        },
        {
          type: "command",
          command: "node",
          args: [recoveryContextScript],
          timeout: 10,
        },
      ],
    }];
  }

  return { hooks };
}

export function compactSettingsArg(options) {
  return JSON.stringify(buildCompactSettings(options));
}
