import crypto from "crypto";
import fs from "fs";
import path from "path";

export const DEFAULT_TELEGRAM_CARD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const CARD_ID_RE = /^[a-f0-9]{32}$/;
const CARD_MARKER_RE = /\[碎碎念(?:\s*[:：]\s*([^\]\n]{1,64}))?\]([\s\S]*?)\[\/碎碎念\]/g;

function text(value, max) {
  return String(value || "").trim().slice(0, max);
}

function appendTextSegment(segments, content) {
  if (!content) return;
  const previous = segments.at(-1);
  if (previous?.type === "text") previous.content += content;
  else segments.push({ type: "text", content });
}

export function splitTelegramCardSegments(value, maxCards = 4) {
  const source = String(value || "");
  const segments = [];
  let cursor = 0;
  let cards = 0;
  CARD_MARKER_RE.lastIndex = 0;
  for (const match of source.matchAll(CARD_MARKER_RE)) {
    if (cards >= maxCards) break;
    appendTextSegment(segments, source.slice(cursor, match.index));
    const body = text(match[2], 12_000);
    if (body) {
      segments.push({
        type: "card",
        title: text(match[1], 64) || null,
        content: body,
      });
      cards += 1;
    } else {
      appendTextSegment(segments, match[0]);
    }
    cursor = match.index + match[0].length;
  }
  appendTextSegment(segments, source.slice(cursor));
  return segments.length ? segments : [{ type: "text", content: source }];
}

export function telegramCardPreview(value, max = 92) {
  const clean = String(value || "")
    .replace(/\*\*/g, "")
    .replace(/[`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(clean);
  if (chars.length <= max) return clean;
  return `${chars.slice(0, max).join("").trimEnd()}…`;
}

export function normalizeTelegramCardBaseUrl(raw) {
  try {
    const url = new URL(String(raw || "").trim());
    if (url.protocol !== "https:") return "";
    return url.origin;
  } catch {
    return "";
  }
}

export class TelegramCardStore {
  constructor({
    dir,
    ttlMs = DEFAULT_TELEGRAM_CARD_TTL_MS,
    now = () => Date.now(),
    log = () => {},
  } = {}) {
    if (!dir) throw new Error("Telegram card directory is required");
    this.dir = dir;
    this.ttlMs = Math.max(60_000, Number(ttlMs) || DEFAULT_TELEGRAM_CARD_TTL_MS);
    this.now = now;
    this.log = log;
  }

  create({ title, body, chatId }) {
    const card = {
      version: 1,
      id: crypto.randomBytes(16).toString("hex"),
      title: text(title, 64) || "碎碎念",
      body: text(body, 12_000),
      chatId: String(chatId || ""),
      createdAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + this.ttlMs).toISOString(),
    };
    if (!card.body || !card.chatId) return null;
    const file = this.#file(card.id);
    const temp = `${file}.${process.pid}.${this.now()}.tmp`;
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(temp, JSON.stringify(card) + "\n", { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temp, file);
      return card;
    } catch (error) {
      this.log("[tg-card] save failed", error?.message || String(error));
      try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch {}
      return null;
    }
  }

  get(id, chatId) {
    if (!CARD_ID_RE.test(String(id || ""))) return null;
    const file = this.#file(id);
    try {
      const card = JSON.parse(fs.readFileSync(file, "utf8"));
      const expiresAt = Date.parse(card?.expiresAt || "");
      if (card?.version !== 1 || card.id !== id || !Number.isFinite(expiresAt)) return null;
      if (expiresAt <= this.now()) {
        try { fs.unlinkSync(file); } catch {}
        return null;
      }
      if (String(card.chatId) !== String(chatId)) return null;
      return card;
    } catch {
      return null;
    }
  }

  remove(id) {
    if (!CARD_ID_RE.test(String(id || ""))) return false;
    try { fs.unlinkSync(this.#file(id)); return true; }
    catch { return false; }
  }

  cleanup() {
    let removed = 0;
    let kept = 0;
    try {
      for (const name of fs.readdirSync(this.dir)) {
        if (!/^[a-f0-9]{32}\.json$/.test(name)) continue;
        const file = path.join(this.dir, name);
        try {
          const card = JSON.parse(fs.readFileSync(file, "utf8"));
          if (Date.parse(card?.expiresAt || "") > this.now()) kept += 1;
          else { fs.unlinkSync(file); removed += 1; }
        } catch {
          try { fs.unlinkSync(file); removed += 1; } catch {}
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT") this.log("[tg-card] cleanup failed", error?.message || String(error));
    }
    return { removed, kept };
  }

  #file(id) {
    return path.join(this.dir, `${id}.json`);
  }
}

export function validateTelegramInitData(raw, {
  botToken,
  expectedUserId,
  nowMs = Date.now(),
  maxAgeSec = 3600,
} = {}) {
  const source = String(raw || "");
  if (!source || source.length > 16_384 || !botToken || !expectedUserId) return { ok: false };
  const params = new URLSearchParams(source);
  const seen = new Set();
  for (const [key] of params) {
    if (seen.has(key)) return { ok: false };
    seen.add(key);
  }
  const suppliedHash = params.get("hash") || "";
  if (!/^[a-f0-9]{64}$/i.test(suppliedHash)) return { ok: false };
  const check = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const expectedHash = crypto.createHmac("sha256", secret).update(check).digest("hex");
  if (!crypto.timingSafeEqual(Buffer.from(suppliedHash, "hex"), Buffer.from(expectedHash, "hex"))) {
    return { ok: false };
  }
  const authDate = Number(params.get("auth_date"));
  const nowSec = Math.floor(nowMs / 1000);
  if (!Number.isSafeInteger(authDate) || authDate > nowSec + 30 || nowSec - authDate > maxAgeSec) {
    return { ok: false };
  }
  try {
    const user = JSON.parse(params.get("user") || "null");
    if (String(user?.id || "") !== String(expectedUserId)) return { ok: false };
    return { ok: true, user };
  } catch {
    return { ok: false };
  }
}

function cardPageHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>碎碎念</title>
  <script src="https://telegram.org/js/telegram-web-app.js?63"></script>
  <style>
    :root{color-scheme:light dark;--ink:#302d2a;--muted:#817a73;--paper:rgba(255,252,246,.92);--edge:rgba(70,58,48,.10)}
    *{box-sizing:border-box} body{margin:0;min-height:100vh;padding:26px 18px calc(34px + env(safe-area-inset-bottom));font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif;color:var(--ink);background:radial-gradient(circle at 12% 10%,rgba(255,255,255,.9),transparent 34%),radial-gradient(circle at 88% 92%,rgba(176,196,173,.30),transparent 36%),#e9e4dc}
    body:before{content:"";position:fixed;inset:0;pointer-events:none;opacity:.24;background-image:radial-gradient(circle at 20% 30%,#fff 0 1px,transparent 1.5px),radial-gradient(circle at 80% 65%,#fff 0 1px,transparent 1.5px);background-size:45px 45px,58px 58px}
    main{position:relative;max-width:680px;margin:0 auto}.paper{display:none;min-height:58vh;padding:30px 25px 34px;border:1px solid var(--edge);border-radius:28px;background:var(--paper);box-shadow:0 20px 54px rgba(44,39,35,.15);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px)}
    .mark{font-size:23px;line-height:1;margin-bottom:20px;color:#847a70}.title{margin:0;font-size:22px;line-height:1.35;letter-spacing:.02em}.meta{margin-top:8px;color:var(--muted);font-size:13px}.body{margin-top:27px;font-size:18px;line-height:1.85;white-space:pre-wrap;overflow-wrap:anywhere}.loading,.error{margin:32vh auto 0;text-align:center;color:var(--muted);font-size:15px}.error{display:none;max-width:280px;line-height:1.7}.close{display:none;width:100%;margin:18px 0 0;padding:14px;border:0;border-radius:18px;background:rgba(255,255,255,.72);color:var(--ink);font-size:16px}
    @media(prefers-color-scheme:dark){:root{--ink:#eee9e2;--muted:#aaa29a;--paper:rgba(39,38,37,.92);--edge:rgba(255,255,255,.08)}body{background:radial-gradient(circle at 15% 8%,rgba(105,103,100,.32),transparent 35%),radial-gradient(circle at 82% 90%,rgba(72,91,76,.30),transparent 38%),#171717}.close{background:rgba(255,255,255,.09)}}
  </style>
</head>
<body><main>
  <div class="loading" id="loading">正在拆开这张纸条…</div>
  <div class="error" id="error"></div>
  <article class="paper" id="paper"><div class="mark">♡</div><h1 class="title" id="title"></h1><div class="meta" id="meta"></div><div class="body" id="body"></div></article>
  <button class="close" id="close" type="button">收好纸条</button>
</main>
<script>
(() => {
  const web = window.Telegram && window.Telegram.WebApp;
  const loading = document.getElementById('loading');
  const error = document.getElementById('error');
  const fail = (message) => { loading.style.display='none'; error.textContent=message; error.style.display='block'; };
  if (!web || !web.initData) { fail('请从 Telegram 对话里的小卡片打开。'); return; }
  web.ready(); web.expand();
  fetch(location.pathname + '/open', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({initData:web.initData}),credentials:'omit'})
    .then(async (response) => { const data = await response.json(); if (!response.ok || !data.ok) throw new Error(data.error || '这张碎碎念已经散掉了。'); return data.card; })
    .then((card) => {
      document.getElementById('title').textContent=card.title;
      document.getElementById('meta').textContent=card.createdLabel;
      document.getElementById('body').textContent=card.body;
      loading.style.display='none'; document.getElementById('paper').style.display='block'; document.getElementById('close').style.display='block';
    }).catch((cause) => fail(cause.message || '这张碎碎念已经散掉了。'));
  document.getElementById('close').addEventListener('click', () => web.close());
})();
</script></body></html>`;
}

function singaporeCardTime(value) {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Singapore",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(value));
  } catch {
    return "";
  }
}

export function registerTelegramCardRoutes(app, {
  getStore,
  getBotToken,
  getPairedChatId,
  json,
  log = () => {},
} = {}) {
  if (!app || typeof getStore !== "function" || typeof getBotToken !== "function" ||
      typeof getPairedChatId !== "function" || !json) {
    throw new Error("Telegram card routes require app, store, bot token, pairing and json parser");
  }
  app.get("/telegram/card/:id", (req, res) => {
    if (!CARD_ID_RE.test(String(req.params.id || ""))) return res.status(404).send("Not found");
    res.set({
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; script-src https://telegram.org 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    return res.type("html").send(cardPageHtml());
  });
  app.post("/telegram/card/:id/open", json({ limit: "20kb" }), (req, res) => {
    res.set("Cache-Control", "no-store");
    const store = getStore();
    const chatId = getPairedChatId();
    const auth = validateTelegramInitData(req.body?.initData, {
      botToken: getBotToken(),
      expectedUserId: chatId,
    });
    if (!auth.ok) return res.status(401).json({ ok: false, error: "这张纸条只认配对的你。" });
    const card = store.get(req.params.id, chatId);
    if (!card) return res.status(404).json({ ok: false, error: "这张碎碎念已经散掉了。" });
    log("[tg-card] opened", card.id);
    return res.json({
      ok: true,
      card: {
        title: card.title,
        body: card.body,
        createdLabel: singaporeCardTime(card.createdAt),
      },
    });
  });
}
