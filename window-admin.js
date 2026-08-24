import { randomBytes, timingSafeEqual } from "crypto";

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
  const warnPct = finiteNumber(status.warnPct, 80);
  const archivePct = finiteNumber(status.archivePct, 85);
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
.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:18px 0}.tile{padding:12px;border-radius:14px;background:#f5f5f7}.tile strong{display:block;margin-top:3px;font-size:17px}
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
<p class="muted">这是只读页面。密钥只提交到你自己的 Zeabur 服务，不会写入 GitHub 或页面日志。</p>`);
}

export function windowPage(status = {}) {
  const tokens = Math.max(0, finiteNumber(status.tokens));
  const limit = Math.max(0, finiteNumber(status.limit));
  const pct = limit > 0
    ? Math.max(0, Math.min(100, Math.round(finiteNumber(status.pct, tokens / limit * 100))))
    : 0;
  const warnPct = finiteNumber(status.warnPct, 80);
  const archivePct = finiteNumber(status.archivePct, 85);
  const remaining = Math.max(0, limit - tokens);
  const stage = windowStage({ ...status, tokens, limit, pct, warnPct, archivePct });
  const letterState = status.autoArchive === false ? "自动写信已关闭"
    : status.archiveQueued ? "正在写"
    : status.autoArchived ? "已经保存"
      : pct >= archivePct ? "等待确认或重试" : "尚未到线";
  const compactCount = Math.max(0, Math.trunc(finiteNumber(status.compactions)));
  return page("对话窗口进度", `<h1>对话窗口进度</h1>
<p class="muted">当前模型：${escapeHtml(status.model || "尚未启动")}${status.busy ? " · 正在回复" : ""}</p>
<div class="big">${pct}%</div><p class="muted">${tokenK(tokens)} / ${tokenK(limit)}</p>
<div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><div class="fill ${stage.tone}" style="width:${pct}%"></div></div>
<p class="status">${escapeHtml(stage.text)}</p>
<div class="grid">
  <div class="tile">距离自然压缩<strong>${tokenK(remaining)}</strong></div>
  <div class="tile">续接信<strong>${escapeHtml(letterState)}</strong></div>
  <div class="tile">80% 提醒线<strong>${tokenK(limit * warnPct / 100)}</strong></div>
  <div class="tile">85% 写信线<strong>${tokenK(limit * archivePct / 100)}</strong></div>
</div>
<p>当前进程内已压缩：<strong>${compactCount} 次</strong><br>上次压缩（新加坡时间）：<strong>${escapeHtml(singaporeTime(status.lastCompactAt))}</strong>${status.lastCompactPreTokens ? `<br>上次压缩前：<strong>${tokenK(status.lastCompactPreTokens)}</strong>` : ""}</p>
<a class="refresh" href="${BASE_PATH}">立即刷新</a>
<p class="muted">页面每 15 秒自动刷新。它只读取 shim 最近一次收到的真实用量，不会给小克发送消息、触发心跳、写 Letter、重启或压缩。</p>
<p class="links"><a href="/admin/wake">心跳开关</a><a href="/admin/session">全新会话</a></p>`, 15);
}

export function registerWindowAdmin(app, {
  shimKey,
  urlencoded,
  getStatus = () => ({}),
  log = (...args) => console.log(...args),
} = {}) {
  if (!shimKey) return { enabled: false, reason: "missing-shim-key" };
  if (typeof urlencoded !== "function") throw new Error("urlencoded middleware is required");

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
    if (!sessionFor(req)) return res.type("html").send(loginPage());
    res.type("html").send(windowPage(getStatus()));
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
    sessions.set(id, { expiresAt: Date.now() + SESSION_TTL_MS });
    res.setHeader("Set-Cookie", `kelivo_window_admin=${encodeURIComponent(id)}; Path=${BASE_PATH}; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`);
    res.redirect(303, BASE_PATH);
  });

  log("[window-admin] mobile window-progress page enabled");
  return { enabled: true, path: BASE_PATH };
}
