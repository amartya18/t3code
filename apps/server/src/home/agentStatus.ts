/** What an agent's threads need from someone, shared by Home's watcher and status. */
import type { HomeWatchEvent, OrchestrationV2ThreadShell } from "@t3tools/contracts";

const REPLY_PREVIEW_LENGTH = 300;

type AttentionKind = Extract<HomeWatchEvent["kind"], "approval" | "question" | "failed">;

export function attentionOf(
  shell: OrchestrationV2ThreadShell,
): { readonly kind: AttentionKind; readonly key: string } | null {
  const request = shell.pendingRuntimeRequest;
  if (request?.kind === "user_input") return { kind: "question", key: `request:${request.id}` };
  if (request !== null && request.kind !== "auth_refresh") {
    return { kind: "approval", key: `request:${request.id}` };
  }
  if (shell.status === "failed") return { kind: "failed", key: `failed:${shell.latestRunId}` };
  return null;
}

/** One line of at most 300 characters. */
function replyPreview(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= REPLY_PREVIEW_LENGTH
    ? line
    : `${line.slice(0, REPLY_PREVIEW_LENGTH - 1).trimEnd()}…`;
}

/** The thread's latest assistant reply, previewed, or null when its last message is not one. */
export function latestReplyOf(shell: OrchestrationV2ThreadShell): string | null {
  const message = shell.latestVisibleMessage;
  return message?.role === "assistant" && message.text.trim() !== ""
    ? replyPreview(message.text)
    : null;
}
