export const CLAUDE_EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

function cleanEffort(value) {
  const effort = typeof value === "string" ? value.trim().toLowerCase() : "";
  return CLAUDE_EFFORT_LEVELS.has(effort) ? effort : null;
}

export function normalizeClaudeEffort(value, model = "", fallback = "low") {
  let effort = cleanEffort(value) || cleanEffort(fallback) || "low";
  const id = String(model).trim().toLowerCase();

  // Kelivo already applies Anthropic's model-specific mapping. Keep this
  // guard for older/custom clients so an unsupported 4.6 xhigh value cannot
  // make Claude Code exit before the turn starts.
  if (effort === "xhigh" && /claude-(?:opus|sonnet)-4[-.]6(?:$|[._:@/\-])/.test(id)) {
    effort = "max";
  }
  return effort;
}

export function effortFromBudget(value, model = "", fallback = "low") {
  const budget = Number(value);
  if (!Number.isFinite(budget) || budget <= 0) {
    return normalizeClaudeEffort(fallback, model, "low");
  }
  const effort = budget <= 2000 ? "low"
    : budget <= 20000 ? "medium"
      : budget <= 32000 ? "high"
        : budget <= 64000 ? "xhigh" : "max";
  return normalizeClaudeEffort(effort, model, fallback);
}

// Kelivo's Anthropic provider sends adaptive thinking plus
// output_config.effort. Older releases may send a fixed budget instead.
// Claude Code has no "off" CLI level, so off is made explicit in the receipt
// while the process uses its minimum supported level.
export function reasoningForRequest(body = {}, model = "", fallback = "low") {
  const safeFallback = normalizeClaudeEffort(fallback, model, "low");
  const thinking = body?.thinking && typeof body.thinking === "object" ? body.thinking : {};
  const thinkingType = typeof thinking.type === "string" ? thinking.type.trim().toLowerCase() : null;
  const outputEffort = cleanEffort(body?.output_config?.effort);

  if (outputEffort) {
    return {
      requested: outputEffort,
      effective: normalizeClaudeEffort(outputEffort, model, safeFallback),
      source: "kelivo-output-config",
      thinkingType,
    };
  }

  if (thinkingType === "disabled") {
    return {
      requested: "off",
      effective: "low",
      source: "kelivo-disabled-cli-minimum",
      thinkingType,
    };
  }

  if (Number(thinking.budget_tokens) > 0) {
    return {
      requested: effortFromBudget(thinking.budget_tokens, model, safeFallback),
      effective: effortFromBudget(thinking.budget_tokens, model, safeFallback),
      source: "kelivo-thinking-budget",
      thinkingType,
    };
  }

  return {
    requested: thinkingType === "adaptive" ? "auto" : null,
    effective: safeFallback,
    source: thinkingType === "adaptive" ? "kelivo-auto" : "server-default",
    thinkingType,
  };
}

export function effortLabel(value) {
  return ({
    off: "关闭", auto: "自动", low: "轻度", medium: "中度",
    high: "重度", xhigh: "极限", max: "全力",
  })[value] || "未携带";
}
