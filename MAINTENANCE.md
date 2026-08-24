# 维护者须知(For maintainers & future Claude Code sessions)

> 本仓库是**公开 OSS**。这里只写通用机制;部署细节、服务 ID、事故档案、避坑清单
> 在 owner 的**私有仓库 `ob-backup` 的 `SYSTEM-HANDBOOK.md`** ——
> 任何维护会话(尤其是新开的 Claude Code)**先去读那份完整手册再动手**。

## 红线(违反会出事故)

1. **绝不提交**:密钥、token、服务 ID、真实域名配置、人设文件(CLAUDE.md /
   profile-instructions.md / *self-prompt*)。`.gitignore` 挡着,不要绕过。
2. **运行时的真实配置与人设,正本在部署平台的持久卷 `/persona` 里**,
   `entrypoint.sh` 开机自动恢复到 `/src`(*.md 人设 + `.mcp.json`)。
   `/src` 是容器临时盘——换容器就清空,**手工放进 /src 的东西必须同步放进 /persona**。
3. 部署会重启常驻 claude 进程。现在会从 Kelivo 请求里的最近历史自动恢复,但前端
   可能只发送有限条消息,所以**动部署前仍先安排归档**;恢复层是事故兜底,不是归档替代品。

## 核心机制速览(详见代码注释)

- **单进程串行**:一个常驻 `claude -p`(stream-json),Kelivo 与 Telegram 共用。
- **聊天不是运维命令**(`submitTurn`):任何聊天文字(包括「换窗口/开新窗口」)都不会触发
  新 session。归档由 AI 按人设约定自然处理;主动换人使用聊天外操作(当前切模型/世界书
  会创建新 session),避免把告别命令塞进两人的对话。
- **安全阀**(`handleEvent`):续接短札用 OB 的 `hold` 保存成一条完整记忆;检测其
  tool_result 中的 `新建→` / `合并→` 才算落盘成功。兼容更新前仍在途的 `grow`
  与旧 `archive_session`。
  成功才允许换窗杀进程;否则保窗并提示。宁可不换窗,不丢记忆。
- **原生续接**(`session-state.js`/`entrypoint.sh`):Claude Code transcript 的 `projects`
  目录接到 `/persona/claude-state`,shim 保存经模型+系统提示词指纹约束的 session ID。
  进程崩溃/看门狗硬重启优先 `--resume`;被 CLI 明确拒绝时先重试原件一次,再保留异常
  原件并自动换入 SHA-256 校验通过的副本,以同一 session ID 再试。网络/鉴权失败只退避
  重试原会话,不触发降级。模型或世界书变化才强制新 session。
- **降级恢复**(`history.js`/`procNeedsHistory`):只有原生 session 原件和同 session 副本均
  续接失败时,才在新进程第一条 Kelivo 消息中补送前端实际提供的全部历史(默认不再砍成
  128 条,字符预算仍生效)。常驻进程正常聊天不重复喂。
- **断流/卡死保护**(`sse.js`/`turn-watchdog.js`):SSE 立即 flush headers,静默工具期
  周期发送 comment heartbeat。五分钟无 Claude 事件时先发 stream-json `interrupt`
  只中止当前轮;宽限期仍无结果才杀进程,随后优先原生续接。
- **回信箱/同轮重连**(`delivery.js`/`turn-state.js`):请求指纹相同且仍在执行时,
  新 SSE 连接附着到原轮并先重放已生成文字;最近完成回复短期写入 `/persona/turn-state`,
  手机断线后重发同一句直接取回原文,不再次调用模型。
- **事件亲历记录**(`turn-state.js`):持久化当前输入、工具开始/参数/返回、部分输出和
  完成状态,仅供本地排错与回信箱使用;不保存隐藏 thinking,也绝不作为后台提示词塞回
  对话。卡住或进程中断后不自动重发任何用户消息,由用户决定是否重新询问。
- **优雅停机/滚动副本**:SIGTERM 先停接新轮、interrupt 当前轮并 flush 事件日志,
  Claude 原生 transcript 每轮更新最近一份备份并记录大小与 SHA-256;原文件缺失时自动恢复,
  resume 明确失败时旁存原件后自动换入已校验副本。
- **长窗保护**(`window.js`/`compact-settings.js`):从每次 `message_start` 取真实
  前缀。普通订阅模型按标准 200K 上下文、约 167K 原生压缩线计算，80% 提醒、
  85% 自动调用 `hold` 留一封第一人称续接短札；只有模型名显式带 `[1m]` 才按
  扩展窗口处理。PreCompact 的 `safe` 摘要保留诚实兜底；压缩完成后的
  `SessionStart(compact)` 自动取回 `breath` 与近期短札，再把它们作为同一个人的
  记忆续接。不要轻易把 `COMPACT_SUMMARY_MODE` 改成 `slim`。
- **人设保险箱**(`entrypoint.sh`):开机从 `/persona` 恢复缺失的人设与 `.mcp.json`。
- **语音**(`voice.js`):`[语音]…[/语音]` 段落 → ElevenLabs opus 直出(失败降级
  mp3+ffmpeg,再失败降级文字)。突然不出声九成是 ElevenLabs 月度额度用完。
- **表情包**(`stickers.js`):回复里的 `[贴纸:名字]` 查注册表 → `sendSticker`
  发原生贴纸(**不是 `sendPhoto`**,后者会整宽显示占半屏)。名字不在表里或标记
  没闭合就原样当文字,不吞字。注册表(名字→`file_id`)与图都在持久卷上,
  路径见 `STICKER_REGISTRY` / `STICKER_DIR`,不配即静默关闭。
  首次上传后回写 `file_id`,之后重启/重部署直接复用。
  使用者在 Telegram 里发一个贴纸、下一句说「入库:名字」即可入库,
  「贴纸清单」看有哪些,「删除贴纸:名字」删——这些管理动作不进对话窗口。

## 工作规范

- 改动走开发分支,不直推 main;commit 说清「改了什么、为什么」。
- 部署后**主动验证**(`/health`、`/debug`、exec 查代码特征串)——
  `zeabur deploy` 返回成功只是上传成功,滚动上线是异步的。
- `/debug.window` 看窗口、自动归档和压缩状态;`/debug.session` 看原生续接,
  `/debug.recovery` 看 Kelivo 降级恢复,`/debug.stream`/`watchdog` 看断流与解卡保护,
  `/debug.delivery` 看回信箱与在途请求。
- 干完活去私有手册追加变更日志与新踩的坑。
