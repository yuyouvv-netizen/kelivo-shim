#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const sessionId = flag("--session-id") || flag("--resume") || "11111111-1111-4111-8111-111111111111";
const countFile = process.env.FAKE_CLAUDE_COUNT_FILE;
const inputFile = process.env.FAKE_CLAUDE_INPUT_FILE;
const send = (value) => process.stdout.write(JSON.stringify({ ...value, session_id: sessionId }) + "\n");

send({ type: "system", subtype: "init" });
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.type !== "user") return;
  if (countFile) fs.appendFileSync(countFile, "turn\n");
  if (inputFile) fs.appendFileSync(inputFile, JSON.stringify(message.message?.content ?? "") + "\n");
  if (process.env.FAKE_CLAUDE_EXIT_ON_TURN === "1") {
    setTimeout(() => process.exit(23), 20);
    return;
  }
  setTimeout(() => {
    send({
      type: "stream_event",
      event: { type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 0 } } },
    });
    send({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    });
    send({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "原来那封联网回复" } },
    });
    send({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
    send({ type: "result", subtype: "success", usage: { output_tokens: 8 } });
  }, 150);
});
