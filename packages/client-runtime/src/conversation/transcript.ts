export interface ChatTranscriptMessage {
  readonly role: string;
  readonly text: string;
  readonly streaming: boolean;
  /**
   * Short lines placed under the message text, for the parts a transcript
   * cannot carry: omitted prompt context and attachments. The caller writes
   * them because only the client knows what it stripped.
   */
  readonly notes?: ReadonlyArray<string>;
}

export interface ChatTranscriptOptions {
  /** Thread title, written as the transcript heading. */
  readonly title?: string | null;
}

function transcriptRoleLabel(role: string): "User" | "Agent" | null {
  if (role === "user") return "User";
  if (role === "assistant") return "Agent";
  return null;
}

function transcriptNoteLines(message: ChatTranscriptMessage): ReadonlyArray<string> {
  return (message.notes ?? [])
    .filter((note) => /\S/.test(note))
    .map((note) => `_[${note.trim()}]_`);
}

/**
 * A message contributes to the transcript when it is complete and carries
 * something to show. A prompt that held nothing but omitted context keeps its
 * turn through the notes alone.
 */
function copyableTranscriptRoleLabel(message: ChatTranscriptMessage): "User" | "Agent" | null {
  if (message.streaming) return null;
  if (!/\S/.test(message.text) && transcriptNoteLines(message).length === 0) return null;
  return transcriptRoleLabel(message.role);
}

function transcriptMessageBlock(message: ChatTranscriptMessage): string | null {
  const roleLabel = copyableTranscriptRoleLabel(message);
  if (roleLabel === null) return null;
  const noteLines = transcriptNoteLines(message);
  const body = [message.text.trim(), noteLines.join("\n")].filter((part) => part.length > 0);

  return `## ${roleLabel}\n\n${body.join("\n\n")}`;
}

/**
 * A running turn does not block the copy: the streaming message drops out and
 * the completed conversation before it still copies.
 */
export function canCopyChatTranscript(messages: ReadonlyArray<ChatTranscriptMessage>): boolean {
  return messages.some((message) => copyableTranscriptRoleLabel(message) !== null);
}

export function buildChatTranscript(
  messages: ReadonlyArray<ChatTranscriptMessage>,
  options: ChatTranscriptOptions = {},
): string {
  const blocks = messages.flatMap((message) => {
    const block = transcriptMessageBlock(message);
    return block === null ? [] : [block];
  });
  const title = options.title?.trim();

  return (title ? [`# ${title}`, ...blocks] : blocks).join("\n\n");
}
