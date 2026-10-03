import test from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

import {
  formatTelegramCardReceipt,
  normalizeTelegramCardBaseUrl,
  splitTelegramCardSegments,
  TelegramCardStore,
  telegramCardPreview,
  validateTelegramInitData,
} from "../telegram-cards.js";

test("paper-note markers preserve surrounding reply order and optional titles", () => {
  assert.deepEqual(
    splitTelegramCardSegments("前面。\n\n[小纸条:没说出口的]\n藏起来。\n第二行。\n[/小纸条]\n\n后面。"),
    [
      { type: "text", content: "前面。\n\n" },
      { type: "card", title: "没说出口的", content: "藏起来。\n第二行。" },
      { type: "text", content: "\n\n后面。" },
    ],
  );
  assert.deepEqual(splitTelegramCardSegments("[小纸条]只有正文[/小纸条]"), [
    { type: "card", title: null, content: "只有正文" },
  ]);
  assert.deepEqual(splitTelegramCardSegments("[碎碎念]旧写法仍可拆开[/碎碎念]"), [
    { type: "card", title: null, content: "旧写法仍可拆开" },
  ]);
});

test("malformed or empty card markers never swallow reply text", () => {
  assert.deepEqual(splitTelegramCardSegments("[小纸条]没有结尾"), [
    { type: "text", content: "[小纸条]没有结尾" },
  ]);
  assert.deepEqual(splitTelegramCardSegments("[小纸条]   [/小纸条]"), [
    { type: "text", content: "[小纸条]   [/小纸条]" },
  ]);
});

test("card previews are compact, plain and Unicode-safe", () => {
  assert.equal(telegramCardPreview("**第一行**\n\n第二行"), "第一行 第二行");
  assert.equal(telegramCardPreview("兔".repeat(100), 6), "兔兔兔兔兔兔…");
  assert.equal(telegramCardPreview("🙂".repeat(10), 3), "🙂🙂🙂…");
});

test("only secure public card origins are accepted", () => {
  assert.equal(normalizeTelegramCardBaseUrl("https://demo.zeabur.app/path"), "https://demo.zeabur.app");
  assert.equal(normalizeTelegramCardBaseUrl("http://demo.test"), "");
  assert.equal(normalizeTelegramCardBaseUrl("not a url"), "");
});

test("temporary cards survive restart, stay paired and expire automatically", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-cards-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = Date.parse("2026-10-02T11:00:00Z");
  const first = new TelegramCardStore({ dir: root, ttlMs: 60_000, now: () => now });
  const card = first.create({ title: "一张纸条", body: "完整正文", chatId: 8012 });
  assert.ok(card?.id);
  assert.equal(fs.statSync(path.join(root, `${card.id}.json`)).mode & 0o777, 0o600);

  const restarted = new TelegramCardStore({ dir: root, ttlMs: 60_000, now: () => now });
  assert.equal(restarted.get(card.id, 8012)?.body, "完整正文");
  assert.equal(restarted.get(card.id, 9999), null);

  now += 60_001;
  assert.equal(restarted.get(card.id, 8012), null);
  assert.equal(fs.existsSync(path.join(root, `${card.id}.json`)), false);
});

test("paper-note actions are timestamped, claimed once and released only after known rejection", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-card-receipts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = Date.parse("2026-10-03T09:00:00Z"); // 10/03 17:00 in Singapore
  const store = new TelegramCardStore({ dir: root, now: () => now });
  const card = store.create({ title: "第一张正式的", body: "慢慢拆。", chatId: 8012 });

  now = Date.parse("2026-10-06T18:11:00Z"); // 10/07 02:11 in Singapore
  assert.ok(store.markOpened(card.id, 8012));
  const openedAt = store.get(card.id, 8012).openedAt;
  now += 60_000;
  assert.equal(store.markOpened(card.id, 8012).openedAt, openedAt);

  const firstClaim = store.claimPendingReceipts(8012);
  assert.equal(firstClaim.events.length, 1);
  assert.match(firstClaim.text, /10\/07 02:11，又又拆开了 10\/03 的《第一张正式的》/);
  assert.equal(store.claimPendingReceipts(8012).events.length, 0);

  assert.equal(store.releaseReceiptClaim(firstClaim), true);
  const secondClaim = store.claimPendingReceipts(8012);
  assert.equal(secondClaim.events.length, 1);
  assert.equal(store.finalizeReceiptClaim(secondClaim), true);
  assert.equal(store.claimPendingReceipts(8012).events.length, 0);

  now += 60_000;
  assert.ok(store.markHearted(card.id, 8012));
  now += 60_000;
  assert.equal(store.recordReply(card.id, 8012, "我也想你。").created, true);
  assert.equal(store.recordReply(card.id, 8012, "我也想你。").created, false);
  assert.equal(store.recordReply(card.id, 8012, "第二封回信").reason, "already-replied");
  const replyClaim = store.claimPendingReceipts(8012);
  assert.deepEqual(replyClaim.events.map((event) => event.type), ["hearted", "replied"]);
  assert.match(replyClaim.text, /又又为《第一张正式的》点亮了心/);
  assert.match(replyClaim.text, /又又回复了《第一张正式的》：“我也想你。”/);
});

test("receipt formatter keeps events in chronological Singapore time", () => {
  const text = formatTelegramCardReceipt([
    { type: "replied", at: "2026-10-03T09:09:00Z", createdAt: "2026-10-03T09:00:00Z", title: "纸条", reply: "收到" },
    { type: "opened", at: "2026-10-03T09:04:00Z", createdAt: "2026-10-03T09:00:00Z", title: "纸条" },
  ]);
  assert.equal(text, "【小纸条回执】\n10/03 17:04，又又拆开了《纸条》。\n10/03 17:09，又又回复了《纸条》：“收到”");
});

function signedInitData({ token, userId, authDate }) {
  const entries = [
    ["auth_date", String(authDate)],
    ["query_id", "AAHdF6IQAAAAAN0XohDhrOrc"],
    ["user", JSON.stringify({ id: userId, first_name: "又又" })],
  ];
  const check = entries
    .slice()
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(token).digest();
  const hash = crypto.createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams([...entries, ["hash", hash]]).toString();
}

test("Mini App init data must be signed, fresh and belong to the paired user", () => {
  const token = "123456:private-token";
  const nowMs = Date.parse("2026-10-02T11:00:00Z");
  const authDate = Math.floor(nowMs / 1000) - 30;
  const initData = signedInitData({ token, userId: 8012, authDate });
  assert.equal(validateTelegramInitData(initData, {
    botToken: token,
    expectedUserId: 8012,
    nowMs,
  }).ok, true);
  assert.equal(validateTelegramInitData(initData, {
    botToken: token,
    expectedUserId: 9999,
    nowMs,
  }).ok, false);
  assert.equal(validateTelegramInitData(`${initData}x`, {
    botToken: token,
    expectedUserId: 8012,
    nowMs,
  }).ok, false);
  assert.equal(validateTelegramInitData(signedInitData({
    token, userId: 8012, authDate: authDate - 7200,
  }), {
    botToken: token,
    expectedUserId: 8012,
    nowMs,
  }).ok, false);
});
