import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export const DEFAULT_TELEGRAM_CARD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const CARD_ID_RE = /^[a-f0-9]{32}$/;
const CARD_MARKER_RE = /\[(小纸条|碎碎念)(?:\s*[:：]\s*([^\]\n]{1,64}))?\]([\s\S]*?)\[\/\1\]/g;
const CARD_EVENT_TYPES = ["opened", "hearted", "replied"];
const CARD_REPLY_MAX = 4000;
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

function singaporeParts(value) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Singapore",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(value)).map((part) => [part.type, part.value]));
    if (!parts.month || !parts.day || !parts.hour || !parts.minute) return null;
    return { date: `${parts.month}/${parts.day}`, time: `${parts.hour}:${parts.minute}` };
  } catch {
    return null;
  }
}

export function formatTelegramCardReceipt(events) {
  const lines = [...(events || [])]
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
    .map((event) => {
      const happened = singaporeParts(event.at);
      const created = singaporeParts(event.createdAt);
      if (!happened) return "";
      const title = `《${text(event.title, 64) || "小纸条"}》`;
      const when = `${happened.date} ${happened.time}`;
      if (event.type === "opened") {
        const delayed = created && created.date !== happened.date ? ` ${created.date} 的` : "";
        return `${when}，又又拆开了${delayed}${title}。`;
      }
      if (event.type === "hearted") return `${when}，又又为${title}点亮了心。`;
      if (event.type === "replied") return `${when}，又又回复了${title}：“${event.reply}”`;
      return "";
    })
    .filter(Boolean);
  return lines.length ? `【小纸条回执】\n${lines.join("\n")}` : "";
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

  markOpened(id, chatId) {
    return this.#update(id, chatId, (card) => {
      if (!card.openedAt) card.openedAt = new Date(this.now()).toISOString();
      return true;
    });
  }

  markHearted(id, chatId) {
    return this.#update(id, chatId, (card) => {
      if (!card.heartedAt) card.heartedAt = new Date(this.now()).toISOString();
      return true;
    });
  }

  recordReply(id, chatId, value) {
    const reply = String(value ?? "").trim();
    if (!reply || reply.length > CARD_REPLY_MAX) return { ok: false, reason: "invalid" };
    let created = false;
    const card = this.#update(id, chatId, (current) => {
      if (current.repliedAt) return true;
      current.reply = reply;
      current.repliedAt = new Date(this.now()).toISOString();
      created = true;
      return true;
    });
    if (!card) return { ok: false, reason: "missing" };
    if (!created && card.reply !== reply) return { ok: false, reason: "already-replied", card };
    return { ok: true, created, card };
  }

  claimPendingReceipts(chatId) {
    const claimId = crypto.randomBytes(16).toString("hex");
    const events = [];
    for (const card of this.#list(chatId)) {
      const claimed = [];
      for (const type of CARD_EVENT_TYPES) {
        const at = card[`${type}At`];
        if (!at || card[`${type}ReportedAt`] || card[`${type}ReceiptClaim`]) continue;
        claimed.push(type);
      }
      if (!claimed.length) continue;
      const updated = this.#update(card.id, chatId, (current) => {
        for (const type of claimed) {
          if (current[`${type}At`] && !current[`${type}ReportedAt`] && !current[`${type}ReceiptClaim`]) {
            current[`${type}ReceiptClaim`] = claimId;
          }
        }
        return true;
      });
      if (!updated) continue;
      for (const type of claimed) {
        if (updated[`${type}ReceiptClaim`] !== claimId) continue;
        events.push({
          cardId: updated.id,
          type,
          at: updated[`${type}At`],
          createdAt: updated.createdAt,
          title: updated.title,
          ...(type === "replied" ? { reply: updated.reply } : {}),
        });
      }
    }
    return { id: claimId, chatId: String(chatId || ""), events, text: formatTelegramCardReceipt(events) };
  }

  finalizeReceiptClaim(claim) {
    return this.#settleReceiptClaim(claim, true);
  }

  releaseReceiptClaim(claim) {
    return this.#settleReceiptClaim(claim, false);
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

  #list(chatId) {
    const cards = [];
    try {
      for (const name of fs.readdirSync(this.dir)) {
        if (!/^[a-f0-9]{32}\.json$/.test(name)) continue;
        const card = this.get(name.slice(0, -5), chatId);
        if (card) cards.push(card);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") this.log("[tg-card] list failed", error?.message || String(error));
    }
    return cards;
  }

  #update(id, chatId, mutate) {
    const card = this.get(id, chatId);
    if (!card) return null;
    if (mutate(card) === false) return null;
    const file = this.#file(id);
    const temp = `${file}.${process.pid}.${this.now()}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(card) + "\n", { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temp, file);
      return card;
    } catch (error) {
      this.log("[tg-card] update failed", error?.message || String(error));
      try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch {}
      return null;
    }
  }

  #settleReceiptClaim(claim, delivered) {
    if (!claim?.id || !claim?.chatId || !Array.isArray(claim.events)) return false;
    const byCard = new Map();
    for (const event of claim.events) {
      if (!byCard.has(event.cardId)) byCard.set(event.cardId, []);
      byCard.get(event.cardId).push(event.type);
    }
    let ok = true;
    for (const [cardId, types] of byCard) {
      const updated = this.#update(cardId, claim.chatId, (card) => {
        for (const type of types) {
          if (card[`${type}ReceiptClaim`] !== claim.id) continue;
          delete card[`${type}ReceiptClaim`];
          if (delivered) card[`${type}ReportedAt`] = new Date(this.now()).toISOString();
        }
        return true;
      });
      if (!updated) ok = false;
    }
    return ok;
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
    :root{color-scheme:light dark;--ink:#4a3c34;--muted:#9a8172;--paper:#fffaf1;--edge:rgba(178,139,113,.25);--accent:#bd8d73;--accent-deep:#9f6f57;--close:rgba(255,250,241,.78);--field:rgba(255,250,241,.72)}
    *{box-sizing:border-box} body{margin:0;min-height:100vh;padding:24px 17px calc(32px + env(safe-area-inset-bottom));font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif;color:var(--ink);background:radial-gradient(circle at 14% 7%,rgba(255,255,255,.96),transparent 31%),radial-gradient(circle at 88% 91%,rgba(220,181,153,.30),transparent 38%),linear-gradient(145deg,#eee4d7,#e5d5c3)}
    body:before{content:"";position:fixed;inset:0;pointer-events:none;opacity:.19;background-image:radial-gradient(circle at 20% 30%,#fff 0 1px,transparent 1.6px),radial-gradient(circle at 78% 68%,#fff 0 1px,transparent 1.6px);background-size:43px 43px,61px 61px}
    main{position:relative;max-width:680px;margin:0 auto}.paper{position:relative;isolation:isolate;display:none;min-height:62vh;overflow:hidden;padding:31px 25px clamp(190px,42vw,285px);border:1px solid var(--edge);border-radius:30px;background:linear-gradient(155deg,rgba(255,255,255,.72),transparent 34%),var(--paper);box-shadow:0 21px 55px rgba(91,62,45,.15),inset 0 0 0 1px rgba(255,255,255,.62)}
    .paper:before{content:"";position:absolute;z-index:-1;right:-88px;bottom:-92px;width:310px;height:310px;border-radius:50%;background:rgba(220,181,153,.12)}
    .heart{position:relative;z-index:2;display:flex;align-items:center;gap:7px;margin:0 0 21px;padding:0;border:0;background:transparent;color:var(--accent);font:inherit}.heart-glyph{font-size:23px;line-height:1;transition:transform .18s ease}.heart-label{font-size:12px;letter-spacing:.08em;color:var(--muted)}.heart.is-on .heart-glyph{color:var(--accent-deep);transform:scale(1.08)}.heart:disabled{opacity:.82}.title{margin:0;font-size:22px;font-weight:600;line-height:1.42;letter-spacing:.025em}.meta{margin-top:9px;color:var(--muted);font-size:13px;letter-spacing:.04em}.body{position:relative;z-index:1;margin-top:28px;font-size:18px;line-height:1.9;white-space:pre-wrap;overflow-wrap:anywhere}.rabbits{position:absolute;z-index:0;right:-8px;bottom:-3px;width:min(67%,390px);height:auto;pointer-events:none;user-select:none;filter:drop-shadow(0 11px 14px rgba(111,73,49,.12))}.loading,.error{margin:32vh auto 0;text-align:center;color:var(--muted);font-size:15px}.error{display:none;max-width:280px;line-height:1.7}.actions{display:none;margin-top:17px;padding:17px;border:1px solid rgba(178,139,113,.16);border-radius:22px;background:var(--field);box-shadow:0 12px 32px rgba(91,62,45,.08);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}.reply-label{display:block;margin:0 0 10px;font-size:14px;color:var(--muted)}textarea{display:block;width:100%;min-height:92px;resize:vertical;padding:13px 14px;border:1px solid var(--edge);border-radius:16px;outline:none;background:rgba(255,255,255,.52);color:var(--ink);font:inherit;font-size:16px;line-height:1.6}textarea:focus{border-color:rgba(159,111,87,.55);box-shadow:0 0 0 3px rgba(189,141,115,.10)}.send,.close{width:100%;padding:14px;border-radius:18px;color:var(--ink);font-size:16px}.send{margin-top:11px;border:0;background:linear-gradient(135deg,#d9ae94,#c69276);color:#fffaf4;font-weight:600;box-shadow:0 8px 18px rgba(159,111,87,.18)}.send:disabled{opacity:.58;box-shadow:none}.status{display:none;margin:10px 2px 0;color:var(--muted);font-size:13px;line-height:1.55}.close{display:none;margin:12px 0 0;border:1px solid rgba(178,139,113,.14);background:var(--close);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
    @media(max-width:420px){body{padding-left:14px;padding-right:14px}.paper{padding:27px 22px clamp(174px,48vw,220px);border-radius:27px}.rabbits{right:-13px;width:72%}}
    @media(prefers-color-scheme:dark){:root{--ink:#f3e9de;--muted:#bda99c;--paper:#302722;--edge:rgba(236,193,162,.16);--accent:#d7a98e;--accent-deep:#efb99a;--close:rgba(54,43,37,.82);--field:rgba(54,43,37,.78)}body{background:radial-gradient(circle at 14% 8%,rgba(118,91,74,.34),transparent 35%),radial-gradient(circle at 84% 91%,rgba(112,74,53,.28),transparent 40%),#1b1715}.paper{background:linear-gradient(155deg,rgba(255,255,255,.055),transparent 34%),var(--paper);box-shadow:0 21px 58px rgba(0,0,0,.30),inset 0 0 0 1px rgba(255,255,255,.035)}.paper:before{background:rgba(204,151,117,.10)}.rabbits{filter:drop-shadow(0 12px 16px rgba(0,0,0,.22)) brightness(.86)}textarea{background:rgba(22,18,16,.34)}}
  </style>
</head>
<body><main>
  <div class="loading" id="loading">正在拆开这张纸条…</div>
  <div class="error" id="error"></div>
  <article class="paper" id="paper"><button class="heart" id="heart" type="button" aria-label="为这张纸条点亮爱心"><span class="heart-glyph" id="heart-glyph">♡</span><span class="heart-label" id="heart-label">点亮</span></button><h1 class="title" id="title"></h1><div class="meta" id="meta"></div><div class="body" id="body"></div><img class="rabbits" src="/telegram/card-art/rabbits.webp" alt="" aria-hidden="true"></article>
  <section class="actions" id="actions"><label class="reply-label" for="reply">给虞克回一句</label><textarea id="reply" maxlength="4000" placeholder="写下想让他现在收到的话……"></textarea><button class="send" id="send" type="button">把回信递给他</button><div class="status" id="status" role="status"></div></section>
  <button class="close" id="close" type="button">收好纸条</button>
</main>
<script>
(() => {
  const web = window.Telegram && window.Telegram.WebApp;
  const loading = document.getElementById('loading');
  const error = document.getElementById('error');
  const heart = document.getElementById('heart');
  const glyph = document.getElementById('heart-glyph');
  const heartLabel = document.getElementById('heart-label');
  const reply = document.getElementById('reply');
  const send = document.getElementById('send');
  const status = document.getElementById('status');
  const fail = (message) => { loading.style.display='none'; error.textContent=message; error.style.display='block'; };
  const showStatus = (message) => { status.textContent=message; status.style.display='block'; };
  const request = async (action, extra) => {
    const response = await fetch(location.pathname + action, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({initData:web.initData},extra||{})),credentials:'omit'});
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || '这次没有递稳，请稍后再试。');
    return data;
  };
  const setHearted = (on) => { heart.classList.toggle('is-on',on); glyph.textContent=on?'♥':'♡'; heartLabel.textContent=on?'已点亮':'点亮'; heart.disabled=on; };
  const setReplied = (on) => { reply.disabled=on; send.disabled=on; if(on){send.textContent='回信已经递出'; showStatus('虞克会在 Telegram 里收到并回复你。');} };
  if (!web || !web.initData) { fail('请从 Telegram 对话里的小卡片打开。'); return; }
  web.ready(); web.expand();
  request('/open')
    .then((data) => data.card)
    .then((card) => {
      document.getElementById('title').textContent=card.title;
      document.getElementById('meta').textContent=card.createdLabel;
      document.getElementById('body').textContent=card.body;
      setHearted(!!card.hearted); setReplied(!!card.replied);
      loading.style.display='none'; document.getElementById('paper').style.display='block'; document.getElementById('actions').style.display='block'; document.getElementById('close').style.display='block';
    }).catch((cause) => fail(cause.message || '这张小纸条已经散掉了。'));
  heart.addEventListener('click', async () => {
    if(heart.disabled)return; heart.disabled=true;
    try { await request('/heart'); setHearted(true); web.HapticFeedback && web.HapticFeedback.impactOccurred('light'); showStatus('这颗心先安静亮着，下次说话时再告诉他。'); }
    catch(cause){ heart.disabled=false; showStatus(cause.message); }
  });
  send.addEventListener('click', async () => {
    const value=reply.value.trim();
    if(!value){showStatus('先写下一句回信呀。');reply.focus();return;}
    send.disabled=true; send.textContent='正在递给他…';
    try { await request('/reply',{reply:value}); setReplied(true); web.HapticFeedback && web.HapticFeedback.notificationOccurred('success'); }
    catch(cause){ send.disabled=false; send.textContent='把回信递给他'; showStatus(cause.message); }
  });
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
  onReply,
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
  const cardJson = json({ limit: "32kb" });
  const authorizedCard = (req, res) => {
    res.set("Cache-Control", "no-store");
    const store = getStore();
    const chatId = getPairedChatId();
    const auth = validateTelegramInitData(req.body?.initData, {
      botToken: getBotToken(),
      expectedUserId: chatId,
    });
    if (!auth.ok) {
      res.status(401).json({ ok: false, error: "这张纸条只认配对的你。" });
      return null;
    }
    const card = store.get(req.params.id, chatId);
    if (!card) {
      res.status(404).json({ ok: false, error: "这张小纸条已经散掉了。" });
      return null;
    }
    return { store, chatId, card };
  };
  const cardState = (card) => ({
    title: card.title,
    body: card.body,
    createdLabel: singaporeCardTime(card.createdAt),
    hearted: !!card.heartedAt,
    replied: !!card.repliedAt,
  });
  app.post("/telegram/card/:id/open", cardJson, (req, res) => {
    const found = authorizedCard(req, res);
    if (!found) return;
    const card = found.store.markOpened(req.params.id, found.chatId);
    if (!card) return res.status(503).json({ ok: false, error: "拆开纸条的时间没有记稳，请再试一次。" });
    log("[tg-card] opened", card.id);
    return res.json({ ok: true, card: cardState(card) });
  });
  app.post("/telegram/card/:id/heart", cardJson, (req, res) => {
    const found = authorizedCard(req, res);
    if (!found) return;
    const card = found.store.markHearted(req.params.id, found.chatId);
    if (!card) return res.status(503).json({ ok: false, error: "这颗心没有点稳，请再试一次。" });
    log("[tg-card] hearted", card.id);
    return res.json({ ok: true, card: cardState(card) });
  });
  app.post("/telegram/card/:id/reply", cardJson, async (req, res) => {
    const found = authorizedCard(req, res);
    if (!found) return;
    if (typeof onReply !== "function") {
      return res.status(503).json({ ok: false, error: "回信通道还没有接好。" });
    }
    const recorded = found.store.recordReply(req.params.id, found.chatId, req.body?.reply);
    if (!recorded.ok) {
      if (recorded.reason === "already-replied") {
        return res.status(409).json({ ok: false, error: "这张纸条已经回过信啦。" });
      }
      if (recorded.reason === "missing") {
        return res.status(404).json({ ok: false, error: "这张小纸条已经散掉了。" });
      }
      return res.status(400).json({ ok: false, error: `回信请写在 1–${CARD_REPLY_MAX} 字以内。` });
    }
    if (!recorded.created && (recorded.card.repliedReportedAt || recorded.card.repliedReceiptClaim)) {
      return res.json({ ok: true, delivered: true, card: cardState(recorded.card) });
    }
    const claim = found.store.claimPendingReceipts(found.chatId);
    if (!claim.events.length || !claim.text) {
      return res.status(503).json({ ok: false, error: "回信已经记下了，暂时没递出去；下次在 Telegram 说话时会一起带上。" });
    }
    let accepted = false;
    try {
      accepted = await onReply({ text: claim.text, card: recorded.card });
    } catch (error) {
      // The callback may have queued the turn before failing. Keep the claim so
      // a retry cannot wake him twice; this project prefers a missing receipt
      // over a duplicated user turn when delivery is uncertain.
      log("[tg-card] reply delivery uncertain", error?.message || String(error));
      return res.status(503).json({ ok: false, error: "回信已经记下了，但这次回执不确定；为避免重复不会自动重发。" });
    }
    if (!accepted) {
      found.store.releaseReceiptClaim(claim);
      return res.status(409).json({ ok: false, error: "回信已经记下了，暂时没递出去；下次在 Telegram 说话时会一起带上。" });
    }
    found.store.finalizeReceiptClaim(claim);
    log("[tg-card] replied", recorded.card.id);
    return res.json({ ok: true, delivered: true, card: cardState(recorded.card) });
  });
}
