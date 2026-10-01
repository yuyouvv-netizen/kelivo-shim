import crypto from "crypto";
import fs from "fs";
import path from "path";

export const TELEGRAM_STATE_VERSION = 1;

export function normalizeTelegramId(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const value = typeof raw === "number" ? raw : Number(String(raw).trim());
  return Number.isSafeInteger(value) && value !== 0 ? value : null;
}

export function parseTelegramPairCommand(raw) {
  const text = String(raw || "").trim();
  const match = /^\/(?:start|pair)(?:@[A-Za-z0-9_]+)?(?:\s+(.+))?$/i.exec(text);
  return match?.[1]?.trim() || null;
}

export function normalizeTelegramPairCode(raw) {
  const code = String(raw || "").trim();
  return /^[A-Za-z0-9_-]{16,64}$/.test(code) ? code : "";
}

export function telegramPairCodeMatches(candidate, expected) {
  const left = Buffer.from(String(candidate || ""), "utf8");
  const right = Buffer.from(String(expected || ""), "utf8");
  if (!left.length || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export class TelegramStateStore {
  constructor({ file, configuredChatId = null, log = () => {} } = {}) {
    if (!file) throw new Error("Telegram state file is required");
    this.file = file;
    this.log = log;
    this.configuredChatId = normalizeTelegramId(configuredChatId);
    this.state = this.#load();
  }

  bindBot(botId) {
    const id = normalizeTelegramId(botId);
    if (!id) return false;
    if (this.state?.botId === id) return true;
    const next = {
      version: TELEGRAM_STATE_VERSION,
      botId: id,
      chatId: this.configuredChatId,
      lastUpdateId: null,
      updatedAt: new Date().toISOString(),
    };
    return this.#persist(next);
  }

  chatId() {
    return this.configuredChatId || normalizeTelegramId(this.state?.chatId);
  }

  pair(chatId) {
    const id = normalizeTelegramId(chatId);
    if (!id || !normalizeTelegramId(this.state?.botId)) return false;
    if (this.configuredChatId && id !== this.configuredChatId) return false;
    const next = {
      ...this.state,
      chatId: id,
      updatedAt: new Date().toISOString(),
    };
    return this.#persist(next);
  }

  acceptUpdate(updateId) {
    const id = Number(updateId);
    if (!Number.isSafeInteger(id) || id < 0 || !normalizeTelegramId(this.state?.botId)) return false;
    const previous = Number.isSafeInteger(this.state?.lastUpdateId) ? this.state.lastUpdateId : null;
    if (previous !== null && id <= previous) return false;
    const next = {
      ...this.state,
      lastUpdateId: id,
      updatedAt: new Date().toISOString(),
    };
    return this.#persist(next);
  }

  hasSeen(updateId) {
    const id = Number(updateId);
    const previous = Number.isSafeInteger(this.state?.lastUpdateId) ? this.state.lastUpdateId : null;
    return Number.isSafeInteger(id) && id >= 0 && previous !== null && id <= previous;
  }

  nextOffset() {
    return Number.isSafeInteger(this.state?.lastUpdateId) ? this.state.lastUpdateId + 1 : 0;
  }

  status() {
    return {
      persistent: true,
      botBound: !!normalizeTelegramId(this.state?.botId),
      paired: !!this.chatId(),
      configuredChatId: !!this.configuredChatId,
      nextOffset: this.nextOffset(),
    };
  }

  #load() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (saved?.version !== TELEGRAM_STATE_VERSION) return null;
      const botId = normalizeTelegramId(saved.botId);
      const chatId = normalizeTelegramId(saved.chatId);
      const lastUpdateId = Number(saved.lastUpdateId);
      if (!botId) return null;
      return {
        version: TELEGRAM_STATE_VERSION,
        botId,
        chatId,
        lastUpdateId: Number.isSafeInteger(lastUpdateId) && lastUpdateId >= 0 ? lastUpdateId : null,
        updatedAt: typeof saved.updatedAt === "string" ? saved.updatedAt : null,
      };
    } catch {
      return null;
    }
  }

  #persist(next) {
    const dir = path.dirname(this.file);
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(temp, JSON.stringify(next, null, 2) + "\n", {
        encoding: "utf8",
        mode: 0o600,
      });
      fs.renameSync(temp, this.file);
      this.state = next;
      return true;
    } catch (error) {
      this.log("[tg-state] save failed", error?.message || String(error));
      try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch {}
      return false;
    }
  }
}
