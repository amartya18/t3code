const FIRST_CHUNK_WORDS = 4;
const CHUNK_MIN = 100;
const CHUNK_MAX = 150;

const FENCE = /^\s*(?:```|~~~)/;
const HEADING = /^\s{0,3}#{1,6}\s+/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const TABLE_ROW = /^\s*\|/;
const TABLE_RULE_CELL = /^\s*:?-+:?\s*$/;
const QUOTE = /^\s*>\s?/;

const MARKDOWN_LINK = /\[([^\]]*)\]\([^)]*\)/g;
const URL = /\b(?:https?:\/\/|www\.)[^\s)]+/gi;
const THREAD_REF = /\b(?:thread|home(?:-launched)?|home-report):\S+/gi;
const UUID = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi;
// Requires a digit so words that happen to be hex letters, like "defaced", survive.
const HEX_RUN = /\b(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/gi;
// A slash alone is not a path ("and/or", "TCP/IP"): it needs a root, two slashes, or a file extension.
const FILE_PATH =
  /(?<![\w.:/@-])(?:(?:~|\.{1,2})?\/[\w.@-]+(?:\/[\w.@-]*)*|[\w.@-]+\/[\w.@-]+\/[\w.@/-]*|[\w.@-]+\/[\w@-]*\.[a-z]\w{0,4})(?::\d+)*/gi;
const MARKDOWN_MARKS = /[`*_#>|~]+/g;
const SENTENCE_END = /[.!?…]+["'’”)\]]*(?=\s)/g;
const ABBREVIATION = /\b(?:e\.g|i\.e|vs)\.$/i;
const TERMINAL = /[.!?…]["'’”)\]]*$/;

interface Unit {
  readonly text: string;
  readonly closed: boolean;
}

/**
 * A finished reply as speech. The first chunk is the first sentence, with a short opener like
 * "Sure." joined to what follows until it has four words, so the voice starts soon; later chunks
 * group sentences until they reach 100 characters, so Kokoro voices each while the last plays.
 */
export function speechChunks(reply: string): ReadonlyArray<string> {
  return chunk(sentences(reply, true), true);
}

/**
 * The chunks of a still-streaming reply that are now safe to speak, after the first
 * `emitted`. Chunks only grow from the front, so a later call never revises one already
 * spoken; once the reply completes, `speechChunks(reply).slice(emitted)` is the rest.
 */
export function nextSpeechChunks(partialReply: string, emitted: number): ReadonlyArray<string> {
  return chunk(sentences(partialReply, false), false).slice(emitted);
}

function sentences(markdown: string, complete: boolean): ReadonlyArray<string> {
  // Streaming text that stops on a space after a period has finished that sentence.
  const endsInSpace = /\s$/.test(markdown);
  return units(markdown, complete).flatMap((unit) => {
    const text = speakable(unit.text) + (!unit.closed && endsInSpace ? " " : "");
    const found: string[] = [];
    let start = 0;
    for (const match of text.matchAll(SENTENCE_END)) {
      const end = match.index + match[0].length;
      if (ABBREVIATION.test(text.slice(start, end))) continue;
      found.push(text.slice(start, end).trim());
      start = end;
    }
    const rest = text.slice(start).trim();
    if (unit.closed && rest !== "") found.push(TERMINAL.test(rest) ? rest : `${rest}.`);
    return found.filter((sentence) => /\w/.test(sentence));
  });
}

function units(markdown: string, complete: boolean): ReadonlyArray<Unit> {
  const lines = markdown.split("\n");
  const found: Unit[] = [];
  let paragraph: string[] = [];
  let inFence = false;
  const closeParagraph = () => {
    if (paragraph.length > 0) found.push({ text: paragraph.join(" "), closed: true });
    paragraph = [];
  };
  lines.forEach((raw, index) => {
    const closed = complete || index < lines.length - 1;
    if (FENCE.test(raw)) {
      closeParagraph();
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const line = raw.replace(QUOTE, "");
    if (line.trim() === "") {
      if (closed) closeParagraph();
      return;
    }
    const block = blockText(line);
    if (block === null) {
      paragraph.push(line);
      return;
    }
    closeParagraph();
    if (block !== "") found.push({ text: block, closed });
  });
  if (paragraph.length > 0) found.push({ text: paragraph.join(" "), closed: complete });
  return found;
}

/** Text of a heading, list item or table row; `null` for a paragraph line. */
function blockText(line: string): string | null {
  if (HEADING.test(line)) return line.replace(HEADING, "");
  if (LIST_ITEM.test(line)) return line.replace(LIST_ITEM, "");
  if (!TABLE_ROW.test(line)) return null;
  const cells = line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
  if (cells.every((cell) => TABLE_RULE_CELL.test(cell))) return "";
  return cells.filter((cell) => cell !== "").join(", ");
}

function speakable(text: string): string {
  return text
    .replace(MARKDOWN_LINK, "$1")
    .replace(URL, "")
    .replace(THREAD_REF, "")
    .replace(UUID, "")
    .replace(HEX_RUN, "")
    .replace(FILE_PATH, (path) => (/[a-z]/i.test(path) ? "" : path))
    .replace(MARKDOWN_MARKS, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
}

function chunk(found: ReadonlyArray<string>, complete: boolean): ReadonlyArray<string> {
  const chunks: string[] = [];
  let open = "";
  for (const sentence of found.flatMap(splitLong)) {
    open = open === "" ? sentence : `${open} ${sentence}`;
    if (chunks.length === 0 ? wordCount(open) >= FIRST_CHUNK_WORDS : open.length >= CHUNK_MIN) {
      chunks.push(open);
      open = "";
    }
  }
  if (complete && open !== "") chunks.push(open);
  return chunks;
}

function wordCount(text: string): number {
  return text.split(" ").filter((word) => /\w/.test(word)).length;
}

function splitLong(sentence: string): ReadonlyArray<string> {
  const pieces: string[] = [];
  let rest = sentence;
  while (rest.length > CHUNK_MAX) {
    const head = rest.slice(0, CHUNK_MAX);
    const cut = Math.max(head.lastIndexOf(", "), head.lastIndexOf("; "));
    const at = cut > CHUNK_MIN ? cut + 1 : head.lastIndexOf(" ");
    const end = at > 0 ? at : CHUNK_MAX;
    pieces.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  return [...pieces, rest];
}
