import type { OwnLine } from "./voiceSpeech";

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

export const TRANSCRIPT_LINES = 6;

const CATCH_UP = "[Catch-up]";
const HOME_UPDATE = "[Home update]";
const HOME_REPLY = "Home replied:";

function lineFor(message: TranscriptMessage): TranscriptLine | null {
  const text = message.text.trim();
  if (text === "" || message.role === "system") return null;
  if (message.role === "assistant") return { id: message.id, kind: "agent", text };
  if (text.startsWith(CATCH_UP)) return null;
  if (text.startsWith(HOME_UPDATE)) {
    const note = text.slice(HOME_UPDATE.length).trim();
    return note.startsWith(HOME_REPLY)
      ? { id: message.id, kind: "homeReply" }
      : { id: message.id, kind: "homeNote", text: note };
  }
  return { id: message.id, kind: "user", text };
}

/**
 * The call screen's last lines: sent messages, then any still waiting in the outbox, then Amar's
 * own line, which stands in for its outbox and thread copies until the thread has it.
 */
export function voiceTranscript(
  sent: ReadonlyArray<TranscriptMessage>,
  queued: ReadonlyArray<TranscriptMessage>,
  own: OwnLine | null,
): ReadonlyArray<TranscriptLine> {
  const shownIds = new Set([...sent.map((message) => message.id), own?.messageId]);
  const lines = [
    ...sent.filter((message) => message.id !== own?.messageId).map(lineFor),
    ...queued.filter((message) => !shownIds.has(message.id)).map(lineFor),
    own === null ? null : { id: own.messageId ?? "own", kind: "user" as const, text: own.text },
  ].filter((line) => line !== null);
  return lines.slice(-TRANSCRIPT_LINES);
}
