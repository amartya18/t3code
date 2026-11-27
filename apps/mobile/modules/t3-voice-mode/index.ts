import { requireOptionalNativeModule, type EventSubscription } from "expo";

/** `aec` and `tts.vocoderFloat32` apply on the next `start()`; the rest at once. */
export interface VoiceEngineConfig {
  /** Silero v6 on 32 ms frames. */
  readonly vad: {
    readonly threshold: number;
    /** Voiced frames must run this long before speech starts. */
    readonly minSpeechMs: number;
    /** Unvoiced frames must run this long before speech ends. */
    readonly minSilenceMs: number;
  };
  readonly tts: {
    readonly voiceId: string;
    readonly speed: number;
    readonly vocoderFloat32: boolean;
  };
  readonly aec: { readonly enabled: boolean };
  readonly logStages: boolean;
}

export interface VoiceModelStatus {
  readonly state: "missing" | "partial" | "ready";
  readonly bytesOnDisk: number;
}

export interface SpeechItem {
  readonly id: string;
  readonly text: string;
}

export type VoiceModelPart = "vad" | "asr" | "turn" | "tts";

/**
 * Times are milliseconds on the engine's own monotonic clock; `transcribe` and `turnScore` take
 * them back. Every `speak` item ends with exactly one `finished` or `stopped` playback event.
 */
export interface VoiceEngineEvents {
  /** `atMs` is when the speech really started or ended, not when the hold rule confirmed it. */
  readonly vad: {
    readonly speaking: boolean;
    readonly probability: number;
    readonly level: number;
    readonly atMs: number;
  };
  readonly playback: { readonly id: string; readonly state: "started" | "finished" | "stopped" };
  /** FluidAudio reports download progress per model as a fraction, never in bytes. */
  readonly models: {
    readonly state: "downloading" | "ready" | "failed";
    readonly part: VoiceModelPart | null;
    readonly fraction: number;
    readonly bytesOnDisk: number;
  };
  readonly route: { readonly output: string };
  readonly interruption: { readonly phase: "began" | "ended" };
  readonly stage: { readonly name: string; readonly atMs: number };
  readonly error: { readonly code: string; readonly message: string };
}

export interface VoiceEngine {
  configure(config: VoiceEngineConfig): Promise<void>;
  modelStatus(): Promise<VoiceModelStatus>;
  downloadModels(): Promise<void>;
  deleteModels(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  setMuted(muted: boolean): void;
  /** Words Parakeet should favour; replaces the previous list. */
  setVocabulary(words: ReadonlyArray<string>): Promise<void>;
  /** Parakeet TDT 0.6B v3 on the mic audio between two engine times, from the recent-audio buffer. */
  transcribe(fromMs: number, toMs: number): Promise<{ readonly text: string }>;
  /** Smart Turn v3: how likely the speech between two engine times is a finished turn, 0 to 1. */
  turnScore(fromMs: number, toMs: number): Promise<{ readonly probability: number }>;
  speak(item: SpeechItem): Promise<void>;
  duck(level: number): void;
  stopSpeech(fadeMs: number): void;
  selfTest(): Promise<string>;
  addListener<K extends keyof VoiceEngineEvents>(
    event: K,
    listener: (event: VoiceEngineEvents[K]) => void,
  ): EventSubscription;
}

interface NativeVoiceMode extends Omit<VoiceEngine, "speak" | "stopSpeech"> {
  speak(id: string, text: string, seq: number): Promise<void>;
  stopSpeech(fadeMs: number, seq: number): void;
}

const native = requireOptionalNativeModule<NativeVoiceMode>("T3VoiceMode");

// One counter orders speak and stopSpeech as JS called them; native drops items older than a stop.
let seq = 0;

/** Null on builds without the native module, and on Android. */
export const voiceEngine: VoiceEngine | null = native && {
  configure: (config) => native.configure(config),
  modelStatus: () => native.modelStatus(),
  downloadModels: () => native.downloadModels(),
  deleteModels: () => native.deleteModels(),
  start: () => native.start(),
  stop: () => native.stop(),
  setMuted: (muted) => native.setMuted(muted),
  setVocabulary: (words) => native.setVocabulary(words),
  transcribe: (fromMs, toMs) => native.transcribe(fromMs, toMs),
  turnScore: (fromMs, toMs) => native.turnScore(fromMs, toMs),
  speak: (item) => native.speak(item.id, item.text, ++seq),
  duck: (level) => native.duck(level),
  stopSpeech: (fadeMs) => native.stopSpeech(fadeMs, ++seq),
  selfTest: () => native.selfTest(),
  addListener: (event, listener) => native.addListener(event, listener),
};
