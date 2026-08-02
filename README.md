# kelivo-shim

把 **Claude 订阅额度**通过 Claude Code 的 `claude -p` 模式接到手机聊天 App(Kelivo 或任何说 Anthropic 协议的前端)上:

- 人设放服务端 CLAUDE.md,**不被 cloak 盖掉**,100% 生效
- 带思考链透传、MCP 工具(记忆/邮箱/自定义)、图片、多模型切换
- 长对话压缩前自动归档;服务重启后从 Kelivo 最近历史恢复,不再只记头尾
- Kelivo 自动标题在 shim 本地生成,不会串进常驻 Claude 的私人对话上下文
- 单轮长时间无活动会自动解卡并重启驻留进程,后续消息从 Kelivo 历史恢复
- 自主唤醒只复用已经恢复历史的常驻进程;部署或进程重启后会等第一条真实 Kelivo 消息恢复历史,`/hb` 强制触发也不会绕过这道保护
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
| `history.js` | 进程重启后的 Kelivo 历史恢复(主动换窗时自动禁用) |
| `title.js` | 识别 Kelivo 后台标题请求并本地生成短标题,与常驻对话隔离 |
| `turn-watchdog.js` | 单轮无活动超时看门狗,防止一次卡死永久堵住后续消息 |
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
