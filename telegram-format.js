const HTML_ESCAPE_RE = /[&<>]/g;
const HTML_ESCAPES = Object.freeze({ "&": "&amp;", "<": "&lt;", ">": "&gt;" });

export function telegramTextToHtml(value) {
  const escaped = String(value || "").replace(HTML_ESCAPE_RE, (char) => HTML_ESCAPES[char]);
  return escaped.replace(/\*\*([^*]+?)\*\*/g, "<b>$1</b>");
}

export function telegramTextToPlain(value) {
  return String(value || "").replace(/\*\*([^*]+?)\*\*/g, "$1");
}

export function isTelegramHtmlParseError(response) {
  if (response?.ok !== false || Number(response?.error_code) !== 400) return false;
  return /parse entities|can't parse|unsupported start tag|unclosed start tag|wrong entity/i
    .test(String(response?.description || ""));
}

function boldRanges(text) {
  const ranges = [];
  for (const match of text.matchAll(/\*\*[^*]+?\*\*/g)) {
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

function outsideBold(position, ranges) {
  return !ranges.some(([start, end]) => position > start && position < end);
}

function sentenceBreakPositions(text, ranges = boldRanges(text)) {
  const positions = [];
  const endings = /[。！？!?；;](?:[”’"」』）)\]]|\*\*)*/g;
  for (const match of text.matchAll(endings)) {
    const position = match.index + match[0].length;
    if (outsideBold(position, ranges)) positions.push(position);
  }
  return positions;
}

function lastFittingBreak(text, positions, limit) {
  let chosen = 0;
  for (const position of positions) {
    if (position >= text.length) continue;
    if (telegramTextToPlain(text.slice(0, position)).length <= limit) chosen = position;
    else break;
  }
  return chosen;
}

// The reading layer normally keeps every bubble small. This is a final Bot API
// transport guard: prefer paragraph/newline boundaries, then a complete
// sentence, and never cut through a paired **bold** span.
export function telegramTransportChunks(value, max = 4000) {
  let remaining = String(value || "").replace(/\r\n?/g, "\n");
  if (!remaining) return [];
  const limit = Math.max(256, Math.min(4096, Number(max) || 4000));
  const chunks = [];

  while (telegramTextToPlain(remaining).length > limit) {
    const ranges = boldRanges(remaining);
    const paragraphBreaks = [...remaining.matchAll(/\n{2,}/g)]
      .map((match) => match.index + match[0].length)
      .filter((position) => outsideBold(position, ranges));
    const lineBreaks = [...remaining.matchAll(/\n/g)]
      .map((match) => match.index + 1)
      .filter((position) => outsideBold(position, ranges));
    const sentenceBreaks = sentenceBreakPositions(remaining, ranges);
    const cut = lastFittingBreak(remaining, paragraphBreaks, limit)
      || lastFittingBreak(remaining, lineBreaks, limit)
      || lastFittingBreak(remaining, sentenceBreaks, limit);
    if (!cut) {
      const error = new RangeError("Telegram text has no safe transport boundary");
      error.code = "TELEGRAM_UNBREAKABLE_TEXT";
      throw error;
    }
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
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
  const breaks = sentenceBreakPositions(paragraph);
  const sentences = [];
  let start = 0;
  for (const end of breaks) {
    const sentence = paragraph.slice(start, end).trim();
    if (sentence) sentences.push(sentence);
    start = end;
  }
  const tail = paragraph.slice(start).trim();
  if (tail) sentences.push(tail);
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
