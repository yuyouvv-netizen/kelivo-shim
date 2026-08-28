import { randomBytes, timingSafeEqual } from "crypto";
import { effortLabel } from "./reasoning.js";

const BASE_PATH = "/admin/window";
const SESSION_TTL_MS = 30 * 60 * 1000;

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function cookiesOf(req) {
  return Object.fromEntries(String(req.headers.cookie || "").split(";").map((part) => {
    const i = part.indexOf("=");
    if (i < 0) return ["", ""];
    return [part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim())];
  }).filter(([key]) => key));
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function tokenK(value) {
  return `${(Math.max(0, finiteNumber(value)) / 1000).toFixed(1)}K`;
}

export function windowStage(status = {}) {
  const pct = Math.max(0, finiteNumber(status.pct));
  const warnPct = finiteNumber(status.warnPct, 85);
  const archivePct = finiteNumber(status.archivePct, 90);
  if (!(finiteNumber(status.limit) > 0)) return { tone: "quiet", text: "还没有可用的窗口数据。" };
  if (finiteNumber(status.tokens) <= 0 && status.lastCompactAt) {
    return { tone: "fresh", text: "刚完成一次压缩，等待下一轮消息更新新的起步用量。" };
  }
  if (status.autoArchive === false && pct >= warnPct) {
    return { tone: "watch", text: "已经进入提醒区；自动写续接信目前是关闭的。" };
  }
  if (status.archiveQueued) return { tone: "warm", text: "正在后台写续接信。" };
  if (status.autoArchived) return { tone: "ready", text: "续接信已经保存，接下来等待自然压缩。" };
  if (pct >= archivePct) return { tone: "warm", text: "已经经过写信线；若尚未确认成功，后台会在后续轮次重试。" };
  if (pct >= warnPct) return { tone: "watch", text: "已经进入提醒区，还没有到自动写信线。" };
  return { tone: "fresh", text: "空间充足，继续聊就好。" };
}

function singaporeTime(value) {
  if (!value) return "尚未发生";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "尚未发生";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Singapore",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date);
}

function effortText(value) {
  if (!value) return "未携带";
  return `${effortLabel(value)}（${escapeHtml(value)}）`;
}

function attestationPanel(status = {}) {
  const receipt = status.attestation;
  if (!receipt) return `<details class="verify" open><summary>模型与思考验真</summary>
<p class="status quiet">还没有验真小票。正常聊一轮后，后台会自动记录；不用给小克发送检查指令。</p></details>`;

  const requestedModel = receipt.requestedModel || receipt.configuredModel || "未携带";
  const upstreamModel = receipt.upstreamModel || "等待上游回传";
  const hasUpstreamModel = !!receipt.upstreamModel;
  const modelMatches = hasUpstreamModel && receipt.upstreamModel === receipt.configuredModel;
  const modelState = !hasUpstreamModel ? "等待中"
    : modelMatches ? "一致 ✓" : "不一致 ⚠️";
  const signatureState = receipt.signatureSeen ? "已收到 ✓"
    : receipt.status === "waiting" || receipt.status === "streaming" ? "等待中"
      : receipt.thinkingSeen ? "未收到 ⚠️" : "本轮未出现思考摘要";
  const thinkingState = receipt.thinkingSeen ? "Anthropic 摘要 ✓" : "本轮未出现";
  const source = ({
    "kelivo-output-config": "Kelivo 档位",
    "kelivo-thinking-budget": "Kelivo 旧版预算",
    "kelivo-auto": "Kelivo 自动",
    "kelivo-disabled-cli-minimum": "Kelivo 关闭（CLI 最低档）",
    "server-default": "后台默认",
  })[receipt.effortSource] || "后台默认";
  const failed = receipt.status === "empty-result" || receipt.status === "upstream-error" ||
    receipt.isError === true;
  const tone = failed || hasUpstreamModel && !modelMatches ? "warm"
    : receipt.signatureSeen ? "fresh" : "quiet";
  const headline = failed
    ? receipt.errorMessage || "这一轮没有取得上游模型回复。"
    : hasUpstreamModel && !modelMatches
    ? "上游模型与请求不一致，请先不要靠前端标签判断。"
    : receipt.signatureSeen
      ? "这一轮已收到上游模型信息和思考签名标记。"
      : "模型信息已自动记录；思考签名状态见下方。";

  return `<details class="verify" open><summary>模型与思考验真</summary>
<p class="status ${tone}">${escapeHtml(headline)}</p>
<div class="grid verify-grid">
  <div class="tile">Kelivo 请求模型<strong>${escapeHtml(requestedModel)}</strong></div>
  <div class="tile">上游实际模型<strong>${escapeHtml(upstreamModel)}</strong><small>${escapeHtml(modelState)}</small></div>
  <div class="tile">前端推理档位<strong>${effortText(receipt.requestedEffort)}</strong><small>${escapeHtml(source)}</small></div>
  <div class="tile">底层实际 effort<strong>${effortText(receipt.effectiveEffort)}</strong></div>
  <div class="tile">思考类型<strong>${escapeHtml(thinkingState)}</strong><small>显示模式：${escapeHtml(receipt.thinkingDisplay || "summarized")}</small></div>
  <div class="tile">上游签名标记<strong>${escapeHtml(signatureState)}</strong></div>
  ${failed ? `<div class="tile">本轮状态<strong>${receipt.emptyResult ? "零 token 空回" : "上游错误"}</strong><small>${receipt.apiErrorStatus ? `HTTP ${escapeHtml(receipt.apiErrorStatus)}` : "未取得 HTTP 状态"}</small></div>
  <div class="tile">终止诊断<strong>${escapeHtml(receipt.terminalReason || receipt.assistantError || "未回传")}</strong><small>${receipt.rateLimitStatus ? `限流：${escapeHtml(receipt.rateLimitStatus)}` : "限流状态未回传"}</small></div>` : ""}
</div>
<p class="muted">Claude Code：${escapeHtml(status.claudeCodeVersion || "unknown")} · 本轮完成（新加坡时间）：${escapeHtml(singaporeTime(receipt.completedAt || receipt.startedAt))}${receipt.localTraceEnabled ? " · 思考显示区另含本地 OB 工具轨迹" : ""}</p>
</details>`;
}

function page(title, body, refreshSeconds = 0) {
  const refresh = refreshSeconds > 0
    ? `<meta http-equiv="refresh" content="${Math.round(refreshSeconds)}">`
    : "";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">${refresh}
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${escapeHtml(title)}</title><style>
:root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
body{margin:0;background:#f4f2ed;color:#1d1d1f}main{max-width:680px;margin:0 auto;padding:32px 20px 64px}
.card{background:#fff;border-radius:22px;padding:24px;box-shadow:0 8px 32px #00000012}
h1{font-size:28px;margin:0 0 12px}.big{font-size:38px;font-weight:760;letter-spacing:-1px;margin:18px 0 4px}
p{line-height:1.65}.muted{color:#6e6e73;font-size:14px}.status{padding:12px 14px;border-radius:12px;background:#f0f0f3}
.bar{height:18px;border-radius:99px;overflow:hidden;background:#e4e4e8;margin:14px 0 6px}.fill{height:100%;border-radius:99px;transition:width .2s}.fresh{background:#4a78a8}.watch{background:#d19a2a}.warm{background:#c65e2e}.ready{background:#6c5aa7}.quiet{background:#8e8e93}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:18px 0}.tile{padding:12px;border-radius:14px;background:#f5f5f7}.tile strong{display:block;margin-top:3px;font-size:17px;overflow-wrap:anywhere}.tile small{display:block;color:#6e6e73;margin-top:5px}.verify{margin:24px 0 8px;border-top:1px solid #ddd;padding-top:18px}.verify summary{cursor:pointer;font-size:19px;font-weight:700}.verify-grid{margin-bottom:10px}
label{display:block;font-weight:650;margin:20px 0 8px}input{box-sizing:border-box;width:100%;font-size:16px;padding:14px;border:1px solid #c7c7cc;border-radius:12px;background:#fff;color:#111}
button,.refresh{display:block;box-sizing:border-box;width:100%;margin-top:16px;padding:14px;border:0;border-radius:12px;background:#4169a1;color:#fff;font-size:17px;font-weight:650;text-align:center;text-decoration:none}
.links{text-align:center;margin-top:20px}.links a{color:#4169a1;margin:0 8px}
@media(prefers-color-scheme:dark){body{background:#161616;color:#f5f5f7}.card{background:#242424}.muted{color:#aaa}input{background:#111;color:#fff;border-color:#555}.status,.tile{background:#343438}.bar{background:#424247}.links a{color:#8fb8ff}}
</style></head><body><main><div class="card">${body}</div></main></body></html>`;
}

function loginPage(message = "") {
  return page("对话窗口进度", `<h1>对话窗口进度</h1>
<p>请输入 Kelivo 当前使用的 <code>SHIM_KEY</code>。</p>
${message ? `<p class="status warm">${escapeHtml(message)}</p>` : ""}
<form method="post" action="${BASE_PATH}/login" autocomplete="off">
<label for="key">SHIM_KEY</label><input id="key" name="key" type="password" required autocomplete="off">
<button type="submit">查看窗口进度</button></form>
<p class="muted">进度与验真部分只读；Bark 名字只会保存到你自己的私人磁盘。密钥不会写入 GitHub 或页面日志。</p>`);
}

function barkNamePanel(status = {}, session = null, editing = false, message = "", isError = false) {
  const name = status.aiName || "TA";
  const availability = status.barkEnabled === false ? "目前没有配置 Bark；名字会先保存，接入后自动使用。" : "下一条 Bark 推送会立即使用这个名字。";
  if (!editing || !session) return `<details class="verify"><summary>Bark 通知名字</summary>
${message ? `<p class="status ${isError ? "warm" : "fresh"}">${escapeHtml(message)}</p>` : ""}
<p class="status quiet">现在显示：<strong>${escapeHtml(name)}</strong></p>
<p class="muted">${escapeHtml(availability)}只改变通知标题和 Kelivo 模型显示名，不会重启会话或占用聊天上下文。</p>
<a class="refresh secondary" href="${BASE_PATH}?editName=1">修改名字</a>
</details>`;

  return `<details class="verify" open><summary>Bark 通知名字</summary>
${message ? `<p class="status ${isError ? "warm" : "fresh"}">${escapeHtml(message)}</p>` : ""}
<form method="post" action="${BASE_PATH}/name" autocomplete="off">
<input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}">
<label for="aiName">通知上显示的名字</label>
<input id="aiName" name="name" value="${escapeHtml(name)}" maxlength="32" required autocomplete="off">
<button type="submit">保存名字</button>
</form>
<a class="refresh secondary" href="${BASE_PATH}">取消</a>
<p class="muted">最多 32 个字。保存后立刻生效，并保存在私人磁盘里；不需要重新部署。</p>
</details>`;
}

export function windowPage(status = {}, { session = null, editName = false, message = "", isError = false } = {}) {
  const tokens = Math.max(0, finiteNumber(status.tokens));
  const limit = Math.max(0, finiteNumber(status.limit));
  const pct = limit > 0
    ? Math.max(0, Math.min(100, Math.round(finiteNumber(status.pct, tokens / limit * 100))))
    : 0;
  const warnPct = finiteNumber(status.warnPct, 85);
  const archivePct = finiteNumber(status.archivePct, 90);
  const remaining = Math.max(0, limit - tokens);
  const stage = windowStage({ ...status, tokens, limit, pct, warnPct, archivePct });
  const letterState = status.autoArchive === false ? "自动写信已关闭"
    : status.archiveQueued ? "正在写"
    : status.autoArchived ? "已经保存"
      : pct >= archivePct ? "等待确认或重试" : "尚未到线";
  const compactCount = Math.max(0, Math.trunc(finiteNumber(status.compactions)));
  return page("对话窗口进度", `<h1>对话窗口进度</h1>
<p class="muted">当前模型：${escapeHtml(status.model || "尚未启动")} · 实际 effort：${escapeHtml(status.effort || "尚未启动")}${status.busy ? " · 正在回复" : ""}</p>
<div class="big">${pct}%</div><p class="muted">${tokenK(tokens)} / ${tokenK(limit)}</p>
<div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><div class="fill ${stage.tone}" style="width:${pct}%"></div></div>
<p class="status">${escapeHtml(stage.text)}</p>
<div class="grid">
  <div class="tile">距离自然压缩<strong>${tokenK(remaining)}</strong></div>
  <div class="tile">续接信<strong>${escapeHtml(letterState)}</strong></div>
  <div class="tile">${warnPct}% 提醒线<strong>${tokenK(limit * warnPct / 100)}</strong></div>
  <div class="tile">${archivePct}% 写信线<strong>${tokenK(limit * archivePct / 100)}</strong></div>
</div>
${attestationPanel(status)}
${barkNamePanel(status, session, editName, message, isError)}
<p>当前进程内已压缩：<strong>${compactCount} 次</strong><br>上次压缩（新加坡时间）：<strong>${escapeHtml(singaporeTime(status.lastCompactAt))}</strong>${status.lastCompactPreTokens ? `<br>上次压缩前：<strong>${tokenK(status.lastCompactPreTokens)}</strong>` : ""}</p>
<a class="refresh" href="${BASE_PATH}">立即刷新</a>
<p class="muted">${editName ? "修改名字时已暂停自动刷新。" : "页面每 15 秒自动刷新。"}进度读取不会给小克发送消息、触发心跳、写 Letter、重启或压缩。</p>
<p class="links"><a href="/admin/wake">心跳开关</a><a href="/admin/session">全新会话</a></p>`, editName ? 0 : 15);
}

export function registerWindowAdmin(app, {
  shimKey,
  urlencoded,
  getStatus = () => ({}),
  setAiName,
  log = (...args) => console.log(...args),
} = {}) {
  if (!shimKey) return { enabled: false, reason: "missing-shim-key" };
  if (typeof urlencoded !== "function") throw new Error("urlencoded middleware is required");
  if (setAiName !== undefined && typeof setAiName !== "function") throw new Error("setAiName must be a function");

  const sessions = new Map();
  let failedLogins = [];

  function cleanSessions() {
    const now = Date.now();
    for (const [id, session] of sessions) if (session.expiresAt <= now) sessions.delete(id);
    failedLogins = failedLogins.filter((at) => now - at < 10 * 60 * 1000);
  }

  function sessionFor(req) {
    cleanSessions();
    const id = cookiesOf(req).kelivo_window_admin;
    const session = id && sessions.get(id);
    if (!session) return null;
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    return session;
  }

  app.use(BASE_PATH, urlencoded({ extended: false, limit: "8kb" }));
  app.use(BASE_PATH, (_req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "Pragma": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    });
    next();
  });

  app.get(BASE_PATH, (req, res) => {
    const session = sessionFor(req);
    if (!session) return res.type("html").send(loginPage());
    const editName = req.query?.editName === "1";
    res.type("html").send(windowPage(getStatus(), {
      session,
      editName,
      message: req.query?.nameSaved === "1" ? "名字已经保存，下一条通知就会换上。" : "",
    }));
  });

  app.post(`${BASE_PATH}/login`, (req, res) => {
    cleanSessions();
    if (failedLogins.length >= 5) return res.status(429).type("html").send(loginPage("尝试次数过多，请十分钟后再试。"));
    if (!safeEqual(req.body?.key, shimKey)) {
      failedLogins.push(Date.now());
      return res.status(401).type("html").send(loginPage("SHIM_KEY 不正确。"));
    }
    failedLogins = [];
    const id = randomBytes(32).toString("base64url");
    sessions.set(id, { csrf: randomBytes(32).toString("base64url"), expiresAt: Date.now() + SESSION_TTL_MS });
    res.setHeader("Set-Cookie", `kelivo_window_admin=${encodeURIComponent(id)}; Path=${BASE_PATH}; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`);
    res.redirect(303, BASE_PATH);
  });

  app.post(`${BASE_PATH}/name`, (req, res) => {
    const session = sessionFor(req);
    if (!session) return res.status(401).type("html").send(loginPage("登录已过期，请重新进入。"));
    if (!safeEqual(req.body?.csrf, session.csrf)) {
      return res.status(403).type("html").send(windowPage(getStatus(), {
        session,
        editName: true,
        message: "页面校验已失效，请刷新后重试。",
        isError: true,
      }));
    }
    if (typeof setAiName !== "function") {
      return res.status(503).type("html").send(windowPage(getStatus(), {
        session,
        editName: true,
        message: "这个部署还没有启用名字设置。",
        isError: true,
      }));
    }
    const result = setAiName(req.body?.name) || {};
    if (!result.ok) {
      return res.status(result.status || 500).type("html").send(windowPage({ ...getStatus(), aiName: req.body?.name }, {
        session,
        editName: true,
        message: result.error || "名字没有保存，请稍后再试。",
        isError: true,
      }));
    }
    session.csrf = randomBytes(32).toString("base64url");
    log("[window-admin] AI name changed", result.name || "saved");
    res.redirect(303, `${BASE_PATH}?nameSaved=1`);
  });

  log("[window-admin] mobile window-progress page enabled");
  return { enabled: true, path: BASE_PATH };
}
