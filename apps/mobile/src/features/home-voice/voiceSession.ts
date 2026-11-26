import { createEnvironmentRpcCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../../connection/runtime";
import { makeQueuedMessageMetadata, makeTurnCommandMetadata } from "../../lib/commandMetadata";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { appAtomRegistry } from "../../state/atom-registry";
import { enqueueThreadOutboxMessage } from "../../state/thread-outbox";
import { buildCatchUp, renderCatchUp } from "./catchUp";
import {
  diffHomeUpdates,
  renderHomeUpdate,
  startHomeUpdateCursor,
  type HomeUpdateCursor,
} from "./homeUpdates";
import type { HomeView } from "./homeView";
import type { VoiceModeSettings } from "./voiceSettings";

export const VOICE_THREAD_TAG = "voice";

/** The one live voice session, in memory: its thread, Home's thread, and what it has reported. */
export interface VoiceSession extends HomeUpdateCursor {
  readonly thread: ScopedThreadRef;
  readonly home: ScopedThreadRef;
  readonly muted: boolean;
}

export const voiceSessionAtom = Atom.make<VoiceSession | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("home-voice:session"),
);

const sameThread = (left: ScopedThreadRef, right: ScopedThreadRef) =>
  left.environmentId === right.environmentId && left.threadId === right.threadId;

/** Queues the voice thread's creation with the catch-up as its first message; replaces any live session. */
export async function startVoiceSession(input: {
  readonly settings: VoiceModeSettings;
  readonly home: ScopedThreadRef;
  readonly view: HomeView;
  readonly nowMs: number;
}): Promise<ScopedThreadRef> {
  const metadata = makeTurnCommandMetadata();
  const thread = {
    environmentId: input.settings.environmentId,
    threadId: ThreadId.make(metadata.threadId),
  };
  await enqueueThreadOutboxMessage({
    ...thread,
    messageId: MessageId.make(metadata.messageId),
    commandId: CommandId.make(metadata.commandId),
    text: renderCatchUp(buildCatchUp(input.view, input.nowMs)),
    attachments: [],
    modelSelection: input.settings.modelSelection,
    // Home's MCP access check refuses senders in a narrower mode; the project's deny list keeps tools narrow.
    runtimeMode: "full-access",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    creation: {
      projectId: input.settings.projectId,
      workspaceMode: "local",
      branch: null,
      worktreePath: null,
    },
    createdAt: metadata.createdAt,
  });
  appAtomRegistry.set(voiceSessionAtom, {
    thread,
    home: input.home,
    muted: false,
    ...startHomeUpdateCursor(input.view, input.nowMs),
  });
  return thread;
}

export function endVoiceSession() {
  appAtomRegistry.set(voiceSessionAtom, null);
}

export function toggleVoiceMuted() {
  const session = appAtomRegistry.get(voiceSessionAtom);
  if (session !== null)
    appAtomRegistry.set(voiceSessionAtom, { ...session, muted: !session.muted });
}

/** Queues what Amar said (or typed) in the voice thread, on the session's current model. */
export function sendVoiceMessage(
  thread: ScopedThreadRef,
  settings: VoiceModeSettings,
  text: string,
) {
  const metadata = makeQueuedMessageMetadata();
  return enqueueThreadOutboxMessage({
    ...thread,
    messageId: MessageId.make(metadata.messageId),
    commandId: CommandId.make(metadata.commandId),
    text,
    attachments: [],
    modelSelection: settings.modelSelection,
    runtimeMode: "full-access",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    createdAt: metadata.createdAt,
  });
}

/** Sends what changed at Home since the session last reported; repeat calls send nothing new. */
export function pushHomeUpdates(thread: ScopedThreadRef, view: HomeView) {
  const session = appAtomRegistry.get(voiceSessionAtom);
  if (session === null || !sameThread(session.thread, thread)) return;
  const { updates, cursor } = diffHomeUpdates(view, session);
  if (cursor === session) return;
  // Advance before sending so a re-render while the outbox writes cannot send the same update.
  appAtomRegistry.set(voiceSessionAtom, { ...session, ...cursor });
  for (const update of updates) {
    const metadata = makeQueuedMessageMetadata();
    void enqueueThreadOutboxMessage({
      ...thread,
      messageId: MessageId.make(metadata.messageId),
      commandId: CommandId.make(metadata.commandId),
      text: renderHomeUpdate(update),
      attachments: [],
      // "auto" steers Claude mid-reply; "queue" waits for the voice agent's turn to end.
      dispatchMode: "queue",
      createdAt: metadata.createdAt,
    });
  }
}

const dispatchOrchestrationCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "home-voice:dispatch",
  tag: ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
});

const taggingThreads = new Set<string>();

/** Converges the voice thread onto the `voice` tag; the thread must exist before it can be tagged. */
export function ensureVoiceTag(shell: EnvironmentThreadShell) {
  if (shell.source.tags?.includes(VOICE_THREAD_TAG) === true) return;
  const key = scopedThreadKey(shell.environmentId, shell.id);
  if (taggingThreads.has(key)) return;
  taggingThreads.add(key);
  const metadata = makeQueuedMessageMetadata();
  void runAtomCommand(appAtomRegistry, dispatchOrchestrationCommand, {
    environmentId: shell.environmentId,
    input: {
      type: "thread.tag.set",
      commandId: CommandId.make(metadata.commandId),
      threadId: shell.id,
      tag: VOICE_THREAD_TAG,
      tagged: true,
    },
  }).finally(() => taggingThreads.delete(key));
}
