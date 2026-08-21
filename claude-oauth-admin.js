import fs from "fs";
import path from "path";
import { randomBytes, timingSafeEqual } from "crypto";
import { spawn as spawnProcess } from "child_process";

const BASE_PATH = "/admin/claude-oauth";
const SESSION_TTL_MS = 30 * 60 * 1000;
const SETUP_TTL_MS = 20 * 60 * 1000;
const EXCHANGE_TTL_MS = 90 * 1000;
const TOKEN_RE = /\bsk-ant-oat01-[A-Za-z0-9_-]{40,}\b/;
const URL_RE = /https:\/\/(?:claude\.ai\/oauth\/authorize|platform\.claude\.com\/oauth\/authorize|claude\.com\/cai\/oauth\/authorize)\?[^\s<>"']+/;
const OFFICIAL_AUTH_ENDPOINTS = new Set([
  "claude.ai/oauth/authorize",
  "platform.claude.com/oauth/authorize",
  "claude.com/cai/oauth/authorize",
]);

function stripAnsi(value) {
  return String(value || "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

export function extractClaudeOauthUrl(value) {
  const match = stripAnsi(value).match(URL_RE);
  if (!match) return null;
  try {
    const url = new URL(match[0]);
    return url.protocol === "https:" &&
      OFFICIAL_AUTH_ENDPOINTS.has(`${url.hostname}${url.pathname}`) ? url.toString() : null;
  } catch {
    return null;
  }
}

export function extractClaudeSetupToken(value) {
  return stripAnsi(value).match(TOKEN_RE)?.[0] || null;
}

export function formatClaudeAuthorizationInput(code, mode) {
  // Terminal UIs receive Enter as carriage return. Plain pipe/readline mode
  // expects a newline instead.
  return `${code}${mode === "pty" ? "\r" : "\n"}`;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
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

function page(title, body, script = "", nonce = "") {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${escapeHtml(title)}</title><style>
:root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
body{margin:0;background:#f4f2ed;color:#1d1d1f}main{max-width:680px;margin:0 auto;padding:32px 20px 64px}
.card{background:#fff;border-radius:22px;padding:24px;box-shadow:0 8px 32px #00000012}
h1{font-size:28px;margin:0 0 12px}p{line-height:1.65}.muted{color:#6e6e73;font-size:14px}
label{display:block;font-weight:650;margin:20px 0 8px}input{box-sizing:border-box;width:100%;font-size:16px;padding:14px;border:1px solid #c7c7cc;border-radius:12px;background:#fff;color:#111}
button,.button{display:block;box-sizing:border-box;width:100%;margin-top:14px;padding:14px;border:0;border-radius:12px;background:#111;color:#fff;font-size:17px;font-weight:650;text-align:center;text-decoration:none}
button:disabled{opacity:.45}.secondary{background:#ececf0;color:#111}.ok{color:#16723c}.err{color:#b42318;white-space:pre-wrap}.hide{display:none}
@media(prefers-color-scheme:dark){body{background:#161616;color:#f5f5f7}.card{background:#242424}.muted{color:#aaa}input{background:#111;color:#fff;border-color:#555}.secondary{background:#3a3a3c;color:#fff}}
</style></head><body><main><div class="card">${body}</div></main>${script ? `<script nonce="${nonce}">${script}</script>` : ""}</body></html>`;
}

function loginPage(message = "") {
  return page("Claude 新账号授权", `<h1>Claude 新账号授权</h1>
<p>这是 Kelivo 的一次性迁移入口。请输入 Kelivo 当前使用的 <code>SHIM_KEY</code>。</p>
${message ? `<p class="err">${escapeHtml(message)}</p>` : ""}
<form method="post" action="${BASE_PATH}/login" autocomplete="off">
<label for="key">SHIM_KEY</label><input id="key" name="key" type="password" required autocomplete="off">
<button type="submit">进入授权页</button></form>
<p class="muted">密钥只提交到你自己的 Zeabur 服务，不会写入 GitHub 或页面日志。</p>`);
}

function adminPage(csrf) {
  const nonce = randomBytes(18).toString("base64url");
  const safeCsrf = JSON.stringify(csrf);
  const script = `
const csrf=${safeCsrf};
const statusEl=document.getElementById("status"),startBtn=document.getElementById("start"),authBox=document.getElementById("auth-box"),authLink=document.getElementById("auth-link"),codeBox=document.getElementById("code-box"),activateBtn=document.getElementById("activate");
async function post(path,body={}){const r=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json","X-CSRF-Token":csrf},body:JSON.stringify(body)});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||"请求失败");return j}
async function refresh(){try{const r=await fetch("${BASE_PATH}/status",{cache:"no-store"});if(r.status===401){location.reload();return}const s=await r.json();statusEl.textContent=s.message||s.status;statusEl.className=s.status==="error"?"err":s.status==="stored"?"ok":"";startBtn.disabled=s.status!=="idle"&&s.status!=="error";authBox.classList.toggle("hide",!s.authUrl);codeBox.classList.toggle("hide",!(s.status==="waiting_code"||s.status==="exchanging"));activateBtn.classList.toggle("hide",s.status!=="stored");if(s.authUrl)authLink.href=s.authUrl}catch(e){statusEl.textContent=e.message;statusEl.className="err"}}
startBtn.onclick=async()=>{startBtn.disabled=true;try{await post("${BASE_PATH}/start")}catch(e){statusEl.textContent=e.message;statusEl.className="err"}refresh()};
document.getElementById("send-code").onclick=async()=>{const input=document.getElementById("code"),code=input.value.trim();if(!code)return;input.value="";try{await post("${BASE_PATH}/code",{code})}catch(e){statusEl.textContent=e.message;statusEl.className="err"}refresh()};
activateBtn.onclick=async()=>{activateBtn.disabled=true;try{await post("${BASE_PATH}/activate");statusEl.textContent="正在重启并切换到新账号…"}catch(e){statusEl.textContent=e.message;statusEl.className="err"}};
refresh();setInterval(refresh,1500);`;
  return {
    nonce,
    html: page("Claude 新账号授权", `<h1>Claude 新账号授权</h1>
<p id="status">正在读取状态…</p>
<button id="start" type="button">1. 生成官方授权链接</button>
<div id="auth-box" class="hide"><a id="auth-link" class="button" target="_blank" rel="noopener noreferrer">2. 打开 Claude 官方授权页</a><p class="muted">请确认登录的是新的 Claude 账号。授权后复制官方页面给出的代码，再回到这里。</p></div>
<div id="code-box" class="hide"><label for="code">官方授权码</label><input id="code" type="password" autocomplete="off" maxlength="4096"><button id="send-code" type="button">3. 安全保存授权码</button></div>
<button id="activate" class="hide" type="button">4. 重启并启用新账号</button>
<p class="muted">令牌只保存在 <code>/persona</code> 私有卷；成功重启后，本授权入口会自动关闭。</p>`, script, nonce),
  };
}

export function registerClaudeOauthAdmin(app, {
  shimKey,
  claudeBin = process.env.CLAUDE_BIN || "claude",
  tokenFile = process.env.CLAUDE_OAUTH_TOKEN_FILE || "/persona/claude-code-oauth-token",
  urlencoded,
  spawn = spawnProcess,
  log = (...args) => console.log(...args),
  restart = () => process.kill(process.pid, "SIGTERM"),
} = {}) {
  if (!shimKey) return { enabled: false, reason: "missing-shim-key" };
  if (fs.existsSync(tokenFile)) return { enabled: false, reason: "token-already-stored" };
  if (typeof urlencoded !== "function") throw new Error("urlencoded middleware is required");

  const sessions = new Map();
  const state = {
    status: "idle", authUrl: null, child: null, output: "", startedAt: 0,
    error: null, startupTimer: null, exchangeTimer: null, mode: null, receivedBytes: 0,
  };
  let failedLogins = [];

  function cleanSessions() {
    const now = Date.now();
    for (const [id, session] of sessions) if (session.expiresAt <= now) sessions.delete(id);
    failedLogins = failedLogins.filter((at) => now - at < 10 * 60 * 1000);
    if (state.child && now - state.startedAt > SETUP_TTL_MS) {
      if (state.startupTimer) clearTimeout(state.startupTimer);
      if (state.exchangeTimer) clearTimeout(state.exchangeTimer);
      try { state.child.kill("SIGTERM"); } catch {}
      state.child = null;
      state.startupTimer = null;
      state.exchangeTimer = null;
      state.status = "error";
      state.error = "授权流程已超时，请重新开始。";
    }
  }

  function sessionFor(req) {
    cleanSessions();
    const id = cookiesOf(req).kelivo_oauth_admin;
    const session = id && sessions.get(id);
    if (!session) return null;
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    return session;
  }

  function requireSession(req, res, next) {
    const session = sessionFor(req);
    if (!session) return res.status(401).json({ error: "登录已过期，请刷新页面重新进入。" });
    req.oauthAdminSession = session;
    next();
  }

  function requireCsrf(req, res, next) {
    if (!safeEqual(req.get("x-csrf-token"), req.oauthAdminSession.csrf)) {
      return res.status(403).json({ error: "页面校验已失效，请刷新后重试。" });
    }
    next();
  }

  function resetState() {
    if (state.startupTimer) clearTimeout(state.startupTimer);
    if (state.exchangeTimer) clearTimeout(state.exchangeTimer);
    if (state.child) try { state.child.kill("SIGTERM"); } catch {}
    Object.assign(state, {
      status: "idle", authUrl: null, child: null, output: "", startedAt: 0,
      error: null, startupTimer: null, exchangeTimer: null, mode: null, receivedBytes: 0,
    });
  }

  function absorb(chunk) {
    state.receivedBytes += Buffer.byteLength(String(chunk || ""));
    state.output = (state.output + stripAnsi(chunk)).slice(-96 * 1024);
    if (!state.authUrl) {
      state.authUrl = extractClaudeOauthUrl(state.output);
      if (state.authUrl) {
        if (state.startupTimer) clearTimeout(state.startupTimer);
        state.startupTimer = null;
        state.status = "waiting_code";
      }
    }
    const token = extractClaudeSetupToken(state.output);
    if (token && state.status !== "stored") {
      fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
      fs.writeFileSync(tokenFile, token + "\n", { encoding: "utf8", mode: 0o600 });
      fs.chmodSync(tokenFile, 0o600);
      if (state.startupTimer) clearTimeout(state.startupTimer);
      if (state.exchangeTimer) clearTimeout(state.exchangeTimer);
      state.startupTimer = null;
      state.exchangeTimer = null;
      state.output = "";
      state.status = "stored";
      state.error = null;
      log("[oauth-admin] direct Claude OAuth token stored in private volume");
    }
  }

  function launchSetup(usePty) {
    const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", TERM: "xterm-256color" };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_BASE_URL;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;

    const ptyHelper = "/usr/bin/script";
    usePty = usePty && fs.existsSync(ptyHelper);
    const program = usePty ? ptyHelper : claudeBin;
    const args = usePty
      ? ["-qefc", `stty cols 5000 rows 40 -echo; exec ${shellQuote(claudeBin)} setup-token`, "/dev/null"]
      : ["setup-token"];
    const child = spawn(program, args, { cwd: process.cwd(), env, stdio: ["pipe", "pipe", "pipe"] });
    state.child = child;
    state.mode = usePty ? "pty" : "pipe";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", absorb);
    child.stderr?.on("data", absorb);
    child.on("error", (error) => {
      if (state.child !== child || state.status === "stored") return;
      if (state.startupTimer) clearTimeout(state.startupTimer);
      if (state.exchangeTimer) clearTimeout(state.exchangeTimer);
      state.startupTimer = null;
      state.exchangeTimer = null;
      state.child = null;
      state.status = "error";
      state.error = `无法启动 Claude 授权流程：${error.message}`;
    });
    child.on("exit", (code) => {
      if (state.child !== child) return;
      if (state.startupTimer) clearTimeout(state.startupTimer);
      if (state.exchangeTimer) clearTimeout(state.exchangeTimer);
      state.startupTimer = null;
      state.exchangeTimer = null;
      state.child = null;
      if (state.status === "stored") return;
      state.status = "error";
      state.error = code === 0 ? "授权已结束，但没有取得令牌，请重新开始。" : "Claude 授权流程中断，请重新开始。";
      state.output = "";
    });

    // Some Claude Code builds render only on a TTY, while others behave better
    // on plain pipes. Try the safer TTY first, then automatically fall back
    // once if it produces no usable authorization link.
    state.startupTimer = setTimeout(() => {
      if (state.child !== child || state.authUrl || state.status !== "starting") return;
      state.startupTimer = null;
      state.child = null;
      try { child.kill("SIGTERM"); } catch {}
      state.output = "";
      state.receivedBytes = 0;
      if (usePty) {
        log("[oauth-admin] setup link not visible on pty; retrying with pipes");
        launchSetup(false);
      } else {
        state.status = "error";
        state.error = "Claude 授权命令没有返回链接，请让维护者查看服务日志。";
      }
    }, usePty ? 10_000 : 15_000);
    state.startupTimer.unref?.();
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
      "Cross-Origin-Resource-Policy": "same-origin",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    });
    next();
  });

  app.get(BASE_PATH, (req, res) => {
    const session = sessionFor(req);
    if (!session) return res.type("html").send(loginPage());
    const view = adminPage(session.csrf);
    res.set("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${view.nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`);
    res.type("html").send(view.html);
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
    res.setHeader("Set-Cookie", `kelivo_oauth_admin=${encodeURIComponent(id)}; Path=${BASE_PATH}; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`);
    res.redirect(303, BASE_PATH);
  });

  app.get(`${BASE_PATH}/status`, requireSession, (_req, res) => {
    cleanSessions();
    const messages = {
      idle: "尚未开始。",
      starting: "正在启动 Claude 官方授权流程…",
      waiting_code: "官方授权链接已生成。",
      exchanging: "正在验证并保存授权…",
      stored: "授权已安全保存，可以重启启用新账号。",
      error: state.error || "授权失败，请重新开始。",
    };
    res.json({ status: state.status, authUrl: state.authUrl, message: messages[state.status] });
  });

  app.post(`${BASE_PATH}/start`, requireSession, requireCsrf, (_req, res) => {
    cleanSessions();
    if (state.child) return res.status(409).json({ error: "授权流程已经在运行。" });
    resetState();
    state.status = "starting";
    state.startedAt = Date.now();
    launchSetup(true);
    res.status(202).json({ ok: true });
  });

  app.post(`${BASE_PATH}/code`, requireSession, requireCsrf, (req, res) => {
    const code = String(req.body?.code || "").trim();
    if (!state.child || state.status !== "waiting_code") return res.status(409).json({ error: "请先生成并打开官方授权链接。" });
    if (code.length < 8 || code.length > 4096 || /[\r\n]/.test(code)) return res.status(400).json({ error: "授权码格式不正确。" });
    state.status = "exchanging";
    try { state.child.stdin.write(formatClaudeAuthorizationInput(code, state.mode)); }
    catch {
      state.status = "error";
      state.error = "授权流程已断开，请重新开始。";
      return res.status(500).json({ error: state.error });
    }
    if (state.exchangeTimer) clearTimeout(state.exchangeTimer);
    state.exchangeTimer = setTimeout(() => {
      state.exchangeTimer = null;
      if (state.status !== "exchanging") return;
      if (state.child) try { state.child.kill("SIGTERM"); } catch {}
      state.child = null;
      state.status = "error";
      state.error = "Claude 没有在限定时间内完成授权验证，请重新生成链接。";
      state.output = "";
    }, EXCHANGE_TTL_MS);
    state.exchangeTimer.unref?.();
    res.status(202).json({ ok: true });
  });

  app.post(`${BASE_PATH}/activate`, requireSession, requireCsrf, (_req, res) => {
    if (state.status !== "stored" || !fs.existsSync(tokenFile)) return res.status(409).json({ error: "授权尚未保存完成。" });
    res.json({ ok: true });
    setTimeout(restart, 500).unref?.();
  });

  log("[oauth-admin] temporary mobile authorization page enabled");
  return { enabled: true, path: BASE_PATH };
}
