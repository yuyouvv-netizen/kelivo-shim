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
const argsFile = process.env.FAKE_CLAUDE_ARGS_FILE;
const model = flag("--model") || "claude-opus-4-6";
const send = (value) => process.stdout.write(JSON.stringify({ ...value, session_id: sessionId }) + "\n");

if (argsFile) fs.appendFileSync(argsFile, JSON.stringify(args) + "\n");
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
  if (process.env.FAKE_CLAUDE_EMPTY_SUCCESS === "1") {
    setTimeout(() => send({
      type: "result",
      subtype: "success",
      is_error: false,
      terminal_reason: "completed",
      result: "",
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
      },
    }), 20);
    return;
  }
  if (process.env.FAKE_CLAUDE_API_ERROR === "1") {
    setTimeout(() => send({
      type: "result",
      subtype: "success",
      is_error: true,
      api_error_status: 429,
      terminal_reason: "api_error",
      result: "rate limit reached",
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
      },
    }), 20);
    return;
  }
  setTimeout(() => {
    send({
      type: "stream_event",
      event: {
        type: "message_start",
        message: { model, usage: { input_tokens: 10, cache_read_input_tokens: 0 } },
      },
    });
    let textIndex = 0;
    if (process.env.FAKE_CLAUDE_THINKING === "1") {
      send({
        type: "stream_event",
        event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      });
      send({
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "我在核对。" } },
      });
      send({
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signed-upstream-thinking" } },
      });
      send({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
      textIndex = 1;
    }
    send({
      type: "stream_event",
      event: { type: "content_block_start", index: textIndex, content_block: { type: "text", text: "" } },
    });
    send({
      type: "stream_event",
      event: { type: "content_block_delta", index: textIndex, delta: { type: "text_delta", text: "原来那封联网回复" } },
    });
    send({ type: "stream_event", event: { type: "content_block_stop", index: textIndex } });
    send({
      type: "result", subtype: "success", is_error: false,
      api_error_status: null, terminal_reason: "completed",
      usage: { output_tokens: 8 },
    });
  }, 150);
});
