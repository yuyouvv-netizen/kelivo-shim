import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import {
  normalizeTelegramId,
  normalizeTelegramPairCode,
  parseTelegramPairCommand,
  TelegramStateStore,
  telegramPairCodeMatches,
} from "../telegram-state.js";

test("Telegram ids accept private and supergroup ranges but reject unsafe values", () => {
  assert.equal(normalizeTelegramId("123456789"), 123456789);
  assert.equal(normalizeTelegramId("-1001234567890"), -1001234567890);
  assert.equal(normalizeTelegramId(""), null);
  assert.equal(normalizeTelegramId("not-an-id"), null);
  assert.equal(normalizeTelegramId(Number.MAX_SAFE_INTEGER + 1), null);
});

test("pairing commands accept Telegram start payloads without leaking partial matches", () => {
  assert.equal(parseTelegramPairCommand("/start secret-code"), "secret-code");
  assert.equal(parseTelegramPairCommand("/pair@private_bot  secret-code  "), "secret-code");
  assert.equal(parseTelegramPairCommand("/start"), null);
  assert.equal(parseTelegramPairCommand("hello secret-code"), null);
  assert.equal(telegramPairCodeMatches("secret-code", "secret-code"), true);
  assert.equal(telegramPairCodeMatches("secret", "secret-code"), false);
});

test("pairing codes enforce Telegram-safe deep-link secrets", () => {
  const safe = "A_secure-code_123456789";
  assert.equal(normalizeTelegramPairCode(`  ${safe}  `), safe);
  assert.equal(normalizeTelegramPairCode("too-short"), "");
  assert.equal(normalizeTelegramPairCode("sixteen chars!!!"), "");
  assert.equal(normalizeTelegramPairCode("x".repeat(65)), "");
});

test("pairing identity and update receipts persist atomically", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "private", "telegram.json");
  const first = new TelegramStateStore({ file });
  assert.equal(first.bindBot(7001), true);
  assert.equal(first.pair(8002), true);
  assert.equal(first.acceptUpdate(41), true);
  assert.equal(first.hasSeen(41), true);
  assert.equal(first.hasSeen(42), false);
  assert.equal(first.acceptUpdate(41), false);
  assert.equal(first.acceptUpdate(40), false);
  assert.equal(first.nextOffset(), 42);

  const restored = new TelegramStateStore({ file });
  assert.equal(restored.chatId(), 8002);
  assert.equal(restored.nextOffset(), 42);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("a different bot cannot inherit an old pairing or update offset", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "telegram.json");
  const store = new TelegramStateStore({ file });
  store.bindBot(1001);
  store.pair(2002);
  store.acceptUpdate(3003);

  assert.equal(store.bindBot(1002), true);
  assert.equal(store.chatId(), null);
  assert.equal(store.nextOffset(), 0);
});

test("an explicit chat id is authoritative across bot restarts", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "telegram.json");
  const store = new TelegramStateStore({ file, configuredChatId: "9009" });
  assert.equal(store.bindBot(1010), true);
  assert.equal(store.chatId(), 9009);
  assert.equal(store.pair(8008), false);
  assert.equal(store.pair(9009), true);
});

test("failed disk writes never become memory-only pairing or receipts", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const blocker = path.join(root, "not-a-directory");
  fs.writeFileSync(blocker, "x");
  const store = new TelegramStateStore({ file: path.join(blocker, "telegram.json") });
  assert.equal(store.bindBot(1010), false);
  assert.equal(store.status().botBound, false);
  assert.equal(store.pair(2020), false);
  assert.equal(store.acceptUpdate(1), false);
  assert.equal(store.nextOffset(), 0);
});
