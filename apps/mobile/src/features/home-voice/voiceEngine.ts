import { Platform } from "react-native";

import { voiceEngine, type VoiceEngineConfig } from "../../../modules/t3-voice-mode";
import { voiceSupport } from "./voiceSupport";

export const VOICE_ENGINE_SUPPORT = voiceSupport(
  voiceEngine !== null,
  Platform.OS,
  Platform.Version,
);

/** Whether this build and iOS version have on-device speech; otherwise the call takes typed messages. */
export function isVoiceEngineAvailable(): boolean {
  return VOICE_ENGINE_SUPPORT === "available";
}

// Off while voice processing restarts the engine into a 0 Hz mic on Amar's iPhone; the native fix needs a build.
export const ECHO_CANCELLATION = false;

/** Tuning for the native engine; it holds no policy, so all of this ships over the air. */
export function voiceEngineConfig(voiceId: string): VoiceEngineConfig {
  return {
    asr: { chunkMs: 320, eouDebounceMs: 640 },
    vad: { threshold: 0.5, minSpeechMs: 150, minSilenceMs: 300 },
    tts: { voiceId, speed: 1, vocoderFloat32: false },
    aec: { enabled: ECHO_CANCELLATION },
    logStages: __DEV__,
  };
}
