import { randomBytes, timingSafeEqual } from "crypto";

const BASE_PATH = "/admin/session";
const SESSION_TTL_MS = 30 * 60 * 1000;
const EFFORT_LABELS = Object.freeze({
  low: "轻度",
  medium: "中度",
  high: "重度",
  xhigh: "极限",
  max: "全力",
});

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
h1{font-size:28px;margin:0 0 12px}h2{font-size:20px;margin:28px 0 8px}p{line-height:1.65}.muted{color:#6e6e73;font-size:14px}
label{display:block;font-weight:650;margin:18px 0 8px}input,select{box-sizing:border-box;width:100%;font-size:16px;padding:14px;border:1px solid #c7c7cc;border-radius:12px;background:#fff;color:#111}
button{display:block;box-sizing:border-box;width:100%;margin-top:16px;padding:14px;border:0;border-radius:12px;color:#fff;font-size:17px;font-weight:650}.primary{background:#4169a1}.danger-button{background:#b42318}
.status{padding:12px 14px;border-radius:12px;background:#f0f0f3}.ok{color:#16723c}.err{color:#b42318}.current{font-weight:700}.danger{margin-top:30px;padding-top:4px;border-top:1px solid #dedee3}
.confirm{display:flex;gap:10px;align-items:flex-start;font-weight:500;line-height:1.5;margin-top:18px}.confirm input{width:22px;height:22px;flex:0 0 22px;margin:1px 0 0}
a{color:#4169a1}
@media(prefers-color-scheme:dark){body{background:#161616;color:#f5f5f7}.card{background:#242424}.muted{color:#aaa}input,select{background:#111;color:#fff;border-color:#555}.status{background:#343438}a{color:#8fb8ff}.danger{border-color:#444}}
</style></head><body><main><div class="card">${body}</div></main></body></html>`;
}

function modelLabel(model) {
  const match = /^claude-([a-z]+)-(.+)$/i.exec(String(model || ""));
  if (!match) return String(model || "未知模型");
  const family = match[1][0].toUpperCase() + match[1].slice(1);
  return `Claude ${family} ${match[2].replace(/-/g, ".")}`;
}

function optionsFor(values, selected, labelOf = (value) => value) {
  return values.map((value) => `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(labelOf(value))}</option>`).join("");
}

function loginPage(message = "") {
  return page("会话与模型", `<h1>会话与模型</h1>
<p>请输入 Kelivo 当前使用的 <code>SHIM_KEY</code>。</p>
${message ? `<p class="err">${escapeHtml(message)}</p>` : ""}
<form method="post" action="${BASE_PATH}/login" autocomplete="off">
<label for="key">SHIM_KEY</label><input id="key" name="key" type="password" required autocomplete="off">
<button class="primary" type="submit">进入安全控制台</button></form>
<p class="muted">密钥只提交到你自己的 Zeabur 服务，不会写入 GitHub 或页面日志。</p>`);
}

function adminPage(session, status, message = "", isError = false) {
  const details = status || {};
  const models = Array.isArray(details.models) && details.models.length
    ? details.models : [details.model || "claude-opus-4-6"];
  const efforts = Array.isArray(details.efforts) && details.efforts.length
    ? details.efforts : Object.keys(EFFORT_LABELS);
  const model = models.includes(details.model) ? details.model : models[0];
  const effort = efforts.includes(details.effort) ? details.effort : efforts[0];
  const state = details.busy ? "正在回复，暂时不能修改"
    : details.awaitingFirstMessage ? "旧会话已放下，等待 Telegram 或 Kelivo 的第一句话"
      : "可以调整";
  return page("会话与模型", `<h1>会话与模型</h1>
${message ? `<p class="status ${isError ? "err" : "ok"}">${escapeHtml(message)}</p>` : ""}
<p class="status">当前/下一段模型：<span class="current">${escapeHtml(modelLabel(model))}</span><br>思考档位：<span class="current">${escapeHtml(EFFORT_LABELS[effort] || effort)}（${escapeHtml(effort)}）</span><br>状态：${escapeHtml(state)}</p>

<h2>调整当前思考档位</h2>
<p>只调整思考强度，继续使用同一个原生 session，不会清空上下文。</p>
<form method="post" action="${BASE_PATH}/effort">
<input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}">
<label for="current-effort">思考档位</label>
<select id="current-effort" name="effort" required>${optionsFor(efforts, effort, (value) => `${EFFORT_LABELS[value] || value}（${value}）`)}</select>
<button class="primary" type="submit">保存档位并继续当前会话</button>
</form>
<p class="muted">后台正在回复、压缩或调用工具时不会执行；请等这一轮结束后再试。</p>

<div class="danger"><h2>放下当前会话</h2>
<p>选择下一段会话使用的模型和档位，再放下当前原生 session。<strong>不要求先归档。</strong></p>
<form method="post" action="${BASE_PATH}/fresh">
<input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}">
<label for="fresh-model">下一段模型</label>
<select id="fresh-model" name="model" required>${optionsFor(models, model, modelLabel)}</select>
<label for="fresh-effort">下一段思考档位</label>
<select id="fresh-effort" name="effort" required>${optionsFor(efforts, effort, (value) => `${EFFORT_LABELS[value] || value}（${value}）`)}</select>
<label class="confirm"><input type="checkbox" name="confirm" value="yes" required><span>我确认要放下当前会话，并用上面的配置开始下一段。</span></label>
<button class="danger-button" type="submit">确认放下当前会话</button>
</form></div>
<p class="muted">不会删除 CLAUDE.md、OB、工具或旧聊天。准备完成后，下一条真实消息可以直接从已配对的 Telegram 或 Kelivo 发出；异常续接失败时仍只允许 Kelivo 携带完整历史恢复。</p>
<p class="muted"><a href="/admin/window">查看“窗口进度”</a> · <a href="/admin/wake">前往“心跳开关”</a> · <a href="/admin/wake-history">查看“心跳记录”</a></p>`);
}

export function registerSessionAdmin(app, {
  shimKey,
  urlencoded,
  getStatus = () => ({}),
  startFreshSession,
  setEffort,
  log = (...args) => console.log(...args),
} = {}) {
  if (!shimKey) return { enabled: false, reason: "missing-shim-key" };
  if (typeof urlencoded !== "function") throw new Error("urlencoded middleware is required");
  if (typeof startFreshSession !== "function") throw new Error("startFreshSession is required");
  if (typeof setEffort !== "function") throw new Error("setEffort is required");

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
    const effortSaved = req.query?.effort === "1";
    const status = getStatus();
    const successMessage = success
      ? `下一段 ${modelLabel(status.model)} · ${EFFORT_LABELS[status.effort] || status.effort} 已准备好。下一条真实消息可以从 Telegram 或 Kelivo 发出。`
      : effortSaved ? "思考档位已经保存；下一条消息会继续当前会话。" : "";
    res.type("html").send(adminPage(
      session,
      status,
      successMessage,
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
    if (req.body?.confirm !== "yes") {
      return res.status(400).type("html").send(adminPage(session, getStatus(), "请先勾选确认，再放下当前会话。", true));
    }
    const result = startFreshSession({ model: req.body?.model, effort: req.body?.effort }) || {};
    if (!result.ok) {
      return res.status(result.status || 409).type("html").send(adminPage(session, getStatus(), result.error || "现在不能切换，请稍后再试。", true));
    }
    session.csrf = randomBytes(32).toString("base64url");
    log("[session-admin] manual fresh session requested");
    res.redirect(303, `${BASE_PATH}?fresh=1`);
  });

  app.post(`${BASE_PATH}/effort`, (req, res) => {
    const session = sessionFor(req);
    if (!session) return res.status(401).type("html").send(loginPage("登录已过期，请重新进入。"));
    if (!safeEqual(req.body?.csrf, session.csrf)) {
      return res.status(403).type("html").send(adminPage(session, getStatus(), "页面校验已失效，请刷新后重试。", true));
    }
    const result = setEffort(req.body?.effort) || {};
    if (!result.ok) {
      return res.status(result.status || 409).type("html").send(adminPage(session, getStatus(), result.error || "现在不能调整档位，请稍后再试。", true));
    }
    session.csrf = randomBytes(32).toString("base64url");
    log("[session-admin] effort changed", result.effort || req.body?.effort);
    res.redirect(303, `${BASE_PATH}?effort=1`);
  });

  log("[session-admin] mobile session-and-model page enabled");
  return { enabled: true, path: BASE_PATH };
}
