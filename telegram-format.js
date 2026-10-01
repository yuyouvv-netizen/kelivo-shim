const HTML_ESCAPE_RE = /[&<>]/g;
const HTML_ESCAPES = Object.freeze({ "&": "&amp;", "<": "&lt;", ">": "&gt;" });

export function telegramTextToHtml(value) {
  const escaped = String(value || "").replace(HTML_ESCAPE_RE, (char) => HTML_ESCAPES[char]);
  return escaped.replace(/\*\*([^*]+?)\*\*/g, "<b>$1</b>");
}

export function telegramParagraphBubbles(value, max = 8) {
  const text = String(value || "").replace(/\r\n?/g, "\n").trim();
  if (!text) return [];
  const paragraphs = text.split(/\n[ \t]*\n+/).map((part) => part.trim()).filter(Boolean);
  if (paragraphs.length <= 1) return [text];

  // A visual divider belongs to the paragraph before it; it should never
  // become a tiny standalone bubble.
  const grouped = [];
  for (const paragraph of paragraphs) {
    if (/^[—–=_*-]{2,}$/.test(paragraph) && grouped.length) {
      grouped[grouped.length - 1] += `\n\n${paragraph}`;
    } else {
      grouped.push(paragraph);
    }
  }

  const limit = Math.max(1, Math.min(20, Number(max) || 8));
  if (grouped.length <= limit) return grouped;
  return [...grouped.slice(0, limit - 1), grouped.slice(limit - 1).join("\n\n")];
}
