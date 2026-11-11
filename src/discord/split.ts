const DISCORD_MESSAGE_LIMIT = 2000;
const SAFE_MESSAGE_LIMIT = 1900;
const MAX_RESPONSE_MESSAGES = 6;
const MAX_SPLIT_REPAIR_LINES = 4;
const MAX_SPLIT_REPAIR_LINE_CHARS = 180;
/** The canonical `MESSAGE_SPLIT` marker, plus the `<split />` hint older adapters emit. */
const SPLIT_MARKER = /<\|message_split\|>|<split\s*\/?>/i;
const FENCE = /^([ \t]*)(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_TAIL = new RegExp(
  `^[ \\t]*(?:$|${SPLIT_MARKER.source})`,
  "i",
);
const PARAGRAPH_BREAK = /\n[ \t]*\n/;
/** Markdown whose line breaks are layout, never casual message boundaries. */
const STRUCTURED_MARKDOWN = [
  /^ {0,3}#{1,6}(?:[ \t]|$)/m, // ATX heading
  /^-#[ \t]/m, // Discord subtext
  /^.*\S.*\n {0,3}(?:=+|-+)[ \t]*$/m, // setext heading
  /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\S/m, // list item
  /^ {0,3}>/m, // blockquote
  /^(?: {2,}|\t)\S/m, // indented content
  /`|^[ \t]*~~~/m, // code
];

type Range = readonly [start: number, end: number];

/** Casual multi-line output with no explicit markers may ask the model to place them. */
export function needsSplitHintRepair(content: string): boolean {
  if (!content.trim()) return false;
  if (SPLIT_MARKER.test(content)) return false;
  if (STRUCTURED_MARKDOWN.some((pattern) => pattern.test(content))) {
    return false;
  }

  const nonEmptyLines = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    nonEmptyLines.length >= 2 &&
    nonEmptyLines.length <= MAX_SPLIT_REPAIR_LINES &&
    nonEmptyLines.every((line) => line.length <= MAX_SPLIT_REPAIR_LINE_CHARS)
  );
}

/**
 * Sends one Discord message per explicit marker outside code, keeping every
 * newline inside a message, then applies Discord's length and burst limits.
 */
export function splitDiscordResponse(content: string): string[] {
  const chunks = splitOnMarkers(content)
    .flatMap((chunk) => splitHardLimit(chunk.trim()))
    .filter(Boolean);
  return capResponseMessages(chunks);
}

function splitOnMarkers(content: string): string[] {
  const code = codeRanges(content);
  const chunks: string[] = [];
  let start = 0;

  for (const marker of content.matchAll(new RegExp(SPLIT_MARKER, "gi"))) {
    const index = marker.index;
    if (code.some(([from, to]) => index >= from && index < to)) continue;
    chunks.push(content.slice(start, index));
    start = index + marker[0].length;
  }

  chunks.push(content.slice(start));
  return chunks;
}

/**
 * Fenced blocks (``` or ~~~) and inline code spans. Outside a fence, a marker
 * starts a new line, so a fence may open right after one and close right
 * before one. An unclosed fence runs to the end.
 */
function codeRanges(content: string): Range[] {
  const starts = [
    0,
    ...[...content.matchAll(/\n/g)].map((match) => match.index + 1),
    ...[...content.matchAll(new RegExp(SPLIT_MARKER, "gi"))].map(
      (match) => match.index + match[0].length,
    ),
  ].sort((a, b) => a - b);
  const ranges: Range[] = [];
  let fence: { char: string; length: number; start: number } | undefined;
  let prose = 0;

  for (const start of starts) {
    const newline = content.indexOf("\n", start);
    const line = content.slice(start, newline < 0 ? content.length : newline);
    const [, indent = "", run = "", info = ""] = FENCE.exec(line) ?? [];
    const char = run.charAt(0);
    if (fence) {
      // Inside a fence, markers are content and only real lines can close it.
      if (content[start - 1] !== "\n") continue;
      if (
        char === fence.char &&
        run.length >= fence.length &&
        FENCE_CLOSE_TAIL.test(info)
      ) {
        prose = start + indent.length + run.length;
        ranges.push([fence.start, prose]);
        fence = undefined;
      }
    } else if (run && !(char === "`" && info.includes("`"))) {
      // A marker or newline inside inline code cannot start a fenced block.
      if (
        inlineCodeRanges(content, prose, content.length).some(
          ([from, to]) => from < start && start < to,
        )
      ) {
        continue;
      }
      ranges.push(...inlineCodeRanges(content, prose, start));
      fence = { char, length: run.length, start };
    }
  }

  if (fence) ranges.push([fence.start, content.length]);
  else ranges.push(...inlineCodeRanges(content, prose, content.length));
  return ranges;
}

/** A backtick run closes at the next run of equal length in the same paragraph. */
function inlineCodeRanges(
  content: string,
  start: number,
  end: number,
): Range[] {
  const prose = content.slice(start, end);
  const runs = [...prose.matchAll(/`+/g)];
  const ranges: Range[] = [];

  for (let index = 0; index < runs.length; index += 1) {
    const open = runs[index];
    if (!open) continue;
    const openEnd = open.index + open[0].length;
    const closeIndex = runs.findIndex(
      (run, candidate) => candidate > index && run[0].length === open[0].length,
    );
    const close = runs[closeIndex];
    if (!close || PARAGRAPH_BREAK.test(prose.slice(openEnd, close.index))) {
      continue;
    }
    ranges.push([start + open.index, start + close.index + close[0].length]);
    index = closeIndex;
  }

  return ranges;
}

function capResponseMessages(chunks: string[]): string[] {
  if (chunks.length <= MAX_RESPONSE_MESSAGES) return chunks;

  return groupEvenly(chunks, MAX_RESPONSE_MESSAGES).map((group) => {
    const [firstChunk, ...overflow] = splitHardLimit(group.join("\n"));
    if (!firstChunk) return "";
    if (overflow.length === 0) return firstChunk;
    return appendOmissionMarker(firstChunk, overflow.length);
  });
}

function groupEvenly(chunks: string[], groupCount: number): string[][] {
  const groups: string[][] = [];
  let index = 0;

  for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
    const remainingChunks = chunks.length - index;
    const remainingGroups = groupCount - groupIndex;
    const size = Math.ceil(remainingChunks / remainingGroups);
    groups.push(chunks.slice(index, index + size));
    index += size;
  }

  return groups;
}

function appendOmissionMarker(content: string, omitted: number): string {
  const marker = `\n… ${omitted} more message chunks omitted`;
  if (content.length + marker.length <= SAFE_MESSAGE_LIMIT) {
    return `${content}${marker}`;
  }

  return `${content.slice(0, SAFE_MESSAGE_LIMIT - marker.length).trim()}${marker}`;
}

function splitHardLimit(content: string): string[] {
  if (content.length <= SAFE_MESSAGE_LIMIT) return [content];

  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > SAFE_MESSAGE_LIMIT) {
    const splitAt = findSplitIndex(remaining);
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

function findSplitIndex(content: string): number {
  const search = content.slice(0, SAFE_MESSAGE_LIMIT);
  const paragraph = search.lastIndexOf("\n\n");
  if (paragraph > 500) return paragraph;

  const newline = search.lastIndexOf("\n");
  if (newline > 500) return newline;

  const sentence = Math.max(
    search.lastIndexOf(". "),
    search.lastIndexOf("! "),
    search.lastIndexOf("? "),
  );
  if (sentence > 500) return sentence + 1;

  const space = search.lastIndexOf(" ");
  if (space > 500) return space;

  return Math.min(SAFE_MESSAGE_LIMIT, DISCORD_MESSAGE_LIMIT);
}
