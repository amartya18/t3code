import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import {
  getEnvironmentSpeechStatus,
  transcribeEnvironmentPcm,
} from "@t3tools/client-runtime/voice-input";
import {
  AuthOrchestrationOperateScope,
  type DesktopMarkModeBridge,
  type DesktopMarkModeEvent,
  type MarkModeMark,
  type SpeechTranscriptionOptions,
} from "@t3tools/contracts";
import { resolveSpeechVocabulary } from "@t3tools/shared/speech";
import { msg } from "gt-react";
import { useSyncExternalStore } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { getClientSettings } from "../hooks/useSettings";
import { m } from "../i18n/messages";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { runEnvironmentSpeech } from "../speech/runEnvironmentSpeech";
import { readEnvironment } from "../state/environments";
import { localEnvironmentIdAtom } from "../state/primaryEnvironment";
import { readEnvironmentScope, readPreparedConnection } from "../state/session";
import {
  buildMarkModeText,
  type MarkModeEvent,
  type MarkModePhase,
  nextMarkModePhase,
} from "./markMode.logic";
import { type MarkModeCapture, startMarkModeCapture } from "./markModeCapture";
import { deliverMarkModeDraft, type MarkModeTarget } from "./markModeDelivery";

type Session = {
  readonly bridge: DesktopMarkModeBridge;
  prepared: PreparedConnection | null;
  capturing: Promise<MarkModeCapture | null>;
};

let phase: MarkModePhase = "idle";
let session: Session | null = null;
let resolveTarget: (() => Promise<MarkModeTarget | null>) | null = null;
const listeners = new Set<() => void>();

function transition(event: MarkModeEvent): boolean {
  const next = nextMarkModePhase(phase, event);
  if (next === null) return false;
  phase = next;
  if (next === "idle") session = null;
  for (const listener of listeners) listener();
  return true;
}

export function getMarkModeBridge(): DesktopMarkModeBridge | undefined {
  return typeof window === "undefined" ? undefined : window.desktopBridge?.markMode;
}

export function useMarkModePhase(): MarkModePhase {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => phase,
  );
}

/** The coordinator supplies the draft on screen, since finding it needs the router. */
export function setMarkModeTargetResolver(resolver: () => Promise<MarkModeTarget | null>) {
  resolveTarget = resolver;
  return () => {
    if (resolveTarget === resolver) resolveTarget = null;
  };
}

function errorToast(title: string, description: string) {
  toastManager.add(stackedThreadToast({ type: "error", title, description }));
}

// Audio goes only to this computer's own environment, never a remote one or a cloud provider.
async function resolveLocalSpeech(): Promise<PreparedConnection | null> {
  const environmentId = appAtomRegistry.get(localEnvironmentIdAtom);
  if (!environmentId) return null;
  const prepared = readPreparedConnection(environmentId);
  const capable =
    readEnvironment(environmentId)?.serverConfig?.environment.capabilities.voiceTranscription ===
      true && readEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  if (!prepared || !capable) return null;
  const status = await runEnvironmentSpeech(getEnvironmentSpeechStatus(prepared));
  return status.supported && status.state !== "missing-model" ? prepared : null;
}

function transcriptionOptions(): SpeechTranscriptionOptions {
  const settings = getClientSettings();
  return {
    speechLanguage: settings.speechLanguage,
    speechTranslateToEnglish: settings.speechTranslateToEnglish,
    speechCustomWords: resolveSpeechVocabulary({
      personal: settings.speechCustomWords,
      project: [],
    }),
    speechRemoveFillerWords: settings.speechRemoveFillerWords,
    speechSilenceFiltering: false,
    speechWordTimestamps: true,
  };
}

export async function startMarkMode(): Promise<void> {
  const bridge = getMarkModeBridge();
  if (!bridge || !transition("start")) return;
  const current: Session = { bridge, prepared: null, capturing: Promise.resolve(null) };
  session = current;
  try {
    current.prepared = await resolveLocalSpeech();
    if (!current.prepared) {
      errorToast(
        m(msg("Mark Mode needs local transcription")),
        m(
          msg(
            "Mark Mode transcribes on this computer with Parakeet. Download it in Settings → Voice → Transcribe with.",
          ),
        ),
      );
      transition("failed");
      return;
    }
    const started = await bridge.start({ pauseMs: getClientSettings().markModePauseMs });
    if (!started.ok) {
      errorToast(m(msg("Mark Mode couldn’t start")), started.message);
      transition("failed");
      return;
    }
  } catch (error) {
    errorToast(
      m(msg("Mark Mode couldn’t start")),
      thrownErrorMessage(error, m) ?? m(msg("Try again.")),
    );
    transition("failed");
    return;
  }
  current.capturing = startMarkModeCapture(() => void bridge.finish()).then(
    (capture) => {
      // A finish that arrived while the microphone opened still collects this capture.
      if (session === current) transition("recording");
      else capture.cancel();
      return session === current ? capture : null;
    },
    (error: unknown) => {
      if (session === current && phase === "starting") {
        errorToast(
          m(msg("Mark Mode needs the microphone")),
          thrownErrorMessage(error, m) ?? m(msg("Allow microphone access, then try again.")),
        );
        transition("failed");
        void bridge.cancel();
      }
      return null;
    },
  );
}

export function finishMarkMode(): void {
  void getMarkModeBridge()?.finish();
}

async function transcribe(current: Session, capture: MarkModeCapture | null) {
  const audio = await capture?.stop();
  if (!audio || !current.prepared) return { audio: null, result: null };
  const result = await runEnvironmentSpeech(
    transcribeEnvironmentPcm(
      current.prepared,
      audio.pcm,
      transcriptionOptions(),
      () => session === current,
    ),
  );
  return { audio, result };
}

async function finish(marks: ReadonlyArray<MarkModeMark>): Promise<void> {
  const current = session;
  if (!current || !transition("finished")) return;
  const progress = toastManager.add({
    type: "loading",
    title: m(msg("Transcribing Mark Mode…")),
    timeout: 0,
  });
  try {
    const capture = await current.capturing;
    let transcript: Awaited<ReturnType<typeof transcribe>> = { audio: null, result: null };
    let transcriptionError: unknown = null;
    try {
      transcript = await transcribe(current, capture);
    } catch (error) {
      transcriptionError = error;
    }
    const text = buildMarkModeText({
      text: transcript.result?.text ?? "",
      words: transcript.result?.words,
      marks,
      audioStartedAt: transcript.audio?.startedAt ?? 0,
    });
    const target = await resolveTarget?.();
    if (!target) {
      errorToast(
        m(msg("Mark Mode has nowhere to put its draft")),
        m(msg("Add a project, then try Mark Mode again.")),
      );
      return;
    }
    const skipped = await deliverMarkModeDraft(target, text, marks);
    if (transcriptionError !== null) {
      errorToast(
        m(msg("Mark Mode couldn’t transcribe")),
        thrownErrorMessage(transcriptionError, m) ??
          m(msg("The images and markers were added without the transcript.")),
      );
    }
    if (skipped > 0) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: m(
            msg("{count, plural, one {# mark wasn’t attached} other {# marks weren’t attached}}", {
              count: skipped,
            }),
          ),
          description: m(msg("The draft is out of attachment room. Remove some, then try again.")),
        }),
      );
    }
  } catch (error) {
    errorToast(
      m(msg("Mark Mode couldn’t fill the draft")),
      thrownErrorMessage(error, m) ?? m(msg("Try again.")),
    );
  } finally {
    toastManager.close(progress);
    transition("done");
  }
}

export function handleMarkModeEvent(event: DesktopMarkModeEvent): void {
  switch (event.type) {
    case "start-requested":
      void startMarkMode();
      return;
    case "finished":
      void finish(event.marks);
      return;
    case "cancelled": {
      const current = session;
      if (current && transition("cancelled"))
        void current.capturing.then((capture) => capture?.cancel());
      return;
    }
  }
}
