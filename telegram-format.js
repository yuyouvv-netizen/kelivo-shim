const HTML_ESCAPE_RE = /[&<>]/g;
const HTML_ESCAPES = Object.freeze({ "&": "&amp;", "<": "&lt;", ">": "&gt;" });

export function telegramTextToHtml(value) {
  const escaped = String(value || "").replace(HTML_ESCAPE_RE, (char) => HTML_ESCAPES[char]);
  return escaped.replace(/\*\*([^*]+?)\*\*/g, "<b>$1</b>");
}

function telegramParagraphs(text) {
  const paragraphs = [];
  let lines = [];
  let fenced = false;
  const flush = () => {
    const paragraph = lines.join("\n").trim();
    if (paragraph) paragraphs.push(paragraph);
    lines = [];
  };

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) fenced = !fenced;
    // 虞克把独占一行的长破折号当视觉换行；Telegram 直接保留节奏，
    // 不把这条分隔线显示给又又。句内破折号和代码块内容不受影响。
    if (!fenced && /^[—–]{2,}$/.test(trimmed)) continue;
    if (!fenced && !trimmed) flush();
    else lines.push(line);
  }
  flush();
  return paragraphs;
}

function splitLongParagraph(paragraph, target, hardMax) {
  if (paragraph.length <= target || paragraph.includes("```")) return [paragraph];
  const sentences = paragraph.match(/[^。！？!?；;]+[。！？!?；;]+[”’"」』）)\]]*|[^。！？!?；;]+$/g)
    ?.map((part) => part.trim()).filter(Boolean) || [paragraph];
  if (sentences.length <= 1) return [paragraph];

  const chunks = [];
  let chunk = "";
  for (const sentence of sentences) {
    const joined = chunk ? `${chunk}${sentence}` : sentence;
    const nearTarget = chunk.length >= Math.round(target * 0.55);
    if (chunk && ((joined.length > target && nearTarget) || joined.length > hardMax)) {
      chunks.push(chunk);
      chunk = sentence;
    } else {
      chunk = joined;
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

function visibleTail(value) {
  return value.replace(/\*\*/g, "").trim().at(-1) || "";
}

function mergeSmallestNeighbours(parts, limit) {
  const merged = [...parts];
  while (merged.length > limit) {
    let best = 0;
    let bestLength = Infinity;
    for (let i = 0; i < merged.length - 1; i++) {
      const length = merged[i].length + merged[i + 1].length;
      if (length < bestLength) {
        best = i;
        bestLength = length;
      }
    }
    merged.splice(best, 2, `${merged[best]}\n\n${merged[best + 1]}`);
  }
  return merged;
}

export function telegramParagraphBubbles(value, max = 12, target = 260) {
  const text = String(value || "").replace(/\r\n?/g, "\n").trim();
  if (!text) return [];
  const paragraphs = telegramParagraphs(text);

  // Repair presentation-only breaks before deciding where a bubble ends.
  // Ellipses often sit inside one thought; dividers introduce the next one.
  const repaired = [];
  let prefix = "";
  let joinNext = false;
  for (const paragraph of paragraphs) {
    if (/^[…⋯.。]+$/.test(paragraph)) {
      if (repaired.length) {
        repaired[repaired.length - 1] += `\n\n${paragraph}`;
        joinNext = true;
      } else prefix += `${paragraph}\n\n`;
      continue;
    }
    if (/^[—–=_*-]{2,}$/.test(paragraph)) {
      prefix += `${paragraph}\n\n`;
      continue;
    }

    const current = `${prefix}${paragraph}`;
    prefix = "";
    const previous = repaired.at(-1);
    const previousLooksCut = previous
      && !/[。！？!?：:；;）)」』”’"】\]]/.test(visibleTail(previous));
    if (previous && (joinNext || previousLooksCut)) {
      repaired[repaired.length - 1] += `\n\n${current}`;
    } else {
      repaired.push(current);
    }
    joinNext = false;
  }
  if (prefix && repaired.length) repaired[repaired.length - 1] += `\n\n${prefix.trim()}`;
  else if (prefix) repaired.push(prefix.trim());

  const targetLength = Math.max(120, Math.min(800, Number(target) || 260));
  const hardMax = Math.min(1200, Math.round(targetLength * 1.65));
  const semanticParts = repaired.flatMap((paragraph) => (
    splitLongParagraph(paragraph, targetLength, hardMax)
  ));

  // Pack short adjacent thoughts into one small conversational bubble. A
  // normal paragraph remains intact; oversized prose is split at sentence ends.
  const bubbles = [];
  let bubble = "";
  for (const part of semanticParts) {
    const joined = bubble ? `${bubble}\n\n${part}` : part;
    if (bubble && joined.length > targetLength) {
      bubbles.push(bubble);
      bubble = part;
    } else {
      bubble = joined;
    }
  }
  if (bubble) bubbles.push(bubble);

  const limit = Math.max(1, Math.min(20, Number(max) || 12));
  return bubbles.length > limit ? mergeSmallestNeighbours(bubbles, limit) : bubbles;
}
