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
import { makeQueuedMessageMetadata } from "../../lib/commandMetadata";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";
import { enqueueThreadOutboxMessage } from "../../state/thread-outbox";
import {
  diffHomeUpdates,
  renderHomeUpdate,
  startHomeUpdateCursor,
  type HomeUpdateCursor,
} from "./homeUpdates";
import type { HomeView } from "./homeView";
import { voiceInstanceEnabled, voiceTurnSelection } from "./voiceInstances";
import { voiceDevLog } from "./voiceLogUpload";
import type { VoiceModeSettings } from "./voiceSettings";

export const VOICE_THREAD_TAG = "voice";

/** The one live voice session, in memory: its thread, Home's thread, and what it has reported. */
export interface VoiceSession extends HomeUpdateCursor {
  readonly thread: ScopedThreadRef;
  /** Amar's first line creates the thread; until it is queued, nothing reads the thread or sends to it. */
  readonly threadCreated: boolean;
  readonly home: ScopedThreadRef;
  readonly muted: boolean;
  /** The built-in speaker instead of the earpiece; every call starts on the earpiece. */
  readonly speaker: boolean;
}

export const voiceSessionAtom = Atom.make<VoiceSession | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("home-voice:session"),
);

const sameThread = (left: ScopedThreadRef, right: ScopedThreadRef) =>
  left.environmentId === right.environmentId && left.threadId === right.threadId;

/** Opens a silent session, replacing any live one; nothing is sent until Amar speaks. */
export function startVoiceSession(input: {
  readonly settings: VoiceModeSettings;
  readonly home: ScopedThreadRef;
  readonly view: HomeView;
  readonly nowMs: number;
}) {
  appAtomRegistry.set(voiceSessionAtom, {
    thread: { environmentId: input.settings.environmentId, threadId: ThreadId.make(uuidv4()) },
    threadCreated: false,
    home: input.home,
    muted: false,
    speaker: false,
    ...startHomeUpdateCursor(input.view, input.nowMs),
  });
}

export function endVoiceSession() {
  appAtomRegistry.set(voiceSessionAtom, null);
}

export function toggleVoiceMuted() {
  const session = appAtomRegistry.get(voiceSessionAtom);
  if (session !== null)
    appAtomRegistry.set(voiceSessionAtom, { ...session, muted: !session.muted });
}

export function toggleVoiceSpeaker() {
  const session = appAtomRegistry.get(voiceSessionAtom);
  if (session !== null)
    appAtomRegistry.set(voiceSessionAtom, { ...session, speaker: !session.speaker });
}

/** Queues what Amar said (or typed) in the voice thread, on the session's current model. */
export async function sendVoiceMessage(
  thread: ScopedThreadRef,
  settings: VoiceModeSettings,
  text: string,
  messageId?: string,
) {
  // Claimed before the write, so a line sent meanwhile can't create the thread a second time.
  const creation = markThreadCreated(thread, true)
    ? ({
        projectId: settings.projectId,
        workspaceMode: "local",
        branch: null,
        worktreePath: null,
      } as const)
    : null;
  const metadata = makeQueuedMessageMetadata();
  const modelSelection = voiceTurnSelection(
    settings.modelSelection,
    voiceInstanceEnabled(
      appAtomRegistry.get(serverEnvironment.configValueAtom(thread.environmentId)),
      settings.projectId,
    ),
    settings.thinking,
  );
  voiceDevLog(`[voice] turn on ${modelSelection.instanceId}/${modelSelection.model}`);
  try {
    await enqueueThreadOutboxMessage({
      ...thread,
      messageId: MessageId.make(messageId ?? metadata.messageId),
      commandId: CommandId.make(metadata.commandId),
      text,
      attachments: [],
      modelSelection,
      // Home's MCP access check refuses senders in a narrower mode; the project's deny list keeps tools narrow.
      runtimeMode: "full-access",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      ...(creation === null ? {} : { creation }),
      createdAt: metadata.createdAt,
    });
  } catch (error) {
    if (creation !== null) markThreadCreated(thread, false);
    throw error;
  }
}

/** Sets the live session's flag; true when this call changed it. */
function markThreadCreated(thread: ScopedThreadRef, created: boolean): boolean {
  const session = appAtomRegistry.get(voiceSessionAtom);
  if (
    session === null ||
    !sameThread(session.thread, thread) ||
    session.threadCreated === created
  ) {
    return false;
  }
  appAtomRegistry.set(voiceSessionAtom, { ...session, threadCreated: created });
  return true;
}

/**
 * Sends what changed at Home since the session last reported; repeat calls send nothing new.
 * Before Amar's first line there is no thread, so the cursor stays put and the changes wait.
 */
export function pushHomeUpdates(thread: ScopedThreadRef, view: HomeView) {
  const session = appAtomRegistry.get(voiceSessionAtom);
  if (session === null || !sameThread(session.thread, thread) || !session.threadCreated) return;
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
