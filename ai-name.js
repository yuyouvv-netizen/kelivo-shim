import fs from "fs";
import path from "path";

export const DEFAULT_AI_NAME = "TA";
export const MAX_AI_NAME_LENGTH = 32;

export function normalizeAiName(raw, fallback = DEFAULT_AI_NAME) {
  const name = String(raw ?? "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...name];
  if (!chars.length || chars.length > MAX_AI_NAME_LENGTH) return fallback;
  return name;
}

export class AiNameStore {
  constructor({ file, defaultName = DEFAULT_AI_NAME, log = () => {} } = {}) {
    if (!file) throw new Error("AI name file is required");
    this.file = file;
    this.defaultName = normalizeAiName(defaultName);
    this.log = log;
    this.name = this.#load();
  }

  get() {
    return this.name;
  }

  set(raw) {
    const name = normalizeAiName(raw, "");
    if (!name) {
      return { ok: false, status: 400, error: `名字不能为空，最多 ${MAX_AI_NAME_LENGTH} 个字。` };
    }
    try {
      this.#persist(name);
      this.name = name;
      this.log("[ai-name] changed", name);
      return { ok: true, name };
    } catch (error) {
      this.log("[ai-name] save failed", error?.message || String(error));
      return { ok: false, status: 500, error: "名字没有保存，请稍后再试。" };
    }
  }

  #load() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return normalizeAiName(saved?.name, this.defaultName);
    } catch {
      return this.defaultName;
    }
  }

  #persist(name) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify({ name, updatedAt: new Date().toISOString() }, null, 2) + "\n", {
        encoding: "utf8",
        mode: 0o600,
      });
      fs.renameSync(temp, this.file);
    } finally {
      try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch {}
    }
  }
}
