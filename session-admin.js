import { randomBytes, timingSafeEqual } from "crypto";

const BASE_PATH = "/admin/session";
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
button{display:block;box-sizing:border-box;width:100%;margin-top:18px;padding:14px;border:0;border-radius:12px;background:#b42318;color:#fff;font-size:17px;font-weight:650}
.status{padding:12px 14px;border-radius:12px;background:#f0f0f3}.ok{color:#16723c}.err{color:#b42318}
@media(prefers-color-scheme:dark){body{background:#161616;color:#f5f5f7}.card{background:#242424}.muted{color:#aaa}input{background:#111;color:#fff;border-color:#555}.status{background:#343438}}
</style></head><body><main><div class="card">${body}</div></main></body></html>`;
}

function loginPage(message = "") {
  return page("开启全新的 4.6", `<h1>开启全新的 4.6</h1>
<p>请输入 Kelivo 当前使用的 <code>SHIM_KEY</code>。</p>
${message ? `<p class="err">${escapeHtml(message)}</p>` : ""}
<form method="post" action="${BASE_PATH}/login" autocomplete="off">
<label for="key">SHIM_KEY</label><input id="key" name="key" type="password" required autocomplete="off">
<button type="submit">进入会话开关</button></form>
<p class="muted">密钥只提交到你自己的 Zeabur 服务，不会写入 GitHub 或页面日志。</p>`);
}

function adminPage(session, status, message = "", isError = false) {
  const details = status || {};
  return page("开启全新的 4.6", `<h1>开启全新的 4.6</h1>
${message ? `<p class="status ${isError ? "err" : "ok"}">${escapeHtml(message)}</p>` : ""}
<p class="status">当前模型：${escapeHtml(details.model || "尚未启动")}<br>状态：${details.busy ? "正在回复，暂时不能切换" : details.awaitingFirstMessage ? "已放下旧会话，等待空白 4.6 的第一句话" : "可以切换"}</p>
<p>这个开关会立即放下当前原生会话，下一条消息从全新的 4.6 开始。<strong>不要求先归档。</strong></p>
<p class="muted">不会删除 CLAUDE.md、OB、工具或 Kelivo 里的旧聊天。切换后请只从准备好的空白 4.6 对话发送第一句话；旧对话可以保留查看，但不要继续发送。</p>
<form method="post" action="${BASE_PATH}/fresh">
<input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}">
<button type="submit">确认放下当前会话，开启全新 4.6</button>
</form>`);
}

export function registerSessionAdmin(app, {
  shimKey,
  urlencoded,
  getStatus = () => ({}),
  startFreshSession,
  log = (...args) => console.log(...args),
} = {}) {
  if (!shimKey) return { enabled: false, reason: "missing-shim-key" };
  if (typeof urlencoded !== "function") throw new Error("urlencoded middleware is required");
  if (typeof startFreshSession !== "function") throw new Error("startFreshSession is required");

  const sessions = new Map();
  let failedLogins = [];

  function cleanSessions() {
    const now = Date.now();
    for (const [id, session] of sessions) if (session.expiresAt <= now) sessions.delete(id);
    failedLogins = failedLogins.filter((at) => now - at < 10 * 60 * 1000);
  }

  function sessionFor(req) {
    cleanSessions();
    const id = cookiesOf(req).kelivo_session_admin;
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
    const success = req.query?.fresh === "1";
    res.type("html").send(adminPage(
      session,
      getStatus(),
      success ? "全新的 4.6 已准备好。现在可以回到空白对话发送第一句话。" : "",
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
    res.setHeader("Set-Cookie", `kelivo_session_admin=${encodeURIComponent(id)}; Path=${BASE_PATH}; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`);
    res.redirect(303, BASE_PATH);
  });

  app.post(`${BASE_PATH}/fresh`, (req, res) => {
    const session = sessionFor(req);
    if (!session) return res.status(401).type("html").send(loginPage("登录已过期，请重新进入。"));
    if (!safeEqual(req.body?.csrf, session.csrf)) {
      return res.status(403).type("html").send(adminPage(session, getStatus(), "页面校验已失效，请刷新后重试。", true));
    }
    const result = startFreshSession() || {};
    if (!result.ok) {
      return res.status(result.status || 409).type("html").send(adminPage(session, getStatus(), result.error || "现在不能切换，请稍后再试。", true));
    }
    session.csrf = randomBytes(32).toString("base64url");
    log("[session-admin] manual fresh session requested");
    res.redirect(303, `${BASE_PATH}?fresh=1`);
  });

  log("[session-admin] mobile fresh-session page enabled");
  return { enabled: true, path: BASE_PATH };
}
