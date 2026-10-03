import test from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

import {
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
