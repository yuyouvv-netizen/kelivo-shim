import path from "path";

export const RECENT_MEMORY_QUERY = "续接短札 最近几天 又又 心情 约定 未完事项 原话";
export const RECENT_MEMORY_RESULTS = 5;

export function buildCompactSettings({
  dir = import.meta.dirname || process.cwd(),
  memoryEnabled = true,
  memoryServer = "ombre",
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
          input: {},
          timeout: 30,
        },
        {
          type: "mcp_tool",
          server: memoryServer,
          tool: "breath_search",
          input: {
            query: RECENT_MEMORY_QUERY,
            max_results: RECENT_MEMORY_RESULTS,
            quotes: true,
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
