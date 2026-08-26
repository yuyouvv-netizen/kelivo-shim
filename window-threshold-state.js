import fs from "fs";
import path from "path";

import { validSessionId } from "./session-state.js";

const EMPTY = Object.freeze({ tracked: false, warned: false, archived: false });

export function legacyWindowFlags({
  pct,
  warnPct = 80,
  archivePct = 85,
  autoArchive = true,
} = {}) {
  const usage = Number(pct) || 0;
  return {
    warned: usage >= Number(warnPct),
    archived: !!autoArchive && usage >= Number(archivePct),
  };
}

export class WindowThresholdStateStore {
  constructor({ file, log = () => {} } = {}) {
    if (!file) throw new Error("window threshold state file is required");
    this.file = file;
    this.log = log;
    this.state = this.#load();
  }

  forSession(sessionId) {
    if (!validSessionId(sessionId) || this.state?.sessionId !== sessionId) return { ...EMPTY };
    return {
      tracked: true,
      warned: this.state.warned === true,
      archived: this.state.archived === true,
    };
  }

  save(sessionId, { warned = false, archived = false } = {}) {
    if (!validSessionId(sessionId)) return false;
    const next = {
      version: 1,
      sessionId,
      warned: warned === true,
      archived: archived === true,
      updatedAt: new Date().toISOString(),
    };
    const dir = path.dirname(this.file);
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(temp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
      fs.renameSync(temp, this.file);
      this.state = next;
      return true;
    } catch (error) {
      this.log("[window-state] save failed", error?.message || String(error));
      try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch {}
      return false;
    }
  }

  reset(sessionId) {
    return this.save(sessionId, { warned: false, archived: false });
  }

  #load() {
    try {
      const state = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (state?.version !== 1 || !validSessionId(state.sessionId)) return null;
      return state;
    } catch {
      return null;
    }
  }
}
