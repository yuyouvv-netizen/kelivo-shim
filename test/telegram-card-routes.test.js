import test from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import express from "express";

import { registerTelegramCardRoutes, TelegramCardStore } from "../telegram-cards.js";

function signedInitData({ token, userId, authDate = Math.floor(Date.now() / 1000) }) {
  const entries = [
    ["auth_date", String(authDate)],
    ["query_id", "private-query"],
    ["user", JSON.stringify({ id: userId, first_name: "又又" })],
  ];
  const check = entries.slice().sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(token).digest();
  const hash = crypto.createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams([...entries, ["hash", hash]]).toString();
}

test("card page keeps private text server-side until Telegram identity is verified", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-card-route-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const token = "123456:private-token";
  const chatId = 8012;
  const store = new TelegramCardStore({ dir: root });
  const card = store.create({ title: "虞克的碎碎念", body: "只有配对的人能看到", chatId });
  const app = express();
  registerTelegramCardRoutes(app, {
    getStore: () => store,
    getBotToken: () => token,
    getPairedChatId: () => chatId,
    json: express.json,
  });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const shell = await fetch(`${base}/telegram/card/${card.id}`);
  assert.equal(shell.status, 200);
  const html = await shell.text();
  assert.match(html, /正在拆开这张纸条/);
  assert.match(html, /\/telegram\/card-art\/rabbits\.webp/);
  assert.doesNotMatch(html, /只有配对的人能看到/);
  assert.equal(shell.headers.get("cache-control"), "no-store");

  const art = await fetch(`${base}/telegram/card-art/rabbits.webp`);
  assert.equal(art.status, 200);
  assert.equal(art.headers.get("content-type"), "image/webp");
  assert.ok((await art.arrayBuffer()).byteLength > 10_000);

  const denied = await fetch(`${base}/telegram/card/${card.id}/open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ initData: signedInitData({ token, userId: 9999 }) }),
  });
  assert.equal(denied.status, 401);

  const allowed = await fetch(`${base}/telegram/card/${card.id}/open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ initData: signedInitData({ token, userId: chatId }) }),
  });
  assert.equal(allowed.status, 200);
  assert.deepEqual((await allowed.json()).card.body, "只有配对的人能看到");
});
