import { randomBytes, timingSafeEqual } from "node:crypto";

const BASE_PATH = "/admin/wake-history";
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

function singaporeTime(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat("zh-SG", {
    timeZone: "Asia/Singapore",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}

function shortToolName(value) {
  const parts = String(value || "").split("__");
  return parts[0] === "mcp" && parts.length >= 3 ? parts.slice(2).join("__") : String(value || "");
}

function statusLabel(status) {
  return ({
    running: "正在执行",
    silent: "保持沉默",
    spoke: "主动开口",
    completed: "已完成",
    interrupted: "已中止",
    timeout: "超时结束",
    "process-exit": "进程中断",
    "service-restarted": "服务重启时中断",
    "upstream-error": "上游错误",
    "empty-result": "上游空回",
  })[status] || "已结束";
}

function statusTone(status) {
  if (status === "running") return "live";
  if (status === "silent" || status === "spoke" || status === "completed") return "ok";
  return "warn";
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
.card{background:#fff;border-radius:22px;padding:24px;box-shadow:0 8px 32px #00000012}h1{font-size:28px;margin:0 0 12px}p{line-height:1.65}.muted{color:#6e6e73;font-size:14px}
label{display:block;font-weight:650;margin:20px 0 8px}input{box-sizing:border-box;width:100%;font-size:16px;padding:14px;border:1px solid #c7c7cc;border-radius:12px;background:#fff;color:#111}
button,.refresh{display:block;box-sizing:border-box;width:100%;margin-top:16px;padding:14px;border:0;border-radius:12px;background:#4169a1;color:#fff;font-size:17px;font-weight:650;text-align:center;text-decoration:none}
.run{margin-top:14px;padding:16px;border-radius:16px;background:#f5f5f7}.run-head{display:flex;justify-content:space-between;gap:12px;align-items:baseline}.time{font-weight:700}.state{font-size:14px;font-weight:700}.state.live{color:#4169a1}.state.ok{color:#16723c}.state.warn{color:#b42318}
.tools{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.tool{display:inline-block;padding:7px 10px;border-radius:999px;background:#e8edf5;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}.empty{color:#6e6e73;font-size:14px}.links{text-align:center;margin-top:20px}.links a{color:#4169a1;margin:0 8px}
@media(prefers-color-scheme:dark){body{background:#161616;color:#f5f5f7}.card{background:#242424}.muted,.empty{color:#aaa}input{background:#111;color:#fff;border-color:#555}.run{background:#343438}.tool{background:#27364a}.links a{color:#8fb8ff}}
</style></head><body><main><div class="card">${body}</div></main></body></html>`;
}

function loginPage(message = "") {
  return page("自主心跳记录", `<h1>自主心跳记录</h1>
<p>请输入 Kelivo 当前使用的 <code>SHIM_KEY</code>。</p>
${message ? `<p class="state warn">${escapeHtml(message)}</p>` : ""}
<form method="post" action="${BASE_PATH}/login" autocomplete="off">
<label for="key">SHIM_KEY</label><input id="key" name="key" type="password" required autocomplete="off">
<button type="submit">查看最近心跳</button></form>
<p class="muted">密钥只提交到你自己的 Zeabur 服务，不会写入 GitHub 或页面日志。</p>`);
}

function runCard(run) {
  const tools = Array.isArray(run?.tools) ? run.tools : [];
  const toolHtml = tools.length
    ? `<div class="tools">${tools.map((name) => `<span class="tool">${escapeHtml(shortToolName(name))}</span>`).join("")}</div>`
    : `<p class="empty">这一轮没有调用工具。</p>`;
  return `<section class="run"><div class="run-head"><span class="time">${escapeHtml(singaporeTime(run?.startedAt))}</span><span class="state ${statusTone(run?.status)}">${escapeHtml(statusLabel(run?.status))}</span></div>${toolHtml}</section>`;
}

export function wakeHistoryPage(runs = []) {
  const records = Array.isArray(runs) ? runs.slice(0, 3) : [];
  const body = records.length
    ? records.map(runCard).join("")
    : `<p class="run empty">还没有心跳记录。下一次自然心跳开始后，这里就会出现。</p>`;
  return page("自主心跳记录", `<h1>自主心跳记录</h1>
<p class="muted">只显示最近 3 轮实际心跳及其工具名称，不保存参数、结果、聊天正文或思考过程。</p>
${body}
<a class="refresh" href="${BASE_PATH}">立即刷新</a>
<p class="muted">页面每 15 秒自动刷新。查看记录不会给小克发送消息、触发心跳或占用上下文。</p>
<p class="links"><a href="/admin/wake">心跳开关</a><a href="/admin/window">窗口进度</a><a href="/admin/session">全新会话</a></p>`, 15);
}

export function registerWakeHistoryAdmin(app, {
  shimKey,
  urlencoded,
  getRuns = () => [],
  log = (...args) => console.log(...args),
} = {}) {
  if (!shimKey) return { enabled: false, reason: "missing-shim-key" };
  if (typeof urlencoded !== "function") throw new Error("urlencoded middleware is required");
  if (typeof getRuns !== "function") throw new Error("getRuns must be a function");

  const sessions = new Map();
  let failedLogins = [];

  function cleanSessions() {
    const now = Date.now();
    for (const [id, session] of sessions) if (session.expiresAt <= now) sessions.delete(id);
    failedLogins = failedLogins.filter((at) => now - at < 10 * 60 * 1000);
  }

  function sessionFor(req) {
    cleanSessions();
    const id = cookiesOf(req).kelivo_wake_history_admin;
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
    res.type("html").send(wakeHistoryPage(getRuns()));
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
    res.setHeader("Set-Cookie", `kelivo_wake_history_admin=${encodeURIComponent(id)}; Path=${BASE_PATH}; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`);
    res.redirect(303, BASE_PATH);
  });

  log("[wake-history-admin] mobile wake history page enabled");
  return { enabled: true, path: BASE_PATH };
}
