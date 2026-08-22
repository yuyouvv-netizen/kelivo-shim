export const DEFAULT_SYSTEM_PROMPT_MODE = "append";

export function normalizeSystemPromptMode(raw) {
  const mode = String(raw || "").trim().toLowerCase();
  return mode === "append" || mode === "replace"
    ? mode
    : DEFAULT_SYSTEM_PROMPT_MODE;
}

export function buildSystemPrompt({
  basePrompt,
  memoryContinuityRule,
  kelivoSystem,
}) {
  const sections = [basePrompt, memoryContinuityRule]
    .map((section) => String(section || "").trim())
    .filter(Boolean);
  const worldbook = String(kelivoSystem || "").trim();
  if (worldbook) sections.push(`【场景设定/世界书】\n${worldbook}`);
  return sections.join("\n\n");
}

export function systemPromptArgs(mode, prompt) {
  return [
    normalizeSystemPromptMode(mode) === "append"
      ? "--append-system-prompt"
      : "--system-prompt",
    prompt,
  ];
}
