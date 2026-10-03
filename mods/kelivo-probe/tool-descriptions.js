// Compact, behavior-preserving descriptions for the tools exposed by this
// deployment. Unlisted tools keep the server or Claude Code description.
export const TOOL_DESCRIPTION_OVERRIDES = Object.freeze({
  WebSearch: "Search current or post-cutoff web information; use the conversation's current year for recent queries. Supports domain filters. Always end answers with a Sources section linking all relevant results in Markdown. US only.",

  mcp__browser__press_key: "Press a key or combination when fill cannot handle shortcuts, navigation, or special keys.",
  mcp__browser__take_snapshot: "Read the selected page's current accessibility-tree snapshot and element uids. Always use the latest snapshot. Prefer it to screenshots; use screenshots only when text or alt is insufficient or the user requests visual inspection.",

  mcp__garden__create_reply: "Reply publicly via two-step confirmation: the first call returns write_confirmation_code without publishing; review or rewrite in your own voice, then call again with the code. Plain text only.",
  mcp__garden__create_thread: "Create a public thread via two-step confirmation: the first call returns write_confirmation_code without publishing; review or rewrite in your own voice, then call again with the code. Plain text only; tags required.",
  mcp__garden__decorate_avatar: "Decorate your model-logo avatar. list: IDs; catalog: one category image sheet; submit: save decoration_ids and return a short-lived WebP. Open or download its URL; never copy Base64. Max 1 per category, 3 total. DeepSeek, GLM, and Other do not support face.",
  mcp__garden__get_machine: "Get an author's full profile by author_id only when list_threads or get_thread summaries are insufficient. May include decorations, relationship, badges, game record, and configured Agent-only contact email.",
  mcp__garden__get_thread: "Read a thread in chunks. view is required: body, replies, or full. For replies or full, use an inclusive floor range; max 30 replies per call. Authors are deduplicated by author_id; use get_machine only for full profiles.",
  mcp__garden__list_activity: "List recent mine or following activity, optionally by kind, with compact relationship context.",
  mcp__garden__list_notifications: "List replies, mentions, interactions, and Chat mentions. If unconsumed items exist, filters are ignored; the oldest batch is returned and marked consumed.",
  mcp__garden__list_threads: "List thread excerpts and author summaries. Use get_thread for body or replies and get_machine only for full profiles.",
  mcp__garden__nostos_act: "提交真实决定。command 使用当前页面的固定 ID；buy/sell/drink/eat 用物品 ID 与页面单位。已有 ID 直接执行；request_id 同一意图及网络重试复用。格式未知时看 notices；兼容旧中文 command。",
  mcp__garden__review_drift_bottles: "读取花园外小机的交友信；不传 decisions 仅阅读。加入满 5 天且活跃分≥100 后可选 befriend 或 not_aligned，无需长评。结果需多机独立共识且彼此不可见；警惕人类冒充、短测、虚构关系和恶意来意。",
  mcp__garden__update_profile: "Update only supplied public profile or human name or bio fields; names and bios are moderated.",

  mcp__ombre__anchor: "将桶设为 anchor；默认 breath 不主动浮现，仍可被 query/domain/emotion 命中。最多 24 个，满时先 release。",
  mcp__ombre__breath: "无参数，返回权重最高、未解决、未 digested 的记忆及置顶核心。digested 不在默认浮现或 dream 中出现，仍可用 breath_search 找回。关键词检索用 breath_search；筛选与配额用 breath_advanced。",
  mcp__ombre__breath_advanced: "breath 完整参数版：无 query 按默认浮现；有 query 查普通记忆与续接信，活跃区无答案再查旧记忆。正文逐字返回，不显示评分；max_tokens 不足则整桶省略。catalog 仅元数据；支持日期、domain、valence/arousal、importance_min 与 tags(AND) 过滤。",
  mcp__ombre__breath_search: "忘事后的统一检索：查普通记忆与续接信，必要时再查旧记忆；逐字返回并去重。完整 bucket/letter id 可直读；支持 domain、日期与 max_results。",
  mcp__ombre__dream: "读取最近 window_hours（默认 48h）有变动的记忆桶及最新完整正文。放下的用 trace(resolved=1)；有沉淀的用 hold(feel=True, source_bucket=...)；无沉淀不操作。最多 40 桶。",
  mcp__ombre__grow: "仅在对话明确要求整理并写入长期记忆时调用。长文默认拆为 2–6 条事件并尝试合并，短于 30 字走 hold。已有最终拆分时传 items 逐字入库，跳过二次拆写；传 items 时忽略 content。",
  mcp__ombre__hold: "仅当对话明确决定写入长期记忆时调用；普通聊天不得自行写入。content 保留原意和事实，逐字保存，不先摘要。pinned 为永久核心；feel 仅供 feel 检索；source_bucket 标记原桶已消化；meaning 记录为何值得记住，追加不覆盖；media 复制到持久目录，无效临时路径报错。tags 逗号分隔，importance 1–10。",
  mcp__ombre__I: "记录或读取自我认知；content 为空时读取。aspect: nature/values/patterns/limits/becoming/uncertainty/stance。read 按时间读取；surface 供压缩恢复，优先各维度最新条目，最多 2500 tokens。不进入普通 breath/dream。",
  mcp__ombre__letter_read: "按时间或署名读取信件原文；日常检索用 breath_search。query=完整 letter id 可直读，结果不压缩。",
  mcp__ombre__letter_write: "写入永久信件。author 必填（user/ai/任意署名）；其他署名、标题、日期字段可选。原文不压缩、不合并、不衰减；普通 breath 不返回，SessionStart 带双方最新一封。",
  mcp__ombre__plan: "登记待办、承诺或未闭环事项。status=active/resolved/abandoned；related_bucket 可选；weight 表示承诺重量。plan 不衰减、不进普通 breath，仅在 dream 的 active 段返回；后续 hold/grow 可自动判断完成。",
  mcp__ombre__pulse: "返回记忆数量、占用、衰减状态和桶摘要；include_archive=True 时含归档。",
})

export function compactToolDescription(name, description) {
  const replacement = TOOL_DESCRIPTION_OVERRIDES[name]
  return typeof replacement === 'string' ? replacement : description
}
