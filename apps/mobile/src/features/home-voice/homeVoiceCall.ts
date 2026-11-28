import { userHomeThreadRef } from "@t3tools/client-runtime/state/home";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { EMPTY_ENVIRONMENT_THREAD_STATE } from "@t3tools/client-runtime/state/threads";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { NavigationState, PartialState } from "@react-navigation/native";
import * as Option from "effect/Option";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import { msg } from "gt-react-native";

import * as Dialog from "../../components/ui/Dialog";
import { m } from "../../i18n/messages";
import { findLinkedRoute } from "../../lib/appLinking";
import { rootNavigationRef, whenRootNavigationReady } from "../../lib/rootNavigation";
import { appAtomRegistry } from "../../state/atom-registry";
import { userHomeAtom } from "../../state/home";
import { environmentThreads, environmentThreadShells } from "../../state/threads";
import { readHomeView } from "./homeView";
import { startVoiceSession, voiceSessionAtom } from "./voiceSession";
import {
  storedVoiceSettingsLoaded,
  voiceModeSettingsAtom,
  type VoiceModeSettings,
} from "./voiceSettings";

/** A link opened from a cold launch waits this long for Home's machine to connect. */
export const VOICE_CALL_LINK_WAIT_MS = 20_000;

export interface VoiceCallStart {
  readonly settings: VoiceModeSettings;
  readonly homeShell: EnvironmentThreadShell;
}

/** A call can start once the Voice project and Home's thread are both known. */
export function voiceCallStart(input: {
  readonly settings: VoiceModeSettings | null;
  readonly home: ScopedThreadRef | null;
  readonly shells: ReadonlyArray<EnvironmentThreadShell>;
}): VoiceCallStart | null {
  const { settings, home } = input;
  if (settings === null || home === null) return null;
  const homeShell = input.shells.find(
    (shell) => shell.environmentId === home.environmentId && shell.id === home.threadId,
  );
  return homeShell === undefined ? null : { settings, homeShell };
}

/** The atom's first non-null value, or null once `timeoutMs` passes without one. */
export function firstValue<A>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<A | null>,
  timeoutMs: number,
): Promise<A | null> {
  const now = registry.get(atom);
  if (now !== null) return Promise.resolve(now);
  return new Promise((resolve) => {
    const stop = registry.subscribe(atom, (value) => {
      if (value === null) return;
      clearTimeout(timer);
      stop();
      resolve(value);
    });
    const timer = setTimeout(() => {
      stop();
      resolve(null);
    }, timeoutMs);
  });
}

/**
 * Shows the voice call, first starting one with Home if none is running. `home` defaults to the
 * user's Home; `waitMs` is how long to wait for it and the Voice project to load.
 */
export async function openHomeVoiceCall(options: {
  readonly home?: ScopedThreadRef;
  readonly waitMs: number;
}): Promise<void> {
  if (appAtomRegistry.get(voiceSessionAtom) === null) {
    await storedVoiceSettingsLoaded;
    const ready = Atom.make((get) =>
      voiceCallStart({
        settings: get(voiceModeSettingsAtom),
        home: options.home ?? userHomeThreadRef(get(userHomeAtom)),
        shells: get(environmentThreadShells.threadShellsAtom),
      }),
    );
    const start = await firstValue(appAtomRegistry, ready, options.waitMs);
    if (start === null) {
      alertVoiceCallUnavailable();
      return;
    }
    if (appAtomRegistry.get(voiceSessionAtom) === null) startCall(start);
  }
  whenRootNavigationReady(() => rootNavigationRef.navigate("VoiceCall"));
}

function startCall({ settings, homeShell }: VoiceCallStart) {
  const home = { environmentId: homeShell.environmentId, threadId: homeShell.id };
  const homeState = AsyncResult.getOrElse(
    appAtomRegistry.get(environmentThreads.stateAtom(home.environmentId, home.threadId)),
    () => EMPTY_ENVIRONMENT_THREAD_STATE,
  );
  startVoiceSession({
    settings,
    home,
    view: readHomeView({
      homeShell,
      homeMessages: Option.getOrNull(Option.map(homeState.data, (data) => data.messages)),
      shells: appAtomRegistry.get(environmentThreadShells.threadShellsAtom),
    }),
    nowMs: Date.now(),
  });
}

function alertVoiceCallUnavailable() {
  if (appAtomRegistry.get(voiceModeSettingsAtom) === null) {
    Dialog.alert(
      m(msg("No Voice project")),
      m(
        msg(
          "Voice mode needs a project titled Voice on Home's machine. Add one, or pick another project in Voice settings.",
        ),
      ),
    );
    return;
  }
  Dialog.alert(
    m(msg("Home isn't connected")),
    m(msg("The voice call needs Home's machine. Try again once it's online.")),
  );
}

/** `voice` opens the call from outside the app, such as the iOS control; it leaves the stack as is. */
export function takeVoiceCallLink(
  state: PartialState<NavigationState> | undefined,
): PartialState<NavigationState> | undefined {
  if (findLinkedRoute(state, ["VoiceCall"]) === undefined) return state;
  void openHomeVoiceCall({ waitMs: VOICE_CALL_LINK_WAIT_MS });
  return undefined;
}
