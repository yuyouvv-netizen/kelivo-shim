import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export const DEFAULT_TELEGRAM_CARD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const CARD_ID_RE = /^[a-f0-9]{32}$/;
const CARD_MARKER_RE = /\[(小纸条|碎碎念)(?:\s*[:：]\s*([^\]\n]{1,64}))?\]([\s\S]*?)\[\/\1\]/g;
const TELEGRAM_CARD_RABBITS_FILE = fileURLToPath(
  new URL("./telegram-card-rabbits.webp", import.meta.url),
);

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
    const body = text(match[3], 12_000);
    if (body) {
      segments.push({
        type: "card",
        title: text(match[2], 64) || null,
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

export function telegramCardPreview(value, max = 36) {
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
      title: text(title, 64) || "小纸条",
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
  <title>小纸条</title>
  <script src="https://telegram.org/js/telegram-web-app.js?63"></script>
  <style>
    :root{color-scheme:light dark;--ink:#4a3c34;--muted:#9a8172;--paper:#fffaf1;--edge:rgba(178,139,113,.25);--accent:#bd8d73;--close:rgba(255,250,241,.78)}
    *{box-sizing:border-box} body{margin:0;min-height:100vh;padding:24px 17px calc(32px + env(safe-area-inset-bottom));font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif;color:var(--ink);background:radial-gradient(circle at 14% 7%,rgba(255,255,255,.96),transparent 31%),radial-gradient(circle at 88% 91%,rgba(220,181,153,.30),transparent 38%),linear-gradient(145deg,#eee4d7,#e5d5c3)}
    body:before{content:"";position:fixed;inset:0;pointer-events:none;opacity:.19;background-image:radial-gradient(circle at 20% 30%,#fff 0 1px,transparent 1.6px),radial-gradient(circle at 78% 68%,#fff 0 1px,transparent 1.6px);background-size:43px 43px,61px 61px}
    main{position:relative;max-width:680px;margin:0 auto}.paper{position:relative;isolation:isolate;display:none;min-height:62vh;overflow:hidden;padding:31px 25px clamp(190px,42vw,285px);border:1px solid var(--edge);border-radius:30px;background:linear-gradient(155deg,rgba(255,255,255,.72),transparent 34%),var(--paper);box-shadow:0 21px 55px rgba(91,62,45,.15),inset 0 0 0 1px rgba(255,255,255,.62)}
    .paper:before{content:"";position:absolute;z-index:-1;right:-88px;bottom:-92px;width:310px;height:310px;border-radius:50%;background:rgba(220,181,153,.12)}
    .mark{font-size:20px;line-height:1;margin-bottom:21px;color:var(--accent)}.title{margin:0;font-size:22px;font-weight:600;line-height:1.42;letter-spacing:.025em}.meta{margin-top:9px;color:var(--muted);font-size:13px;letter-spacing:.04em}.body{position:relative;z-index:1;margin-top:28px;font-size:18px;line-height:1.9;white-space:pre-wrap;overflow-wrap:anywhere}.rabbits{position:absolute;z-index:0;right:-8px;bottom:-3px;width:min(67%,390px);height:auto;pointer-events:none;user-select:none;filter:drop-shadow(0 11px 14px rgba(111,73,49,.12))}.loading,.error{margin:32vh auto 0;text-align:center;color:var(--muted);font-size:15px}.error{display:none;max-width:280px;line-height:1.7}.close{display:none;width:100%;margin:17px 0 0;padding:14px;border:1px solid rgba(178,139,113,.14);border-radius:18px;background:var(--close);color:var(--ink);font-size:16px;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
    @media(max-width:420px){body{padding-left:14px;padding-right:14px}.paper{padding:27px 22px clamp(174px,48vw,220px);border-radius:27px}.rabbits{right:-13px;width:72%}}
    @media(prefers-color-scheme:dark){:root{--ink:#f3e9de;--muted:#bda99c;--paper:#302722;--edge:rgba(236,193,162,.16);--accent:#d7a98e;--close:rgba(54,43,37,.82)}body{background:radial-gradient(circle at 14% 8%,rgba(118,91,74,.34),transparent 35%),radial-gradient(circle at 84% 91%,rgba(112,74,53,.28),transparent 40%),#1b1715}.paper{background:linear-gradient(155deg,rgba(255,255,255,.055),transparent 34%),var(--paper);box-shadow:0 21px 58px rgba(0,0,0,.30),inset 0 0 0 1px rgba(255,255,255,.035)}.paper:before{background:rgba(204,151,117,.10)}.rabbits{filter:drop-shadow(0 12px 16px rgba(0,0,0,.22)) brightness(.86)}}
  </style>
</head>
<body><main>
  <div class="loading" id="loading">正在拆开这张纸条…</div>
  <div class="error" id="error"></div>
  <article class="paper" id="paper"><div class="mark">♡</div><h1 class="title" id="title"></h1><div class="meta" id="meta"></div><div class="body" id="body"></div><img class="rabbits" src="/telegram/card-art/rabbits.webp" alt="" aria-hidden="true"></article>
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
    .then(async (response) => { const data = await response.json(); if (!response.ok || !data.ok) throw new Error(data.error || '这张小纸条已经散掉了。'); return data.card; })
    .then((card) => {
      document.getElementById('title').textContent=card.title;
      document.getElementById('meta').textContent=card.createdLabel;
      document.getElementById('body').textContent=card.body;
      loading.style.display='none'; document.getElementById('paper').style.display='block'; document.getElementById('close').style.display='block';
    }).catch((cause) => fail(cause.message || '这张小纸条已经散掉了。'));
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
  app.get("/telegram/card-art/rabbits.webp", (_req, res) => {
    res.set({
      "Cache-Control": "public, max-age=604800, immutable",
      "Content-Security-Policy": "default-src 'none'",
      "X-Content-Type-Options": "nosniff",
    });
    return res.type("image/webp").sendFile(TELEGRAM_CARD_RABBITS_FILE);
  });
  app.get("/telegram/card/:id", (req, res) => {
    if (!CARD_ID_RE.test(String(req.params.id || ""))) return res.status(404).send("Not found");
    res.set({
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; script-src https://telegram.org 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
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
    if (!card) return res.status(404).json({ ok: false, error: "这张小纸条已经散掉了。" });
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
