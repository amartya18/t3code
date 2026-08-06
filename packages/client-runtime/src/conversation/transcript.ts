export interface ChatTranscriptMessage {
  readonly role: string;
  readonly text: string;
  readonly streaming: boolean;
}

function transcriptRoleLabel(role: string): "User" | "Agent" | null {
  if (role === "user") return "User";
  if (role === "assistant") return "Agent";
  return null;
}

function copyableTranscriptRoleLabel(message: ChatTranscriptMessage): "User" | "Agent" | null {
  if (message.streaming || !/\S/.test(message.text)) return null;
  return transcriptRoleLabel(message.role);
}

function transcriptMessageBlock(message: ChatTranscriptMessage): string | null {
  const roleLabel = copyableTranscriptRoleLabel(message);
  if (roleLabel === null) return null;
  const text = message.text.trim();

  return `## ${roleLabel}\n\n${text}`;
}

export function hasCopyableChatTranscriptMessages(
  messages: ReadonlyArray<ChatTranscriptMessage>,
): boolean {
  return messages.some((message) => copyableTranscriptRoleLabel(message) !== null);
}

export function canCopyChatTranscript(
  messages: ReadonlyArray<ChatTranscriptMessage>,
  activeTurnInProgress: boolean,
): boolean {
  return (
    !activeTurnInProgress &&
    !messages.some((message) => message.streaming) &&
    hasCopyableChatTranscriptMessages(messages)
  );
}

export function buildChatTranscript(messages: ReadonlyArray<ChatTranscriptMessage>): string {
  return messages.flatMap((message) => {
    const block = transcriptMessageBlock(message);
    return block === null ? [] : [block];
  }).join("\n\n");
}
