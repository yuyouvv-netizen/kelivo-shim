import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const STATUS_TIME_ZONE = "Asia/Singapore";
export const DEFAULT_STATUS_FILE = "/persona/status/now.json";
export const MAX_STATUS_CHARS = 500;
export const STATUS_CURRENT_MS = 2 * 60 * 60 * 1000;
export const STATUS_STALE_MS = 8 * 60 * 60 * 1000;
export const STATUS_HIDE_BODY_MS = 24 * 60 * 60 * 1000;

function codePointLength(value) {
  return Array.from(value).length;
}

function normalizeStatusText(value, maxChars = MAX_STATUS_CHARS) {
  if (typeof value !== "string") {
    throw new TypeError("状态内容必须是文字。");
  }
  const text = value.replace(/\r\n?/g, "\n").trim();
  if (!text) throw new TypeError("状态内容不能为空。");
  if (codePointLength(text) > maxChars) {
    throw new RangeError(`状态内容不能超过 ${maxChars} 个字符。`);
  }
  return text;
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temp, file);
    fs.chmodSync(file, 0o600);
  } finally {
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch {}
  }
}

function freshnessForAge(ageMs) {
  if (ageMs < STATUS_CURRENT_MS) return "current";
  if (ageMs < STATUS_STALE_MS) return "stale";
  if (ageMs <= STATUS_HIDE_BODY_MS) return "expired-visible";
  return "expired-hidden";
}

export class StatusStore {
  constructor({
    file = DEFAULT_STATUS_FILE,
    now = () => Date.now(),
    maxChars = MAX_STATUS_CHARS,
  } = {}) {
    if (!file) throw new Error("status file is required");
    this.file = file;
    this.now = now;
    this.maxChars = maxChars;
  }

  write(value) {
    const text = normalizeStatusText(value, this.maxChars);
    const writtenAt = new Date(this.now()).toISOString();
    const record = { version: 1, text, writtenAt };
    writeJsonAtomic(this.file, record);
    return record;
  }

  read() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return { kind: "none" };
      return { kind: "unavailable" };
    }

    try {
      const record = JSON.parse(raw);
      const writtenMs = Date.parse(record?.writtenAt);
      const nowMs = this.now();
      if (record?.version !== 1 || typeof record?.text !== "string" ||
          !record.text.trim() || codePointLength(record.text) > this.maxChars ||
          !Number.isFinite(writtenMs) || writtenMs > nowMs + 5 * 60_000) {
        return { kind: "unavailable" };
      }
      const ageMs = Math.max(0, nowMs - writtenMs);
      return {
        kind: "status",
        text: record.text,
        writtenAt: new Date(writtenMs).toISOString(),
        ageMs,
        freshness: freshnessForAge(ageMs),
      };
    } catch {
      return { kind: "unavailable" };
    }
  }
}

export function singaporeTimestamp(value) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: STATUS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
}

export function relativeAge(ageMs) {
  const totalMinutes = Math.max(0, Math.floor(ageMs / 60_000));
  if (totalMinutes < 1) return "刚刚";
  if (totalMinutes < 60) return `${totalMinutes} 分钟前`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours} 小时 ${minutes} 分钟前` : `${hours} 小时前`;
}

const EPHEMERAL_HEADER = "[临时状态｜不要写入长期记忆]";

export function renderStatusForTool(result) {
  if (result?.kind === "none") {
    return [
      EPHEMERAL_HEADER,
      "她没有留下状态。",
      "这只表示没有状态；不要推测原因、情绪或意图，也不要因此向她追问。",
    ].join("\n");
  }
  if (result?.kind !== "status") {
    return [
      EPHEMERAL_HEADER,
      "look 暂时无法读取状态。",
      "这是工具故障，不等于她没有留下状态；不要因此向她追问，也不要自动重试。",
    ].join("\n");
  }

  const age = relativeAge(result.ageMs);
  const written = `${age}（${singaporeTimestamp(result.writtenAt)}，新加坡）`;
  if (result.freshness === "expired-hidden") {
    return [
      EPHEMERAL_HEADER,
      "她留下的状态已超过 24 小时，正文不再返回。",
      `最后更新：${written}`,
      `新鲜度：【已过期 · ${age} · 不可视为此刻】`,
    ].join("\n");
  }

  const freshness = result.freshness === "current"
    ? `【当前 · ${age}】`
    : result.freshness === "stale"
      ? `【较旧 · ${age} · 不可自动当作此刻】`
      : `【已过期 · ${age} · 不可视为此刻】`;
  return [
    EPHEMERAL_HEADER,
    `内容：${result.text}`,
    `写于：${written}`,
    `新鲜度：${freshness}`,
  ].join("\n");
}

function suppliedWriteToken(req) {
  const authorization = String(req.get("authorization") || "");
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  return bearer || String(req.get("x-status-key") || "").trim();
}

function sameSecret(actual, expected) {
  if (!actual || !expected) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function registerStatusRoute(app, {
  store,
  writeToken,
  json,
  log = () => {},
} = {}) {
  if (!store) throw new Error("status store is required");
  if (typeof json !== "function") throw new Error("JSON parser is required");
  app.post("/status", (req, res, next) => {
    if (!writeToken) {
      return res.status(503).json({ ok: false, error: "状态写入尚未配置。" });
    }
    if (!sameSecret(suppliedWriteToken(req), writeToken)) {
      return res.status(401).json({ ok: false, error: "未授权。" });
    }
    next();
  }, json({ limit: "4kb", strict: true }), (req, res) => {
    try {
      const record = store.write(req.body?.text);
      log(`[status] updated chars=${codePointLength(record.text)}`);
      return res.status(201).json({
        ok: true,
        writtenAt: record.writtenAt,
        writtenAtSingapore: singaporeTimestamp(record.writtenAt),
        timeZone: STATUS_TIME_ZONE,
      });
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) {
        return res.status(400).json({ ok: false, error: error.message });
      }
      log(`[status] persist failed ${error?.message || String(error)}`);
      return res.status(500).json({ ok: false, error: "状态没有保存，请稍后再试。" });
    }
  });
}
