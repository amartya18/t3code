import { Platform } from "react-native";

import { voiceEngine, type VoiceEngineConfig } from "../../../modules/t3-voice-mode";
import type { VoiceSpeechConfig } from "./voiceSpeech";
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

export const ECHO_CANCELLATION = true;

/** Dev tuning of when Amar's turn starts and ends, each on its own slider. */
export interface VoiceTuning {
  /** How long a voice must last before the detector calls it speech. */
  readonly minSpeechMs: number;
  /** How long a silence must last before the detector calls the speech over and Smart Turn scores it. */
  readonly minSilenceMs: number;
  /** How long a pause Smart Turn calls unfinished waits for him to go on. */
  readonly turnWaitMs: number;
}

export const DEFAULT_VOICE_TUNING: VoiceTuning = {
  minSpeechMs: 250,
  minSilenceMs: 200,
  turnWaitMs: 3_000,
};

export const VOICE_TUNING_RANGE: Record<keyof VoiceTuning, { min: number; max: number }> = {
  minSpeechMs: { min: 100, max: 1_000 },
  minSilenceMs: { min: 200, max: 1_500 },
  turnWaitMs: { min: 1_500, max: 4_000 },
};

/** Tuning for the native engine; it holds no policy, so all of this ships over the air. */
export function voiceEngineConfig(voiceId: string, tuning: VoiceTuning): VoiceEngineConfig {
  return {
    vad: { threshold: 0.5, minSpeechMs: tuning.minSpeechMs, minSilenceMs: tuning.minSilenceMs },
    tts: { voiceId, speed: 1, vocoderFloat32: false },
    aec: { enabled: ECHO_CANCELLATION },
    logStages: __DEV__,
  };
}

export function voiceSpeechConfig(tuning: VoiceTuning): VoiceSpeechConfig {
  return {
    vad: { minSpeechMs: tuning.minSpeechMs, minSilenceMs: tuning.minSilenceMs },
    unfinishedWaitMs: tuning.turnWaitMs,
    voiceBargeIn: ECHO_CANCELLATION,
  };
}
