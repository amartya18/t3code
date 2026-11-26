import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { useEffect } from "react";

import { useThreadShell, useThreadShells } from "../../state/entities";
import { useEnvironmentThread } from "../../state/threads";
import { readHomeView } from "./homeView";
import {
  ensureVoiceTag,
  pushHomeUpdates,
  voiceSessionAtom,
  type VoiceSession,
} from "./voiceSession";

/** Fork hook at the app root: runs the live session whether its call screen is open or not. */
export function VoiceSessionRunner() {
  const session = useAtomValue(voiceSessionAtom);
  if (session === null) return null;
  return (
    <LiveVoiceSession
      key={`${session.thread.environmentId}:${session.thread.threadId}`}
      session={session}
    />
  );
}

/** Tags the voice thread and relays what changes at Home. */
function LiveVoiceSession(props: { readonly session: VoiceSession }) {
  const { thread, home } = props.session;
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
    pushHomeUpdates(thread, view);
  }, [thread, view]);

  return null;
}
