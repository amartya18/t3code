import type { OwnLine, ReplyShown } from "./voiceSpeech";

/** What the transcript takes from the speech session; null when this build has no voice. */
export interface TranscriptSpeech {
  readonly own: OwnLine | null;
  readonly shown: ReadonlyMap<string, ReplyShown>;
}

export interface TranscriptMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
}

export type TranscriptLine =
  | { readonly id: string; readonly kind: "agent"; readonly text: string }
  | { readonly id: string; readonly kind: "user"; readonly text: string }
  | { readonly id: string; readonly kind: "homeReply" }
  | { readonly id: string; readonly kind: "homeNote"; readonly text: string };

const HOME_UPDATE = "[Home update]";
const HOME_REPLY = "Home replied:";

function lineFor(
  message: TranscriptMessage,
  speech: TranscriptSpeech | null,
): TranscriptLine | null {
  const text = message.text.trim();
  if (text === "" || message.role === "system") return null;
  if (message.role === "assistant") {
    const shown: ReplyShown | undefined =
      speech === null ? { kind: "whole" } : speech.shown.get(message.id);
    if (shown === undefined) return null;
    return { id: message.id, kind: "agent", text: shown.kind === "whole" ? text : shown.text };
  }
  if (text.startsWith(HOME_UPDATE)) {
    const note = text.slice(HOME_UPDATE.length).trim();
    return note.startsWith(HOME_REPLY)
      ? { id: message.id, kind: "homeReply" }
      : { id: message.id, kind: "homeNote", text: note };
  }
  return { id: message.id, kind: "user", text };
}

/**
 * The call screen's lines: sent messages, then any still waiting in the outbox, then Amar's
 * own line, which stands in for its outbox and thread copies until the thread has it. A reply
 * shows as far as the voice has spoken it.
 */
export function voiceTranscript(
  sent: ReadonlyArray<TranscriptMessage>,
  queued: ReadonlyArray<TranscriptMessage>,
  speech: TranscriptSpeech | null,
): ReadonlyArray<TranscriptLine> {
  const own = speech?.own ?? null;
  const shownIds = new Set([...sent.map((message) => message.id), own?.messageId]);
  const lines = [
    ...sent
      .filter((message) => message.id !== own?.messageId)
      .map((message) => lineFor(message, speech)),
    ...queued
      .filter((message) => !shownIds.has(message.id))
      .map((message) => lineFor(message, speech)),
    own === null ? null : { id: own.messageId ?? "own", kind: "user" as const, text: own.text },
  ].filter((line) => line !== null);
  return lines;
}
