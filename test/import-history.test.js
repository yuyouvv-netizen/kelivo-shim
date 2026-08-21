import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { ImportHistoryStore, mergeImportedMessages, normalizeImportedMessages } from "../import-history.js";

test("normalizes text blocks and roles", () => {
  assert.deepEqual(normalizeImportedMessages({ messages: [
    { role: "system", content: "drop" },
    { role: "user", content: " hi " },
    { role: "assistant", content: [{ type: "text", text: "there" }] },
  ] }), [
    { role: "user", content: "hi" },
    { role: "assistant", content: "there" },
  ]);
});

test("prepends imported turns before current Kelivo messages", () => {
  const merged = mergeImportedMessages({ messages: [
    { role: "user", content: "old u" }, { role: "assistant", content: "old a" },
  ] }, [{ role: "user", content: "new u" }]);
  assert.equal(merged.length, 3);
  assert.equal(merged[2].content, "new u");
});

test("prepare backs up session pointer and consume is one-shot", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "import-history-"));
  const state = path.join(root, "claude-state", "shim-session.json");
  fs.mkdirSync(path.dirname(state), { recursive: true });
  fs.writeFileSync(state, "{\"id\":\"old\"}\n");
  const store = new ImportHistoryStore({ dir: path.join(root, "imports"), sessionStateFile: state });
  const status = store.prepare({ messages: [
    { role: "user", content: "one" }, { role: "assistant", content: "two" },
  ] });
  assert.equal(status.state, "pending");
  assert.equal(fs.existsSync(state), false);
  assert.equal(fs.existsSync(path.join(root, "imports", "pre-import-session.json")), true);
  assert.equal(store.consume().messages.length, 2);
  assert.equal(store.consume(), null);
  assert.equal(store.status().state, "consumed");
});

test("pending import deletes a session pointer recreated during shutdown", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "import-history-"));
  const state = path.join(root, "claude-state", "shim-session.json");
  fs.mkdirSync(path.dirname(state), { recursive: true });
  fs.writeFileSync(state, "{\"id\":\"old\"}\n");
  const store = new ImportHistoryStore({ dir: path.join(root, "imports"), sessionStateFile: state });
  store.prepare({ messages: [
    { role: "user", content: "one" }, { role: "assistant", content: "two" },
  ] });
  fs.writeFileSync(state, "{\"id\":\"old-written-again\"}\n");
  assert.equal(store.ensureFreshSession(), true);
  assert.equal(fs.existsSync(state), false);
  assert.match(fs.readFileSync(path.join(root, "imports", "pre-import-session.json"), "utf8"), /\"old\"/);
});

test("cancelling a pending import restores the previous session pointer when safe", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "import-history-"));
  const state = path.join(root, "claude-state", "shim-session.json");
  fs.mkdirSync(path.dirname(state), { recursive: true });
  fs.writeFileSync(state, "{\"id\":\"old\"}\n");
  const store = new ImportHistoryStore({ dir: path.join(root, "imports"), sessionStateFile: state });
  store.prepare({ messages: [
    { role: "user", content: "one" }, { role: "assistant", content: "two" },
  ] });
  assert.equal(fs.existsSync(state), false);
  store.clear();
  assert.equal(store.status().state, "cleared");
  assert.match(fs.readFileSync(state, "utf8"), /\"old\"/);
});
