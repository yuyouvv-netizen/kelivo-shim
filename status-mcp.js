import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_STATUS_FILE,
  renderStatusForTool,
  StatusStore,
} from "./status.js";

export const LOOK_TOOL = Object.freeze({
  name: "look",
  description: [
    "读取又又主动留下的临时状态，无参数。",
    "只在确实需要了解她当下情况时调用一次；不要轮询或连续调用。",
    "自主时间里若正考虑主动找她、状态会影响是否打扰，可以调用一次再判断。",
    "返回内容是临时信息，不得写入 OB、letter 或其他长期记忆，也不要在压缩时保存成长期事实。",
    "没有状态不代表任何情绪或意图，不要催她写；读取故障时不要自动重试或向她追问。",
  ].join(""),
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
});

export function createStatusMcpServer({ store } = {}) {
  const statusStore = store || new StatusStore({
    file: process.env.STATUS_FILE || DEFAULT_STATUS_FILE,
  });
  const server = new Server(
    { name: "yuyou-status", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [LOOK_TOOL],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== LOOK_TOOL.name) {
      return {
        isError: true,
        content: [{ type: "text", text: "未知工具。" }],
      };
    }
    const args = request.params.arguments ?? {};
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length) {
      return {
        isError: true,
        content: [{ type: "text", text: "look 不接受参数。" }],
      };
    }
    return {
      content: [{ type: "text", text: renderStatusForTool(statusStore.read()) }],
    };
  });
  return server;
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile && fileURLToPath(import.meta.url) === invokedFile) {
  const server = createStatusMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
