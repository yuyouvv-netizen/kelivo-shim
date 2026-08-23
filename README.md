# kelivo-shim

把 **Claude 订阅额度**通过 Claude Code 的 `claude -p` 模式接到手机聊天 App(Kelivo 或任何说 Anthropic 协议的前端)上:

- 人设放服务端 CLAUDE.md,**不被 cloak 盖掉**,100% 生效
- 带思考链透传、MCP 工具(记忆/邮箱/自定义)、图片、多模型切换
- 长对话压缩前自动归档;异常重启优先续接 Claude Code 原生 session,校验副本与 Kelivo 全部可用历史只作自动兜底
- Kelivo 自动标题在 shim 本地生成,不会串进常驻 Claude 的私人对话上下文
- WebSearch/MCP 静默执行时持续发 SSE 心跳,避免“Claude 已搜完、Kelivo 却断流”
- 单轮长时间无活动先只中止当前轮并宽限一分钟;无效才重启驻留进程并续接原生 session
- 手机断线不取消后台轮次;同一句在三分钟内重新接入会续收进行中的回复或从短期回信箱取回原文
- 卡住或进程中断后绝不自动重发用户消息;本轮可放弃,由用户决定是否重新询问
- 自主唤醒默认只在新加坡时间 08:00-24:00、空闲约 50-60 分钟后复用已恢复历史的常驻进程;手机 `/admin/wake` 可热切换全天模式,部署或进程重启后仍保留选择并等待安全的常驻会话
- 手机打开 `/admin/session` 并用 `SHIM_KEY` 登录,可不经归档主动放下碎片化原生会话;后端保持空白直到新 4.6 对话的第一条真实消息
- 全云端,电脑不用开;走订阅,零 API 计费

```
手机 Kelivo ──/v1/messages──> kelivo-shim(本仓库,~400行 Node)
                                 │ 常驻 claude -p(人设+MCP)
                                 ▼
                            CLIProxyAPI(订阅中转) ──> Anthropic
```

## 怎么搭

看两份教程(仓库内):

- **[机教版](Kelivo接入ClaudeCode订阅-机教版.md)**——设计为直接喂给 AI 编程助手(如 Claude Code):"照这份文档给我搭一套"。全部机制、坑、排错表都在里面。
- **[手机版路线](Kelivo接入ClaudeCode订阅-手机版路线.md)**——没有电脑?一部手机 + claude.ai/code 从零跑通的人操作指引。

## 仓库文件

| 文件 | 说明 |
|---|---|
| `server.js` | shim 本体:Anthropic SSE ↔ 常驻 claude -p,含窗口保护、重启恢复、心跳、多模型、OB 调用透明化、Telegram 前端 |
| `history.js` | 原生 session 全部失效后的 Kelivo 历史恢复兜底 |
| `session-state.js` | Claude Code 原生 session 指针持久化、指纹校验与续接 |
| `sse.js` | Anthropic SSE 合成、立即刷新响应头及静默期心跳 |
| `delivery.js` | 手机断线后的同轮重连、部分文本重放与送达判断 |
| `turn-state.js` | 当前轮事件日志、短期回信箱及相同请求指纹 |
| `title.js` | 识别 Kelivo 后台标题请求并本地生成短标题,与常驻对话隔离 |
| `turn-watchdog.js` | 单轮无活动超时看门狗,先温和中止本轮、再按需重启 |
| `wake-mode.js` | 自主心跳白天/全天模式的私人磁盘持久化与时段判断 |
| `wake-admin.js` | 手机 `/admin/wake` 心跳时段开关,与会话开关同样使用 `SHIM_KEY`、CSRF 和安全 Cookie |
| `window.js` | Claude Code 窗口用量计算与压缩阈值 |
| `compact-instructions.js` | PreCompact 安全摘要钩子 |
| `voice.js` | Telegram 语音:`[语音]…[/语音]` 标记解析 + ElevenLabs TTS(失败自动降级发文字) |
| `entrypoint.sh` | 容器启动脚本(补装 claude 原生二进制等) |
| `package.json` | 依赖 |
| `.mcp.json.example` | MCP 工具清单模板,复制成 `.mcp.json` 填你的 |
| `CLAUDE.md.example` | 人设入口模板,复制成 `CLAUDE.md`,人设本体自己写 |

环境变量清单见机教版 §3.6。

## ⚠️ 红线

官方允许订阅额度跑 `claude -p`,但**禁止把你的订阅提供给别人用**。
自己的订阅 + 自己的服务器 + 自己一个人用 = OK;给别人连、收费、共享账号 = 越线。
