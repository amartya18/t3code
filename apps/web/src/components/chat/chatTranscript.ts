import type { ChatTranscriptMessage } from "@t3tools/client-runtime/conversation";

import { deriveDisplayedUserMessageState } from "~/lib/terminalContext";

export interface TranscriptSourceMessage {
  readonly role: string;
  readonly text: string;
  readonly streaming: boolean;
  readonly attachments?: ReadonlyArray<unknown> | undefined;
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * Convert timeline messages into transcript input: user prompts lose the
 * context blocks the composer appended at send time, because one terminal
 * selection can outweigh the whole conversation. What is dropped is named in
 * the notes, so the transcript never loses something silently.
 */
export function toChatTranscriptMessages(
  messages: ReadonlyArray<TranscriptSourceMessage>,
): ReadonlyArray<ChatTranscriptMessage> {
  return messages.map((message) => {
    const notes: string[] = [];
    let text = message.text;

    if (message.role === "user") {
      const displayed = deriveDisplayedUserMessageState(message.text);
      text = displayed.visibleText;
      if (displayed.contextCount > 0) {
        notes.push(
          `${countLabel(displayed.contextCount, "terminal context", "terminal contexts")} omitted`,
        );
      }
      if (displayed.elementContexts.length > 0) {
        notes.push(
          `${countLabel(displayed.elementContexts.length, "page element", "page elements")} omitted`,
        );
      }
    }

    const attachmentCount = message.attachments?.length ?? 0;
    if (attachmentCount > 0) {
      notes.push(`${countLabel(attachmentCount, "image", "images")} attached`);
    }

    return {
      role: message.role,
      text,
      streaming: message.streaming,
      ...(notes.length > 0 ? { notes } : {}),
    };
  });
}
