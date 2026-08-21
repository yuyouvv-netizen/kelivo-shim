import express from "express";
import { contentToText } from "./history.js";
import { isKelivoTitleRequest } from "./title.js";
import { ImportHistoryStore, normalizeImportedMessages } from "./import-history.js";

const SHIM_KEY = process.env.SHIM_KEY || "";
const IMPORT_DIR = process.env.IMPORT_HISTORY_DIR || "/persona/import-history";
const SESSION_STATE_FILE = process.env.SESSION_STATE_FILE || "/persona/claude-state/shim-session.json";
const IMPORT_MAX_CHARS = Math.max(10_000, +(process.env.IMPORT_MAX_CHARS || 2_000_000));
const IMPORT_MAX_MESSAGES = Math.max(2, +(process.env.IMPORT_MAX_MESSAGES || 4000));
const store = new ImportHistoryStore({ dir: IMPORT_DIR, sessionStateFile: SESSION_STATE_FILE });
if (store.ensureFreshSession()) {
  console.log(new Date().toISOString(), "[import] pending move forced a fresh native session");
}

function authOk(req) {
  if (!SHIM_KEY) return false;
  const key = req.query?.key || req.get?.("x-api-key") ||
    String(req.get?.("authorization") || "").replace(/^Bearer\s+/i, "");
  return key === SHIM_KEY;
}

function importEligible(body) {
  const messages = Array.isArray(body?.messages)
    ? body.messages.filter((m) => m?.role === "user" || m?.role === "assistant") : [];
  // Only a fresh/near-empty Kelivo chat may consume a pending import. This keeps
  // an accidental message in an older chat from swallowing the one-time move.
  if (!messages.length || messages.length > 2) return false;
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const text = contentToText(lastUser?.content ?? "");
  return !!text && !isKelivoTitleRequest(text);
}

function injectPending(body) {
  const pending = store.loadPending();
  if (!pending || !importEligible(body)) return { body, imported: null };
  const current = Array.isArray(body?.messages) ? body.messages : [];
  const next = { ...(body || {}), messages: [...pending.messages, ...current] };
  const imported = store.consume();
  return { body: next, imported };
}

const originalPost = express.application.post;
express.application.post = function patchedPost(route, ...handlers) {
  if (route === "/v1/messages" || route === "/messages") {
    handlers = handlers.map((handler) => {
      if (typeof handler !== "function") return handler;
      return function importedMessagesHandler(req, res, next) {
        const { body, imported } = injectPending(req.body);
        req.body = body;
        if (imported) {
          res.setHeader("x-kelivo-imported-history", String(imported.messages.length));
          console.log(new Date().toISOString(), "[import] consumed by fresh Kelivo chat", {
            messages: imported.messages.length, chars: imported.chars,
          });
        }
        return handler(req, res, next);
      };
    });
  }
  return originalPost.call(this, route, ...handlers);
};

const originalGet = express.application.get;
express.application.get = function patchedGet(route, ...handlers) {
  if (route === "/debug") {
    handlers = handlers.map((handler) => {
      if (typeof handler !== "function") return handler;
      return function importDebugHandler(req, res, next) {
        const json = res.json.bind(res);
        res.json = (payload) => json({ ...(payload || {}), import: store.status() });
        return handler(req, res, next);
      };
    });
  }
  return originalGet.call(this, route, ...handlers);
};

function importPage() {
  return `<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claude → Kelivo 会话迁移</title><style>
body{font:16px system-ui;max-width:760px;margin:24px auto;padding:0 16px;line-height:1.6}textarea{width:100%;min-height:46vh;box-sizing:border-box;font:13px ui-monospace,monospace;padding:12px}button{font-size:16px;padding:10px 16px;margin:10px 8px 10px 0}.muted{opacity:.7}pre{white-space:pre-wrap;background:#f4f4f4;padding:12px;border-radius:8px}</style>
<h2>Claude 官端 → Kelivo 一次性迁移</h2>
<p>把整理好的 JSON 整段粘进下面。它只会被<strong>下一个新建/近乎空白的 Kelivo 对话</strong>消费一次。</p>
<textarea id="data" placeholder='{"messages":[{"role":"user","content":"…"},{"role":"assistant","content":"…"}]}'></textarea><br>
<button id="save">准备迁移</button><button id="status">查看状态</button><button id="clear">取消待迁移</button>
<p class="muted">准备成功后服务会自动重启一次。然后去 Kelivo 新建空白聊天，直接说官端原本的下一句话。</p><pre id="out"></pre>
<script>
const key=new URLSearchParams(location.search).get('key')||''; const out=document.getElementById('out');
async function call(method,path,body){const r=await fetch(path+'?key='+encodeURIComponent(key),{method,headers:{'content-type':'application/json'},body});const t=await r.text();try{return JSON.stringify(JSON.parse(t),null,2)}catch{return t}}
save.onclick=async()=>{try{JSON.parse(data.value)}catch{out.textContent='JSON 格式还没整理好，先别提交。';return}out.textContent=await call('POST','/import-history',data.value)};
status.onclick=async()=>out.textContent=await call('GET','/import-history/status');
clear.onclick=async()=>out.textContent=await call('DELETE','/import-history');
</script></html>`;
}

const originalListen = express.application.listen;
express.application.listen = function patchedListen(...args) {
  const app = this;
  app.get("/import-history", (req, res) => {
    if (!SHIM_KEY) return res.status(503).send("请先配置 SHIM_KEY；迁移入口不会在无鉴权状态开放。");
    if (!authOk(req)) return res.status(401).send("bad key");
    res.type("html").send(importPage());
  });
  app.get("/import-history/status", (req, res) => {
    if (!authOk(req)) return res.status(401).json({ ok: false });
    res.json({ ok: true, import: store.status() });
  });
  app.delete("/import-history", (req, res) => {
    if (!authOk(req)) return res.status(401).json({ ok: false });
    res.json({ ok: true, import: store.clear() });
  });
  app.post("/import-history", (req, res) => {
    if (!authOk(req)) return res.status(401).json({ ok: false });
    try {
      const messages = normalizeImportedMessages(req.body || {});
      const chars = messages.reduce((n, m) => n + m.content.length, 0);
      if (messages.length > IMPORT_MAX_MESSAGES) return res.status(413).json({ ok: false, error: `too many messages (${messages.length})` });
      if (chars > IMPORT_MAX_CHARS) return res.status(413).json({ ok: false, error: `import too large (${chars} chars)` });
      const status = store.prepare({ messages, source: req.body?.source || "claude-share" });
      console.log(new Date().toISOString(), "[import] prepared; restarting fresh", status);
      res.json({ ok: true, restart: true, import: status,
        next: "服务重启后，在 Kelivo 新建空白聊天并直接发送官端原本的下一句话。" });
      res.once("finish", () => {
        const timer = setTimeout(() => process.kill(process.pid, "SIGTERM"), 100);
        timer.unref?.();
      });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });
  return originalListen.apply(this, args);
};

await import("./server-core.js");
