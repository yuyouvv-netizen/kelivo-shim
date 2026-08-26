import { randomBytes, timingSafeEqual } from "crypto";

import { WAKE_MODE_ALWAYS, WAKE_MODE_DAY } from "./wake-mode.js";

const BASE_PATH = "/admin/wake";
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

function page(title, body) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${escapeHtml(title)}</title><style>
:root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
body{margin:0;background:#f4f2ed;color:#1d1d1f}main{max-width:680px;margin:0 auto;padding:32px 20px 64px}
.card{background:#fff;border-radius:22px;padding:24px;box-shadow:0 8px 32px #00000012}
h1{font-size:28px;margin:0 0 12px}p{line-height:1.65}.muted{color:#6e6e73;font-size:14px}
label{display:block;font-weight:650;margin:20px 0 8px}input{box-sizing:border-box;width:100%;font-size:16px;padding:14px;border:1px solid #c7c7cc;border-radius:12px;background:#fff;color:#111}
button{display:block;box-sizing:border-box;width:100%;margin-top:14px;padding:14px;border:0;border-radius:12px;color:#fff;font-size:17px;font-weight:650}.day{background:#4169a1}.always{background:#8b4cac}
.status{padding:12px 14px;border-radius:12px;background:#f0f0f3}.ok{color:#16723c}.err{color:#b42318}.current{font-weight:700}
a{color:#4169a1}
@media(prefers-color-scheme:dark){body{background:#161616;color:#f5f5f7}.card{background:#242424}.muted{color:#aaa}input{background:#111;color:#fff;border-color:#555}.status{background:#343438}a{color:#8fb8ff}}
</style></head><body><main><div class="card">${body}</div></main></body></html>`;
}

function loginPage(message = "") {
  return page("自主心跳开关", `<h1>自主心跳开关</h1>
<p>请输入 Kelivo 当前使用的 <code>SHIM_KEY</code>。</p>
${message ? `<p class="err">${escapeHtml(message)}</p>` : ""}
<form method="post" action="${BASE_PATH}/login" autocomplete="off">
<label for="key">SHIM_KEY</label><input id="key" name="key" type="password" required autocomplete="off">
<button class="day" type="submit">进入心跳开关</button></form>
<p class="muted">密钥只提交到你自己的 Zeabur 服务，不会写入 GitHub 或页面日志。</p>`);
}

function adminPage(session, status, message = "", isError = false) {
  const details = status || {};
  const always = details.mode === WAKE_MODE_ALWAYS;
  const label = always ? "全天 24 小时" : "白天 06:00–24:00";
  return page("自主心跳开关", `<h1>自主心跳开关</h1>
${message ? `<p class="status ${isError ? "err" : "ok"}">${escapeHtml(message)}</p>` : ""}
<p class="status">当前模式：<span class="current">${label}</span><br>检查间隔：约 ${escapeHtml(details.checkMin || 10)} 分钟<br>空闲触发：约 ${escapeHtml(details.idleMin || 50)}–${escapeHtml((details.idleMin || 50) + (details.checkMin || 10))} 分钟</p>
<p>这里只控制小克<strong>允许在哪些时段自主醒来</strong>，不会更换模型、重启会话或清空上下文。</p>
<form method="post" action="${BASE_PATH}/mode">
<input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}">
<button class="day" type="submit" name="mode" value="${WAKE_MODE_DAY}">使用白天模式（06:00–24:00）</button>
<button class="always" type="submit" name="mode" value="${WAKE_MODE_ALWAYS}">使用全天模式（24 小时）</button>
</form>
<p class="muted">全天模式只是取消夜间禁用；每轮仍由小克自己决定发 Bark 或保持沉默。没有常驻会话、正在回复或历史未恢复时，心跳安全门仍会阻止触发。设置保存在私人磁盘里，部署和重启后不会丢。</p>
<p class="muted"><a href="/admin/window">查看“窗口进度”</a> · <a href="/admin/session">前往“全新会话”开关</a></p>`);
}

export function registerWakeAdmin(app, {
  shimKey,
  urlencoded,
  getStatus = () => ({}),
  setMode,
  log = (...args) => console.log(...args),
} = {}) {
  if (!shimKey) return { enabled: false, reason: "missing-shim-key" };
  if (typeof urlencoded !== "function") throw new Error("urlencoded middleware is required");
  if (typeof setMode !== "function") throw new Error("setMode is required");

  const sessions = new Map();
  let failedLogins = [];

  function cleanSessions() {
    const now = Date.now();
    for (const [id, session] of sessions) if (session.expiresAt <= now) sessions.delete(id);
    failedLogins = failedLogins.filter((at) => now - at < 10 * 60 * 1000);
  }

  function sessionFor(req) {
    cleanSessions();
    const id = cookiesOf(req).kelivo_wake_admin;
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
    const saved = req.query?.saved === "1";
    res.type("html").send(adminPage(
      session,
      getStatus(),
      saved ? "心跳时段已经保存，并且立即生效。" : "",
    ));
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
    res.setHeader("Set-Cookie", `kelivo_wake_admin=${encodeURIComponent(id)}; Path=${BASE_PATH}; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`);
    res.redirect(303, BASE_PATH);
  });

  app.post(`${BASE_PATH}/mode`, (req, res) => {
    const session = sessionFor(req);
    if (!session) return res.status(401).type("html").send(loginPage("登录已过期，请重新进入。"));
    if (!safeEqual(req.body?.csrf, session.csrf)) {
      return res.status(403).type("html").send(adminPage(session, getStatus(), "页面校验已失效，请刷新后重试。", true));
    }
    if (req.body?.mode !== WAKE_MODE_DAY && req.body?.mode !== WAKE_MODE_ALWAYS) {
      return res.status(400).type("html").send(adminPage(session, getStatus(), "未知的心跳模式。", true));
    }
    const result = setMode(req.body.mode) || {};
    if (!result.ok) {
      return res.status(result.status || 500).type("html").send(adminPage(session, getStatus(), result.error || "心跳设置没有保存，请稍后再试。", true));
    }
    session.csrf = randomBytes(32).toString("base64url");
    log("[wake-admin] mode changed", result.mode || req.body.mode);
    res.redirect(303, `${BASE_PATH}?saved=1`);
  });

  log("[wake-admin] mobile wake-mode page enabled");
  return { enabled: true, path: BASE_PATH };
}
