import type { AgentReply } from "./voiceSpeech";

const MARKER = /\s*`?\[end call\]`?/gi;
const TRAILING_MARKER = /`?\[end call\]`?\s*$/i;

/** Whether the agent asked to hang up: its marker counts only as the last thing in the reply. */
export function endsCall(reply: string): boolean {
  return TRAILING_MARKER.test(reply);
}

/** The reply as Amar reads and hears it. */
export function withoutEndCall(reply: string): string {
  return reply.replace(MARKER, "");
}

const phrases = (list: string) => list.split(",").map((phrase) => phrase.trim().split(" "));

const CLOSINGS = phrases(
  "bye, goodbye, good bye, bye for now, thats all, that is all, thats it, that is it, " +
    "thatll be all, im done, i am done, im all done, were done, we are done, all done, " +
    "nothing else, see you, see ya, see you later, talk later, talk to you later, later, " +
    "good night, hang up, you can hang up, end the call",
);
const FILLERS = phrases(
  "ok, okay, alright, all right, right, cool, great, perfect, awesome, good, fine, no, nope, " +
    "yeah, yes, yep, so, well, um, uh, thanks, thank you, thanks a lot, cheers, for now, for today, " +
    "then, now",
);

const ASKS_TO_END =
  /\b(?:close|end|finish|stop|hang up|cut|drop)\b(?: \w+){0,2} (?:call|conversation|session)\b|\b(?:close|end) (?:it|this)$|\bhang up\b/;
const KEEPS_GOING =
  /\b(?:wait|actually|one more|also|but|hold on|hang on|before|dont|do not|not yet)\b/;

/** Whether Amar's line ends the call: an explicit ask to end it, or nothing but closings and filler. */
export function isClosing(line: string): boolean {
  const words = line
    .toLowerCase()
    .replace(/['’‘]/g, "")
    .split(/[^a-z]+/)
    .filter((word) => word !== "");
  const text = words.join(" ");
  if (KEEPS_GOING.test(text)) return false;
  if (ASKS_TO_END.test(text)) return true;
  if (line.includes("?")) return false;
  let closed = false;
  let at = 0;
  while (at < words.length) {
    const closing = longestAt(words, at, CLOSINGS);
    const filler = longestAt(words, at, FILLERS);
    if (closing === 0 && filler === 0) return false;
    closed ||= closing >= filler;
    at += Math.max(closing, filler);
  }
  return closed;
}

function longestAt(
  words: ReadonlyArray<string>,
  at: number,
  list: ReadonlyArray<ReadonlyArray<string>>,
): number {
  let longest = 0;
  for (const phrase of list) {
    if (phrase.length > longest && phrase.every((word, index) => words[at + index] === word)) {
      longest = phrase.length;
    }
  }
  return longest;
}

/** The newest reply when it is finished, ends with the marker, and answers Amar's goodbye. */
export function goodbyeReply(
  replies: ReadonlyArray<AgentReply>,
  lastLine: string | null,
): string | null {
  const newest = replies.at(-1);
  if (newest === undefined || newest.streaming || !endsCall(newest.text)) return null;
  return lastLine !== null && isClosing(lastLine) ? newest.id : null;
}
