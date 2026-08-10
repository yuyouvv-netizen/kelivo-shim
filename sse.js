import { randomUUID } from "crypto";

export const DEFAULT_SSE_HEARTBEAT_MS = 15 * 1000;
export const MIN_SSE_HEARTBEAT_MS = 1000;
export const MAX_SSE_HEARTBEAT_MS = 60 * 1000;

export function sseHeartbeatMsFromEnv(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return DEFAULT_SSE_HEARTBEAT_MS;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_SSE_HEARTBEAT_MS;
  if (value === 0) return 0;
  return Math.min(MAX_SSE_HEARTBEAT_MS, Math.max(MIN_SSE_HEARTBEAT_MS, Math.round(value)));
}

// Flush the HTTP headers before Claude starts working, then keep the otherwise
// silent SSE connection alive while WebSearch/WebFetch/MCP tools are running.
// Comments are valid SSE frames and are ignored by Anthropic-compatible clients.
export function createAnthropicSSE(res, {
  model,
  forwardThinking = true,
  heartbeatMs = DEFAULT_SSE_HEARTBEAT_MS,
  setTimer = setInterval,
  clearTimer = clearInterval,
  makeId = randomUUID,
} = {}) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  res.socket?.setKeepAlive?.(true);

  let ended = false;
  let heartbeat = null;
  const write = (chunk) => {
    if (ended || res.destroyed || res.writableEnded) return false;
    try { return res.write(chunk); } catch { return false; }
  };
  const send = (event, data) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const stopHeartbeat = () => {
    if (heartbeat !== null) clearTimer(heartbeat);
    heartbeat = null;
  };
  const clientClosed = () => { ended = true; stopHeartbeat(); };
  res.once?.("close", clientClosed);
  res.once?.("error", clientClosed);
  write(": connected\n\n");
  if (heartbeatMs > 0) {
    heartbeat = setTimer(() => write(": keep-alive\n\n"), heartbeatMs);
    heartbeat?.unref?.();
  }

  const msgId = "msg_" + makeId().replace(/-/g, "").slice(0, 24);
  let started = false, cur = null, idx = -1;

  function ensureStart() {
    if (started || ended) return;
    started = true;
    send("message_start", {
      type: "message_start",
      message: {
        id: msgId, type: "message", role: "assistant", model,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }
  function closeBlock() {
    if (cur === null || ended) return;
    send("content_block_stop", { type: "content_block_stop", index: idx });
    cur = null;
  }
  function open(kind) {
    if (cur === kind || ended) return;
    closeBlock();
    idx += 1;
    cur = kind;
    const contentBlock = kind === "thinking"
      ? { type: "thinking", thinking: "" }
      : { type: "text", text: "" };
    send("content_block_start", {
      type: "content_block_start", index: idx, content_block: contentBlock,
    });
  }

  return {
    isConnected() { return !ended && !res.destroyed && !res.writableEnded; },
    text(text) {
      if (!text || ended) return;
      ensureStart(); open("text");
      send("content_block_delta", {
        type: "content_block_delta", index: idx,
        delta: { type: "text_delta", text },
      });
    },
    thinking(thinking) {
      if (!forwardThinking || !thinking || ended) return;
      ensureStart(); open("thinking");
      send("content_block_delta", {
        type: "content_block_delta", index: idx,
        delta: { type: "thinking_delta", thinking },
      });
    },
    finish(usage) {
      if (ended) return false;
      ensureStart(); closeBlock();
      send("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: usage || { output_tokens: 0 },
      });
      send("message_stop", { type: "message_stop" });
      ended = true;
      stopHeartbeat();
      try { res.end(); } catch {}
      return true;
    },
  };
}
