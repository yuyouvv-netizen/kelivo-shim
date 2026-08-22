import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildSystemPrompt,
  DEFAULT_SYSTEM_PROMPT_MODE,
  normalizeSystemPromptMode,
  systemPromptArgs,
} from "../system-prompt.js";

test("system prompt replacement is the safe default", () => {
  assert.equal(DEFAULT_SYSTEM_PROMPT_MODE, "replace");
  assert.equal(normalizeSystemPromptMode(), "replace");
  assert.equal(normalizeSystemPromptMode("replace"), "replace");
  assert.equal(normalizeSystemPromptMode("unexpected"), "replace");
});

test("append mode remains available as an explicit rollback", () => {
  assert.equal(normalizeSystemPromptMode(" append "), "append");
  assert.equal(normalizeSystemPromptMode("APPEND"), "append");
  assert.deepEqual(systemPromptArgs("append", "hello"), [
    "--append-system-prompt",
    "hello",
  ]);
});

test("replacement mode uses the Claude CLI system prompt flag", () => {
  assert.deepEqual(systemPromptArgs(undefined, "hello"), [
    "--system-prompt",
    "hello",
  ]);
});

test("prompt builder keeps the base prompt, continuity and worldbook ordered", () => {
  assert.equal(buildSystemPrompt({
    basePrompt: "identity",
    memoryContinuityRule: "memory",
    kelivoSystem: "world",
  }), [
    "identity",
    "memory",
    "【场景设定/世界书】\nworld",
  ].join("\n\n"));
});

test("prompt builder omits empty optional sections", () => {
  assert.equal(buildSystemPrompt({
    basePrompt: "identity",
    memoryContinuityRule: undefined,
    kelivoSystem: "  ",
  }), "identity");
});
