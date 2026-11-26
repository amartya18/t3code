export interface TranscriptMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
}

export type TranscriptLine =
  | { readonly id: string; readonly kind: "agent"; readonly text: string }
  | { readonly id: string; readonly kind: "user"; readonly text: string; readonly pending: boolean }
  | { readonly id: string; readonly kind: "homeReply" }
  | { readonly id: string; readonly kind: "homeNote"; readonly text: string };

export const TRANSCRIPT_LINES = 6;

const CATCH_UP = "[Catch-up]";
const HOME_UPDATE = "[Home update]";
const HOME_REPLY = "Home replied:";

function lineFor(message: TranscriptMessage, pending: boolean): TranscriptLine | null {
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
  return { id: message.id, kind: "user", text, pending };
}

/** The call screen's last lines: sent messages, then any still waiting in the outbox. */
export function voiceTranscript(
  sent: ReadonlyArray<TranscriptMessage>,
  queued: ReadonlyArray<TranscriptMessage>,
): ReadonlyArray<TranscriptLine> {
  const sentIds = new Set(sent.map((message) => message.id));
  const lines = [
    ...sent.map((message) => lineFor(message, false)),
    ...queued
      .filter((message) => !sentIds.has(message.id))
      .map((message) => lineFor(message, true)),
  ].filter((line) => line !== null);
  return lines.slice(-TRANSCRIPT_LINES);
}
