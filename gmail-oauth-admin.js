import fs from "fs";
import path from "path";
import { randomBytes, timingSafeEqual } from "crypto";

export const GMAIL_OAUTH_BASE_PATH = "/admin/gmail-oauth";
export const GMAIL_REDIRECT_URI = "http://localhost:3000/oauth2callback";
export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.settings.basic",
];

const SESSION_TTL_MS = 30 * 60 * 1000;
const FLOW_TTL_MS = 15 * 60 * 1000;
const GMAIL_MIGRATION_VERSION = 2;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookiesOf(req) {
  const result = {};
  for (const part of String(req.get?.("cookie") || "").split(";")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    try { result[part.slice(0, at).trim()] = decodeURIComponent(part.slice(at + 1).trim()); } catch {}
  }
  return result;
}

function page(title, body, script = "", nonce = "") {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
body{font:17px system-ui,-apple-system,sans-serif;max-width:720px;margin:0 auto;padding:24px 18px;line-height:1.55;background:#f5f3ee;color:#171717}main{background:#fff;border-radius:24px;padding:24px;box-shadow:0 2px 18px #0000000b}h1{font-size:30px;margin:0 0 18px}button,.button{display:block;width:100%;box-sizing:border-box;border:0;border-radius:14px;background:#111;color:#fff;padding:15px 16px;margin:14px 0;font:600 17px system-ui;text-align:center;text-decoration:none}button:disabled{opacity:.45}input{display:block;width:100%;box-sizing:border-box;border:1px solid #bbb;border-radius:12px;padding:13px;font:16px ui-monospace,monospace;margin:8px 0 12px}.hide{display:none}.muted{color:#666}.ok{color:#087b35}.err{color:#b42318;white-space:pre-wrap}</style></head><body><main>${body}</main>${script ? `<script nonce="${nonce}">${script}</script>` : ""}</body></html>`;
}

export function readGoogleOauthClient(file) {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const client = parsed.installed || parsed.web;
  if (!client?.client_id || !client?.client_secret) throw new Error("Google OAuth 客户端文件格式不正确。请保留原来的 gcp-oauth.keys.json。");
  return { clientId: String(client.client_id), clientSecret: String(client.client_secret) };
}

export function buildGoogleAuthUrl({ clientId, state, redirectUri = GMAIL_REDIRECT_URI } = {}) {
  if (!clientId || !state) throw new Error("missing OAuth client or state");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent select_account",
    include_granted_scopes: "true",
    state,
  }).toString();
  return url.toString();
}

export function parseGoogleCallback(value, expectedState, redirectUri = GMAIL_REDIRECT_URI) {
  let url;
  try { url = new URL(String(value || "").trim()); } catch { throw new Error("请粘贴 Google 跳转后地址栏里的完整网址。"); }
  const expected = new URL(redirectUri);
  if (url.protocol !== expected.protocol || url.hostname !== expected.hostname || url.port !== expected.port || url.pathname !== expected.pathname) {
    throw new Error("这不是本次 Google 授权返回的网址。");
  }
  if (!safeEqual(url.searchParams.get("state"), expectedState)) throw new Error("授权页面校验已失效，请重新生成链接。");
  const oauthError = url.searchParams.get("error");
  if (oauthError) throw new Error(`Google 没有授权邮箱访问（${oauthError}）。`);
  const code = url.searchParams.get("code");
  if (!code || code.length < 8 || code.length > 4096) throw new Error("Google 返回的网址里没有有效授权码。");
  return code;
}

export function credentialsFromTokenResponse(token, now = Date.now()) {
  if (!token?.access_token || !token?.refresh_token) throw new Error("Google 没有返回长期刷新令牌，请重新授权并选择允许。");
  const result = {
    access_token: String(token.access_token),
    refresh_token: String(token.refresh_token),
    scope: String(token.scope || GMAIL_SCOPES.join(" ")),
    token_type: String(token.token_type || "Bearer"),
    expiry_date: now + Math.max(1, Number(token.expires_in) || 3600) * 1000,
  };
  if (token.id_token) result.id_token = String(token.id_token);
  return result;
}

async function readJsonResponse(response, fallback) {
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new Error(fallback);
  return data;
}

async function exchangeAndVerify({ code, clientId, clientSecret, fetchImpl, redirectUri }) {
  const tokenResponse = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: clientId, client_secret: clientSecret,
      redirect_uri: redirectUri, grant_type: "authorization_code",
    }),
  });
  const token = await readJsonResponse(tokenResponse, "Google 没有接受这次授权码，请重新开始。");
  const credentials = credentialsFromTokenResponse(token);
  const profileResponse = await fetchImpl("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { Authorization: `Bearer ${credentials.access_token}` },
  });
  const profile = await readJsonResponse(profileResponse, "新邮箱授权已返回，但 Gmail API 验证失败；旧邮箱凭据没有改动。");
  if (!profile.emailAddress || !String(profile.emailAddress).includes("@")) throw new Error("无法确认新邮箱地址；旧邮箱凭据没有改动。");
  return { credentials, email: String(profile.emailAddress) };
}

export function resolveGoogleOauthKeysFile(configuredFile, homeDir = process.env.HOME || "/root") {
  const candidates = [
    configuredFile,
    "/persona/gmail-auth/gcp-oauth.keys.json",
    "/src/gmail-auth/gcp-oauth.keys.json",
    path.join(homeDir, ".gmail-mcp", "gcp-oauth.keys.json"),
  ];
  return [...new Set(candidates.filter(Boolean))].find((file) => fs.existsSync(file)) || configuredFile;
}

export function writeCredentialsSafely(credentialsFile, markerFile, credentials, now = new Date()) {
  fs.mkdirSync(path.dirname(credentialsFile), { recursive: true });
  fs.mkdirSync(path.dirname(markerFile), { recursive: true });
  const backup = path.join(path.dirname(credentialsFile), "credentials.previous.json");
  const suffix = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const credentialsTemp = `${credentialsFile}.tmp-${suffix}`;
  const markerTemp = `${markerFile}.tmp-${suffix}`;
  const backupTemp = `${backup}.tmp-${suffix}`;
  const hadOldCredentials = fs.existsSync(credentialsFile);
  const oldCredentialsWereFile = hadOldCredentials && fs.lstatSync(credentialsFile).isFile();
  const malformedBackup = hadOldCredentials && !oldCredentialsWereFile
    ? path.join(path.dirname(credentialsFile), `credentials.malformed-${now.toISOString().replace(/[:.]/g, "-")}-${suffix}`)
    : null;
  let replacedCredentials = false;
  let movedMalformedCredentials = false;

  try {
    fs.writeFileSync(credentialsTemp, JSON.stringify(credentials) + "\n", { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(credentialsTemp, 0o600);
    fs.writeFileSync(markerTemp, JSON.stringify({ completedAt: now.toISOString(), migrationVersion: GMAIL_MIGRATION_VERSION }) + "\n", { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(markerTemp, 0o600);

    if (malformedBackup) {
      // A bad restore can leave credentials.json as a directory. Preserve it
      // intact for diagnosis, but free the file path for verified credentials.
      fs.renameSync(credentialsFile, malformedBackup);
      movedMalformedCredentials = true;
    } else if (oldCredentialsWereFile) {
      fs.copyFileSync(credentialsFile, backupTemp);
      fs.chmodSync(backupTemp, 0o600);
      fs.renameSync(backupTemp, backup);
    }

    fs.renameSync(credentialsTemp, credentialsFile);
    replacedCredentials = true;
    fs.chmodSync(credentialsFile, 0o600);
    fs.renameSync(markerTemp, markerFile);
    fs.chmodSync(markerFile, 0o600);
  } catch (error) {
    if (replacedCredentials) {
      if (oldCredentialsWereFile && fs.existsSync(backup)) {
        const restoreTemp = `${credentialsFile}.restore-${suffix}`;
        fs.copyFileSync(backup, restoreTemp);
        fs.chmodSync(restoreTemp, 0o600);
        fs.renameSync(restoreTemp, credentialsFile);
      } else {
        try { fs.unlinkSync(credentialsFile); } catch {}
      }
    }
    if (movedMalformedCredentials && malformedBackup && !fs.existsSync(credentialsFile)) {
      try { fs.renameSync(malformedBackup, credentialsFile); } catch {}
    }
    try { fs.unlinkSync(markerFile); } catch {}
    throw error;
  } finally {
    for (const file of [credentialsTemp, markerTemp, backupTemp]) {
      try { fs.unlinkSync(file); } catch {}
    }
  }
}

function completedCurrentMigration(credentialsFile, markerFile) {
  if (!fs.existsSync(credentialsFile) || !fs.lstatSync(credentialsFile).isFile() || !fs.existsSync(markerFile)) return false;
  try {
    return JSON.parse(fs.readFileSync(markerFile, "utf8"))?.migrationVersion === GMAIL_MIGRATION_VERSION;
  } catch {
    return false;
  }
}

function loginPage(message = "") {
  return page("Gmail 换到新邮箱", `<h1>Gmail 换到新邮箱</h1><p>只替换 Gmail MCP 的邮箱授权，不会改动 Claude、花园、Ombre 或啵啵鸟。</p>${message ? `<p class="err">${escapeHtml(message)}</p>` : ""}<form method="post" action="${GMAIL_OAUTH_BASE_PATH}/login" autocomplete="off"><label for="key">SHIM_KEY</label><input id="key" name="key" type="password" required autocomplete="off"><button type="submit">进入换号页</button></form><p class="muted">密钥只提交给你自己的 Zeabur 服务。</p>`);
}

function adminPage(csrf) {
  const nonce = randomBytes(18).toString("base64url");
  const script = `
const csrf=${JSON.stringify(csrf)},base=${JSON.stringify(GMAIL_OAUTH_BASE_PATH)};
const statusEl=document.getElementById("status"),start=document.getElementById("start"),auth=document.getElementById("auth"),paste=document.getElementById("paste"),callback=document.getElementById("callback"),save=document.getElementById("save");
async function post(path,body={}){const r=await fetch(base+path,{method:"POST",headers:{"content-type":"application/json","x-csrf-token":csrf},body:JSON.stringify(body)});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||"请求失败");return j}
async function refresh(){try{const r=await fetch(base+"/status",{cache:"no-store"});if(r.status===401){location.reload();return}const s=await r.json();statusEl.textContent=s.message;statusEl.className=s.status==="error"?"err":s.status==="stored"?"ok":"";start.disabled=s.status==="starting"||s.status==="exchanging";auth.classList.toggle("hide",!s.authUrl);paste.classList.toggle("hide",s.status!=="waiting_callback");if(s.authUrl)auth.href=s.authUrl}catch{}}
start.onclick=async()=>{start.disabled=true;try{await post("/start")}catch(e){statusEl.textContent=e.message;statusEl.className="err"}refresh()};
save.onclick=async()=>{const value=callback.value.trim();if(!value)return;save.disabled=true;statusEl.textContent="正在验证新邮箱，旧邮箱凭据暂时保留…";try{const j=await post("/callback",{callbackUrl:value});callback.value="";statusEl.textContent=j.message;statusEl.className="ok";paste.classList.add("hide");start.disabled=true}catch(e){statusEl.textContent=e.message;statusEl.className="err";save.disabled=false}};
refresh();setInterval(refresh,1800);`;
  return { nonce, html: page("Gmail 换到新邮箱", `<h1>Gmail 换到新邮箱</h1><p id="status">正在读取状态…</p><button id="start" type="button">1. 生成 Google 授权链接</button><a id="auth" class="button hide" target="_blank" rel="noopener noreferrer">2. 打开 Google 授权页</a><div id="paste" class="hide"><p>在 Google 中选择<strong>新邮箱</strong>并允许访问。随后浏览器会跳到一个打不开的 <code>localhost</code> 页面——这是预期现象。</p><p>复制那个页面地址栏里的<strong>完整网址</strong>，回到这里粘贴；不要发到聊天里。</p><label for="callback">Google 返回网址</label><input id="callback" type="password" autocomplete="off" maxlength="8192"><button id="save" type="button">3. 验证并切换邮箱</button></div><p class="muted">新邮箱通过 Gmail API 验证后才会替换；旧凭据会保留一份私有备份。成功后服务自动重启，本入口自动关闭。</p>`, script, nonce) };
}

export function registerGmailOauthAdmin(app, {
  shimKey,
  oauthKeysFile = process.env.GMAIL_OAUTH_KEYS_FILE || "/persona/gmail-auth/gcp-oauth.keys.json",
  credentialsFile = process.env.GMAIL_CREDENTIALS_FILE || "/persona/gmail-auth/credentials.json",
  markerFile = process.env.GMAIL_OAUTH_MIGRATION_MARKER || "/persona/gmail-auth/.new-account-authorized",
  urlencoded,
  json,
  fetchImpl = globalThis.fetch,
  restart = () => process.kill(process.pid, "SIGTERM"),
  log = (...args) => console.log(...args),
} = {}) {
  if (!shimKey) {
    app.get(GMAIL_OAUTH_BASE_PATH, (_req, res) => res.status(503).type("html").send(page("Gmail 换号尚未开放", "<h1>Gmail 换号尚未开放</h1><p>当前服务没有读取到 SHIM_KEY。请只检查环境变量名称，不要把密钥发到聊天里。</p>")));
    return { enabled: false, reason: "missing-shim-key", path: GMAIL_OAUTH_BASE_PATH };
  }
  // Only this migration version can close the one-time page. Old/stale markers
  // and malformed credential paths remain recoverable behind SHIM_KEY.
  if (completedCurrentMigration(credentialsFile, markerFile)) {
    return { enabled: false, reason: "migration-complete" };
  }
  if (typeof urlencoded !== "function" || typeof json !== "function" || typeof fetchImpl !== "function") throw new Error("gmail OAuth admin dependencies missing");

  const sessions = new Map();
  const flow = { status: "idle", authUrl: null, state: null, startedAt: 0, error: null, email: null };
  let failedLogins = [];

  function clean() {
    const now = Date.now();
    for (const [id, session] of sessions) if (session.expiresAt <= now) sessions.delete(id);
    failedLogins = failedLogins.filter((at) => now - at < 10 * 60 * 1000);
    if (["waiting_callback", "exchanging"].includes(flow.status) && now - flow.startedAt > FLOW_TTL_MS) Object.assign(flow, { status: "error", authUrl: null, state: null, error: "Google 授权已超时，请重新生成链接。" });
  }

  function sessionFor(req) {
    clean();
    const id = cookiesOf(req).kelivo_gmail_admin;
    const session = id && sessions.get(id);
    if (!session) return null;
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    return session;
  }

  function requireSession(req, res, next) {
    const session = sessionFor(req);
    if (!session) return res.status(401).json({ error: "登录已过期，请刷新页面。" });
    req.gmailAdminSession = session;
    next();
  }

  function requireCsrf(req, res, next) {
    if (!safeEqual(req.get("x-csrf-token"), req.gmailAdminSession.csrf)) return res.status(403).json({ error: "页面校验已失效，请刷新后重试。" });
    next();
  }

  app.use(GMAIL_OAUTH_BASE_PATH, urlencoded({ extended: false, limit: "8kb" }));
  app.use(GMAIL_OAUTH_BASE_PATH, json({ limit: "12kb" }));
  app.use(GMAIL_OAUTH_BASE_PATH, (_req, res, next) => {
    res.set({ "Cache-Control": "no-store", "Pragma": "no-cache", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer", "Permissions-Policy": "camera=(), microphone=(), geolocation=()", "Cross-Origin-Resource-Policy": "same-origin", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" });
    next();
  });

  app.get(GMAIL_OAUTH_BASE_PATH, (req, res) => {
    const session = sessionFor(req);
    if (!session) return res.type("html").send(loginPage());
    const view = adminPage(session.csrf);
    res.set("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${view.nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`);
    res.type("html").send(view.html);
  });

  app.post(`${GMAIL_OAUTH_BASE_PATH}/login`, (req, res) => {
    clean();
    if (failedLogins.length >= 5) return res.status(429).type("html").send(loginPage("尝试次数过多，请十分钟后再试。"));
    if (!safeEqual(req.body?.key, shimKey)) {
      failedLogins.push(Date.now());
      return res.status(401).type("html").send(loginPage("SHIM_KEY 不正确。"));
    }
    failedLogins = [];
    const id = randomBytes(32).toString("base64url");
    sessions.set(id, { csrf: randomBytes(32).toString("base64url"), expiresAt: Date.now() + SESSION_TTL_MS });
    res.setHeader("Set-Cookie", `kelivo_gmail_admin=${encodeURIComponent(id)}; Path=${GMAIL_OAUTH_BASE_PATH}; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`);
    res.redirect(303, GMAIL_OAUTH_BASE_PATH);
  });

  app.get(`${GMAIL_OAUTH_BASE_PATH}/status`, requireSession, (_req, res) => {
    const messages = { idle: "尚未开始。", waiting_callback: "Google 授权链接已生成。", exchanging: "正在验证新邮箱…", stored: `新邮箱 ${flow.email || ""} 已验证，服务正在重启。`, error: flow.error || "换号失败。" };
    res.json({ status: flow.status, authUrl: flow.authUrl, message: messages[flow.status] || messages.idle });
  });

  app.post(`${GMAIL_OAUTH_BASE_PATH}/start`, requireSession, requireCsrf, (_req, res) => {
    try {
      const client = readGoogleOauthClient(resolveGoogleOauthKeysFile(oauthKeysFile));
      const state = randomBytes(32).toString("base64url");
      Object.assign(flow, { status: "waiting_callback", authUrl: buildGoogleAuthUrl({ clientId: client.clientId, state }), state, startedAt: Date.now(), error: null, email: null });
      res.status(202).json({ ok: true });
    } catch (error) {
      Object.assign(flow, { status: "error", authUrl: null, state: null, error: error.message });
      res.status(500).json({ error: "无法读取现有 Google OAuth 客户端。" });
    }
  });

  app.post(`${GMAIL_OAUTH_BASE_PATH}/callback`, requireSession, requireCsrf, async (req, res) => {
    if (flow.status !== "waiting_callback" || !flow.state) return res.status(409).json({ error: "请先生成 Google 授权链接。" });
    flow.status = "exchanging";
    try {
      const code = parseGoogleCallback(req.body?.callbackUrl, flow.state);
      const client = readGoogleOauthClient(resolveGoogleOauthKeysFile(oauthKeysFile));
      const result = await exchangeAndVerify({ code, clientId: client.clientId, clientSecret: client.clientSecret, fetchImpl, redirectUri: GMAIL_REDIRECT_URI });
      writeCredentialsSafely(credentialsFile, markerFile, result.credentials);
      Object.assign(flow, { status: "stored", authUrl: null, state: null, error: null, email: result.email });
      log("[gmail-oauth-admin] new Gmail credentials verified and stored in private volume");
      res.once("finish", () => { const timer = setTimeout(restart, 900); timer.unref?.(); });
      res.json({ ok: true, message: `新邮箱 ${result.email} 已验证并保存，服务正在自动重启。` });
    } catch (error) {
      Object.assign(flow, { status: "error", authUrl: null, state: null, error: error.message, email: null });
      res.status(400).json({ error: error.message });
    }
  });

  log("[gmail-oauth-admin] temporary mobile Gmail migration page enabled");
  return { enabled: true, path: GMAIL_OAUTH_BASE_PATH };
}
