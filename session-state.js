import fs from "fs";
import path from "path";
import { createHash } from "crypto";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validSessionId(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

const DEFINITE_RESUME_REJECTION = [
  /No conversation found with session ID:/i,
  /Session not found:/i,
  /--(?:print )?resume (?:session )?load failed/i,
  /loadConversationForResume failed/i,
  /Failed to resume (?:the )?(?:conversation|session)(?:\.|:|$)/i,
];

export function nativeResumeDefinitelyRejected(stderr) {
  const text = String(stderr || "");
  return DEFINITE_RESUME_REJECTION.some((pattern) => pattern.test(text));
}

export function sessionFingerprint(model, systemPrompt) {
  return createHash("sha256")
    .update(String(model || ""))
    .update("\0")
    .update(String(systemPrompt || ""))
    .digest("hex");
}

export function loadSessionState(file, fingerprint) {
  if (!file) return null;
  try {
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    if (state?.version !== 1 || !validSessionId(state.sessionId)) return null;
    if (state.fingerprint !== fingerprint) return null;
    return state;
  } catch {
    return null;
  }
}

export function saveSessionState(file, { sessionId, fingerprint }) {
  if (!file || !validSessionId(sessionId) || !fingerprint) return false;
  const dir = path.dirname(file);
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temp, JSON.stringify({
      version: 1, sessionId, fingerprint, updatedAt: new Date().toISOString(),
    }, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temp, file);
    return true;
  } catch {
    try { fs.unlinkSync(temp); } catch {}
    return false;
  }
}

export function clearSessionState(file) {
  if (!file) return true;
  try { fs.unlinkSync(file); return true; }
  catch (error) { return error?.code === "ENOENT"; }
}

function findTranscript(root, sessionId, depth = 0) {
  if (!root || depth > 5) return null;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return null; }
  const exact = entries.find((entry) => entry.isFile() && entry.name === `${sessionId}.jsonl`);
  if (exact) return path.join(root, exact.name);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findTranscript(path.join(root, entry.name), sessionId, depth + 1);
    if (found) return found;
  }
  return null;
}

function sha256File(file) {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function backupTarget(configDir, meta) {
  if (!meta?.sourceRelative || path.isAbsolute(meta.sourceRelative)) return null;
  const root = path.resolve(configDir);
  const target = path.resolve(root, meta.sourceRelative);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

function usableBackup(backupDir, meta) {
  const backup = path.join(backupDir, `${meta.base}.jsonl`);
  try {
    const stat = fs.statSync(backup);
    if (!stat.isFile() || stat.size === 0) return null;
    if (Number.isFinite(meta.bytes) && stat.size !== meta.bytes) return null;
    if (meta.sha256 && sha256File(backup) !== meta.sha256) return null;
    return backup;
  } catch {
    return null;
  }
}

function sessionBackups(backupDir, sessionId) {
  let names;
  try {
    names = fs.readdirSync(backupDir)
      .filter((name) => name.startsWith(`${sessionId}-`) && name.endsWith(".meta.json"))
      .sort().reverse();
  } catch {
    return [];
  }
  return names.map((name) => readBackupMeta(path.join(backupDir, name)))
    .filter((meta) => meta?.sessionId === sessionId);
}

export function snapshotSessionTranscript({ configDir, sessionId, backupDir, maxBackups = 1 }) {
  if (!(maxBackups > 0) || !validSessionId(sessionId)) return false;
  const source = findTranscript(path.join(configDir, "projects"), sessionId);
  if (!source) return false;
  try {
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = `${sessionId}-${stamp}`;
    const backup = path.join(backupDir, `${base}.jsonl`);
    fs.copyFileSync(source, backup);
    const bytes = fs.statSync(backup).size;
    const sha256 = sha256File(backup);
    fs.writeFileSync(path.join(backupDir, `${base}.meta.json`), JSON.stringify({
      version: 1,
      sessionId,
      sourceRelative: path.relative(configDir, source),
      bytes,
      sha256,
      createdAt: new Date().toISOString(),
    }, null, 2) + "\n", { mode: 0o600 });

    const metas = fs.readdirSync(backupDir)
      .filter((name) => name.startsWith(`${sessionId}-`) && name.endsWith(".meta.json"))
      .sort().reverse();
    for (const meta of metas.slice(maxBackups)) {
      const data = readBackupMeta(path.join(backupDir, meta));
      try { fs.unlinkSync(path.join(backupDir, meta)); } catch {}
      if (data?.base) try { fs.unlinkSync(path.join(backupDir, `${data.base}.jsonl`)); } catch {}
    }
    return true;
  } catch {
    return false;
  }
}

function readBackupMeta(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return { ...value, base: path.basename(file, ".meta.json") };
  } catch {
    return null;
  }
}

// Restore only when the original transcript is missing. Never overwrite an
// existing transcript: a partially written file may contain newer experience.
export function restoreMissingSessionTranscript({ configDir, sessionId, backupDir }) {
  if (!validSessionId(sessionId)) return false;
  if (findTranscript(path.join(configDir, "projects"), sessionId)) return false;
  for (const meta of sessionBackups(backupDir, sessionId)) {
    const backup = usableBackup(backupDir, meta);
    const target = backupTarget(configDir, meta);
    if (!backup || !target) continue;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.copyFileSync(backup, target, fs.constants.COPYFILE_EXCL);
      return true;
    } catch {}
  }
  return false;
}

// A resume rejection is different from a missing transcript: Claude Code saw
// the file but could not continue it. Preserve that newer suspect file beside
// the original path, then automatically retry the same native session from the
// newest verified rolling copy. Nothing is deleted and the session ID stays the
// same, so this recovery does not silently turn into a fresh 128-message chat.
export function restoreRejectedSessionTranscript({ configDir, sessionId, backupDir }) {
  if (!validSessionId(sessionId)) return false;
  for (const meta of sessionBackups(backupDir, sessionId)) {
    const backup = usableBackup(backupDir, meta);
    const target = backupTarget(configDir, meta);
    if (!backup || !target) continue;
    const current = findTranscript(path.join(configDir, "projects"), sessionId);
    if (current && path.resolve(current) !== path.resolve(target)) continue;
    const quarantine = `${target}.resume-rejected-${Date.now()}`;
    const targetExisted = fs.existsSync(target);
    let moved = false;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      if (targetExisted) {
        fs.renameSync(target, quarantine);
        moved = true;
      }
      fs.copyFileSync(backup, target, fs.constants.COPYFILE_EXCL);
      return true;
    } catch {
      if (!targetExisted || moved) try { fs.unlinkSync(target); } catch {}
      if (moved) try { fs.renameSync(quarantine, target); } catch {}
    }
  }
  return false;
}
