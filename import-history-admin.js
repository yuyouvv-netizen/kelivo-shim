import { randomBytes, timingSafeEqual } from "crypto";

import { normalizeImportedMessages } from "./import-history.js";

const BASE_PATH = "/admin/import";
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
body{margin:0;background:#f4f2ed;color:#1d1d1f}main{max-width:720px;margin:0 auto;padding:32px 20px 64px}
.card{background:#fff;border-radius:22px;padding:24px;box-shadow:0 8px 32px #00000012}
h1{font-size:28px;margin:0 0 12px}p{line-height:1.65}.muted{color:#6e6e73;font-size:14px}
label{display:block;font-weight:650;margin:18px 0 8px}input,textarea{box-sizing:border-box;width:100%;font-size:16px;padding:14px;border:1px solid #c7c7cc;border-radius:12px;background:#fff;color:#111}
textarea{min-height:38vh;font:13px ui-monospace,SFMono-Regular,Menlo,monospace;line-height:1.5;resize:vertical}
button{display:block;box-sizing:border-box;width:100%;margin-top:14px;padding:14px;border:0;border-radius:12px;color:#fff;font-size:17px;font-weight:650}.prepare{background:#4169a1}.cancel{background:#b42318}.plain{background:#6e6e73}
.status{padding:12px 14px;border-radius:12px;background:#f0f0f3}.ok{color:#16723c}.err{color:#b42318}.current{font-weight:700}
a{color:#4169a1}
@media(prefers-color-scheme:dark){body{background:#161616;color:#f5f5f7}.card{background:#242424}.muted{color:#aaa}input,textarea{background:#111;color:#fff;border-color:#555}.status{background:#343438}a{color:#8fb8ff}}
</style></head><body><main><div class="card">${body}</div></main></body></html>`;
}

function loginPage(message = "") {
  return page("Claude → Kelivo 搬家门", `<h1>Claude → Kelivo 搬家门</h1>
<p>请输入 Kelivo 当前使用的 <code>SHIM_KEY</code>。</p>
${message ? `<p class="err">${escapeHtml(message)}</p>` : ""}
<form method="post" action="${BASE_PATH}/login" autocomplete="off">
<label for="key">SHIM_KEY</label><input id="key" name="key" type="password" required autocomplete="off">
<button class="prepare" type="submit">进入搬家门</button></form>
<p class="muted">密钥只提交到你自己的 Zeabur 服务，并保存在短时安全 Cookie 中；不会出现在网址、GitHub 或迁移状态里。</p>`);
}

function statusText(status) {
  const details = status || {};
  if (details.state === "pending") {
    return `待搬家：${details.messages || 0} 条消息，${details.chars || 0} 个字符`;
  }
  if (details.state === "consumed") {
    return `上一次搬家已接入：${details.messages || 0} 条消息`;
  }
  if (details.state === "cleared") return "上一次待搬家内容已取消";
  return "目前没有待搬家的对话";
}

function adminPage(session, status, {
  message = "",
  isError = false,
  maxMessages,
  maxChars,
} = {}) {
  const pending = status?.state === "pending";
  const form = pending ? "" : `<form method="post" action="${BASE_PATH}/prepare" autocomplete="off">
<input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}">
<label for="file">选择哥哥整理好的 JSON 文件（推荐）</label>
<input id="file" type="file" accept="application/json,.json,text/plain">
<p id="file-status" class="muted">也可以不用文件，直接粘贴到下面。</p>
<label for="payload">迁移 JSON</label>
<textarea id="payload" name="payload" required spellcheck="false" placeholder='{"source":"claude-share","messages":[{"role":"user","content":"…"},{"role":"assistant","content":"…"}]}'></textarea>
<button class="prepare" type="submit">确认封好对话，准备搬家</button>
</form>
<script src="${BASE_PATH}/file.js" defer></script>`;
  const cancel = pending ? `<form method="post" action="${BASE_PATH}/cancel">
<input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}">
<button class="cancel" type="submit">取消这次搬家，恢复原 Kelivo 会话</button></form>` : "";
  return page("Claude → Kelivo 搬家门", `<h1>Claude → Kelivo 搬家门</h1>
${message ? `<p class="status ${isError ? "err" : "ok"}">${escapeHtml(message)}</p>` : ""}
<p class="status">当前状态：<span class="current">${escapeHtml(statusText(status))}</span></p>
<p>这里把 Claude 官端正在进行的聊天封成一次性包裹。准备成功后，服务会安全重启；下一条<strong>来自空白 Kelivo 对话的真实消息</strong>会接在这段历史后面。</p>
${form}${cancel}
<p class="muted">上限：${escapeHtml(maxMessages)} 条消息、${escapeHtml(maxChars)} 个正文字符。超过安全恢复容量会直接拒绝，不会悄悄截掉前半段。待搬家期间，自主心跳和自动标题都不能抢走第一轮。</p>
<p class="muted"><a href="/admin/session">全新会话开关</a> · <a href="/admin/wake">自主心跳开关</a></p>`);
}

const FILE_SCRIPT = `(()=>{const file=document.getElementById('file'),payload=document.getElementById('payload'),note=document.getElementById('file-status');if(!file||!payload||!note)return;file.addEventListener('change',async()=>{const selected=file.files&&file.files[0];if(!selected)return;try{const text=await selected.text();JSON.parse(text);payload.value=text;note.textContent='已读取：'+selected.name+'（'+text.length+' 个字符）';}catch{payload.value='';note.textContent='这个文件不是有效的 JSON，请重新选择。';}});})();`;

function successPage(status) {
  return page("搬家包裹已准备", `<h1>搬家包裹已准备</h1>
<p class="status ok">已经封好 ${escapeHtml(status.messages)} 条消息。服务正在安全重启。</p>
<p>稍等服务恢复后，去 Kelivo <strong>新建一个空白聊天</strong>，直接发送你原本准备在官端继续说的下一句话。</p>
<p class="muted">不要在旧 Kelivo 窗口继续发送，也不用说“请阅读聊天记录”。官端分享链接可等迁移确认成功后再取消分享。</p>`);
}

export function registerImportHistoryAdmin(app, {
  shimKey,
  urlencoded,
  store,
  maxMessages = 4000,
  maxChars = 2_000_000,
  isBusy = () => false,
  requestRestart = () => {},
  log = (...args) => console.log(...args),
} = {}) {
  if (!shimKey) return { enabled: false, reason: "missing-shim-key" };
  if (typeof urlencoded !== "function") throw new Error("urlencoded middleware is required");
  if (!store || typeof store.prepare !== "function") throw new Error("import store is required");

  const sessions = new Map();
  let failedLogins = [];
  const bodyLimit = `${Math.max(1_000_000, maxChars * 12 + 250_000)}b`;

  function cleanSessions() {
    const now = Date.now();
    for (const [id, session] of sessions) if (session.expiresAt <= now) sessions.delete(id);
    failedLogins = failedLogins.filter((at) => now - at < 10 * 60 * 1000);
  }

  function sessionFor(req) {
    cleanSessions();
    const id = cookiesOf(req).kelivo_import_admin;
    const session = id && sessions.get(id);
    if (!session) return null;
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    return session;
  }

  app.use(BASE_PATH, urlencoded({ extended: false, limit: bodyLimit, parameterLimit: 10 }));
  app.use(BASE_PATH, (_req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "Pragma": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    });
    next();
  });

  app.get(`${BASE_PATH}/file.js`, (req, res) => {
    if (!sessionFor(req)) return res.status(401).end();
    res.type("application/javascript").send(FILE_SCRIPT);
  });

  app.get(BASE_PATH, (req, res) => {
    const session = sessionFor(req);
    if (!session) return res.type("html").send(loginPage());
    const cleared = req.query?.cleared === "1";
    res.type("html").send(adminPage(session, store.status(), {
      message: cleared ? "待搬家内容已取消；如果原来有 Kelivo 会话，它的指针已经恢复。" : "",
      maxMessages,
      maxChars,
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
    res.setHeader("Set-Cookie", `kelivo_import_admin=${encodeURIComponent(id)}; Path=${BASE_PATH}; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`);
    res.redirect(303, BASE_PATH);
  });

  app.post(`${BASE_PATH}/prepare`, (req, res) => {
    const session = sessionFor(req);
    if (!session) return res.status(401).type("html").send(loginPage("登录已过期，请重新进入。"));
    if (!safeEqual(req.body?.csrf, session.csrf)) {
      return res.status(403).type("html").send(adminPage(session, store.status(), {
        message: "页面校验已失效，请刷新后重试。", isError: true, maxMessages, maxChars,
      }));
    }
    if (isBusy()) {
      return res.status(409).type("html").send(adminPage(session, store.status(), {
        message: "小克正在回复或队列里还有消息，请等这一轮结束后再准备搬家。", isError: true, maxMessages, maxChars,
      }));
    }
    try {
      const payload = JSON.parse(String(req.body?.payload || ""));
      const messages = normalizeImportedMessages(payload);
      const chars = messages.reduce((sum, message) => sum + message.content.length, 0);
      if (messages.length > maxMessages) throw new Error(`消息太多（${messages.length} 条，上限 ${maxMessages} 条）`);
      if (chars > maxChars) throw new Error(`对话太长（${chars} 字符，安全上限 ${maxChars} 字符）`);
      const status = store.prepare({ messages, source: payload?.source || "claude-share" });
      session.csrf = randomBytes(32).toString("base64url");
      log("[import-admin] prepared", { messages: status.messages, chars: status.chars });
      res.type("html").send(successPage(status));
      res.once("finish", () => {
        const timer = setTimeout(() => requestRestart(), 100);
        timer.unref?.();
      });
    } catch (error) {
      const conflict = error?.code === "IMPORT_ALREADY_PENDING";
      res.status(conflict ? 409 : 400).type("html").send(adminPage(session, store.status(), {
        message: conflict ? "已经有一份对话在门口等着了；请先使用或取消它。" : `没有准备成功：${error.message}`,
        isError: true,
        maxMessages,
        maxChars,
      }));
    }
  });

  app.post(`${BASE_PATH}/cancel`, (req, res) => {
    const session = sessionFor(req);
    if (!session) return res.status(401).type("html").send(loginPage("登录已过期，请重新进入。"));
    if (!safeEqual(req.body?.csrf, session.csrf)) {
      return res.status(403).type("html").send(adminPage(session, store.status(), {
        message: "页面校验已失效，请刷新后重试。", isError: true, maxMessages, maxChars,
      }));
    }
    store.clear();
    session.csrf = randomBytes(32).toString("base64url");
    log("[import-admin] pending import cancelled");
    res.redirect(303, `${BASE_PATH}?cleared=1`);
  });

  log("[import-admin] mobile chat-import page enabled");
  return { enabled: true, path: BASE_PATH };
}
