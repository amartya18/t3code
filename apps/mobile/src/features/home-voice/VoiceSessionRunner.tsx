import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { useEffect } from "react";

import { useThreadShell, useThreadShells } from "../../state/entities";
import { useEnvironmentThread } from "../../state/threads";
import { goodbyeReply } from "./endCall";
import { readHomeView } from "./homeView";
import { useVoiceConnection, useVoiceThread } from "./useVoiceCall";
import { threadEvent, useVoiceSpeech } from "./useVoiceSpeech";
import { VoiceRenderProfiler } from "./voiceRenderProfiler";
import { isVoiceEngineAvailable } from "./voiceEngine";
import {
  endVoiceSession,
  ensureVoiceTag,
  pushHomeUpdates,
  voiceSessionAtom,
  type VoiceSession,
} from "./voiceSession";

/** Fork hook at the app root: runs the live session whether its call screen is open or not. */
export function VoiceSessionRunner() {
  const session = useAtomValue(voiceSessionAtom);
  if (session === null) return null;
  const key = `${session.thread.environmentId}:${session.thread.threadId}`;
  return (
    <VoiceRenderProfiler id="voice-session">
      <LiveVoiceSession key={key} session={session} />
      {isVoiceEngineAvailable() ? (
        <SpokenVoiceSession key={`speech:${key}`} session={session} />
      ) : (
        <TypedVoiceSession session={session} />
      )}
    </VoiceRenderProfiler>
  );
}

/** Listens and speaks; its own component so streamed replies re-render only this. */
function SpokenVoiceSession(props: { readonly session: VoiceSession }) {
  useVoiceSpeech(props.session);
  return null;
}

/** Without on-device speech the goodbye is only read, so the call ends as soon as it arrives. */
function TypedVoiceSession(props: { readonly session: VoiceSession }) {
  const state = useVoiceThread(props.session);
  const { queued } = useVoiceConnection(props.session.thread);
  const messages = Option.getOrNull(Option.map(state.data, (data) => data.messages));
  const { replies, lastLine } = threadEvent(messages ?? [], 0);
  const goodbye = queued.length === 0 && goodbyeReply(replies, lastLine) !== null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the session lives in an atom outside React
  useEffect(() => {
    if (goodbye) endVoiceSession();
  }, [goodbye]);

  return null;
}

/** Tags the voice thread and relays what changes at Home. */
function LiveVoiceSession(props: { readonly session: VoiceSession }) {
  const { thread, home, threadCreated } = props.session;
  const voiceShell = useThreadShell(thread);
  const homeShell = useThreadShell(home);
  const homeState = useEnvironmentThread(home.environmentId, home.threadId);
  const shells = useThreadShells();
  const view = readHomeView({
    homeShell,
    homeMessages: Option.getOrNull(Option.map(homeState.data, (data) => data.messages)),
    shells,
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the voice thread's tag lives on the server
  useEffect(() => {
    if (voiceShell !== null) ensureVoiceTag(voiceShell);
  }, [voiceShell]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Home's changes go out through the outbox
  useEffect(() => {
    if (threadCreated) pushHomeUpdates(thread, view);
  }, [thread, view, threadCreated]);

  return null;
}
