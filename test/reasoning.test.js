import test from "node:test";
import assert from "node:assert/strict";

import {
  effortFromBudget,
  effortLabel,
  normalizeClaudeEffort,
  reasoningForRequest,
} from "../reasoning.js";

test("Kelivo output_config effort reaches the Claude Code level", () => {
  assert.deepEqual(reasoningForRequest({
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: "high" },
  }, "claude-opus-4-6", "low"), {
    requested: "high",
    effective: "high",
    source: "kelivo-output-config",
    thinkingType: "adaptive",
  });
});

test("auto and missing client settings use the explicit server fallback", () => {
  assert.deepEqual(reasoningForRequest({
    thinking: { type: "adaptive" },
  }, "claude-opus-4-6", "medium"), {
    requested: "auto",
    effective: "medium",
    source: "kelivo-auto",
    thinkingType: "adaptive",
  });
  assert.equal(reasoningForRequest({}, "claude-opus-4-6", "low").effective, "low");
});

test("legacy budgets map to CLI effort and 4.6 xhigh safely becomes max", () => {
  assert.equal(effortFromBudget(1024, "claude-opus-4-6"), "low");
  assert.equal(effortFromBudget(16000, "claude-opus-4-6"), "medium");
  assert.equal(effortFromBudget(32000, "claude-opus-4-6"), "high");
  assert.equal(effortFromBudget(64000, "claude-opus-4-6"), "max");
  assert.equal(normalizeClaudeEffort("xhigh", "claude-opus-4-8"), "xhigh");
});

test("off is honest about Claude Code's minimum effective level", () => {
  const result = reasoningForRequest({ thinking: { type: "disabled" } }, "claude-opus-4-6", "high");
  assert.equal(result.requested, "off");
  assert.equal(result.effective, "low");
  assert.equal(effortLabel(result.effective), "轻度");
});
