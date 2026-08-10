import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearSessionState,
  loadSessionState,
  nativeResumeDefinitelyRejected,
  restoreMissingSessionTranscript,
  restoreRejectedSessionTranscript,
  saveSessionState,
  sessionFingerprint,
  snapshotSessionTranscript,
  validSessionId,
} from "../session-state.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

test("only explicit Claude Code session errors authorize transcript replacement", () => {
  assert.equal(nativeResumeDefinitelyRejected(
    `No conversation found with session ID: ${SESSION_ID}`,
  ), true);
  assert.equal(nativeResumeDefinitelyRejected("Failed to resume the conversation."), true);
  assert.equal(nativeResumeDefinitelyRejected("ETIMEDOUT connecting to Anthropic"), false);
  assert.equal(nativeResumeDefinitelyRejected("authentication temporarily unavailable"), false);
});

test("session fingerprint changes with model or system prompt", () => {
  const base = sessionFingerprint("opus", "system-a");
  assert.equal(base, sessionFingerprint("opus", "system-a"));
  assert.notEqual(base, sessionFingerprint("sonnet", "system-a"));
  assert.notEqual(base, sessionFingerprint("opus", "system-b"));
});

test("native session state is atomic, scoped to its fingerprint, and clearable", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kelivo-session-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "nested", "state.json");
  const fingerprint = sessionFingerprint("opus", "system");

  assert.equal(saveSessionState(file, { sessionId: SESSION_ID, fingerprint }), true);
  assert.equal(loadSessionState(file, fingerprint)?.sessionId, SESSION_ID);
  assert.equal(loadSessionState(file, sessionFingerprint("opus", "changed")), null);
  assert.equal(clearSessionState(file), true);
  assert.equal(loadSessionState(file, fingerprint), null);
});

test("malformed session IDs are never persisted or resumed", () => {
  assert.equal(validSessionId(SESSION_ID), true);
  assert.equal(validSessionId("../../not-a-session"), false);
  assert.equal(saveSessionState("/tmp/unused", {
    sessionId: "bad", fingerprint: "fingerprint",
  }), false);
});

test("rolling transcript snapshot restores only a missing native transcript", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kelivo-transcript-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configDir = path.join(dir, ".claude");
  const backupDir = path.join(dir, "backups");
  const transcript = path.join(configDir, "projects", "src", `${SESSION_ID}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, "{\"type\":\"user\"}\n");

  assert.equal(snapshotSessionTranscript({
    configDir, sessionId: SESSION_ID, backupDir, maxBackups: 3,
  }), true);
  assert.equal(restoreMissingSessionTranscript({ configDir, sessionId: SESSION_ID, backupDir }), false);
  fs.unlinkSync(transcript);
  assert.equal(restoreMissingSessionTranscript({ configDir, sessionId: SESSION_ID, backupDir }), true);
  assert.equal(fs.readFileSync(transcript, "utf8"), "{\"type\":\"user\"}\n");
});

test("resume rejection preserves the suspect transcript and retries the same session from backup", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kelivo-rejected-session-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configDir = path.join(dir, ".claude");
  const backupDir = path.join(dir, "backups");
  const projectDir = path.join(configDir, "projects", "src");
  const transcript = path.join(projectDir, `${SESSION_ID}.jsonl`);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(transcript, "{\"type\":\"user\",\"message\":\"完整经历\"}\n");
  assert.equal(snapshotSessionTranscript({
    configDir, sessionId: SESSION_ID, backupDir, maxBackups: 3,
  }), true);

  fs.writeFileSync(transcript, "{损坏但可能更新的现场\n");
  assert.equal(restoreRejectedSessionTranscript({ configDir, sessionId: SESSION_ID, backupDir }), true);
  assert.equal(fs.readFileSync(transcript, "utf8"), "{\"type\":\"user\",\"message\":\"完整经历\"}\n");
  const quarantined = fs.readdirSync(projectDir)
    .find((name) => name.startsWith(`${SESSION_ID}.jsonl.resume-rejected-`));
  assert.ok(quarantined);
  assert.equal(fs.readFileSync(path.join(projectDir, quarantined), "utf8"), "{损坏但可能更新的现场\n");
});

test("checksum failure prevents a damaged rolling copy from replacing the session", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kelivo-bad-backup-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configDir = path.join(dir, ".claude");
  const backupDir = path.join(dir, "backups");
  const transcript = path.join(configDir, "projects", "src", `${SESSION_ID}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, "{\"type\":\"user\"}\n");
  assert.equal(snapshotSessionTranscript({
    configDir, sessionId: SESSION_ID, backupDir, maxBackups: 3,
  }), true);
  const backup = fs.readdirSync(backupDir).find((name) => name.endsWith(".jsonl"));
  fs.appendFileSync(path.join(backupDir, backup), "damaged\n");
  fs.unlinkSync(transcript);
  assert.equal(restoreMissingSessionTranscript({ configDir, sessionId: SESSION_ID, backupDir }), false);
  assert.equal(fs.existsSync(transcript), false);
});
