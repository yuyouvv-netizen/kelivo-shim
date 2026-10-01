// Presentation markers shown inside Markdown code are examples, not commands.
// Telegram replies only need fenced blocks and ordinary one-backtick inline
// code protected from voice/sticker parsing.
export function markdownCodeRanges(value) {
  const text = String(value || "");
  const ranges = [];
  for (const match of text.matchAll(/```[\s\S]*?```|`[^`\n]*`/g)) {
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

export function markdownCodeContains(ranges, position) {
  return ranges.some(([start, end]) => position >= start && position < end);
}
