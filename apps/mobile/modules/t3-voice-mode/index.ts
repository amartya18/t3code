import { requireOptionalNativeModule, type EventSubscription } from "expo";

/** `asr`, `aec` and `tts.vocoderFloat32` apply on the next `start()`; the rest at once. */
export interface VoiceEngineConfig {
  readonly asr: { readonly chunkMs: 160 | 320; readonly eouDebounceMs: number };
  readonly vad: {
    readonly threshold: number;
    readonly minSpeechMs: number;
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

/** Every `speak` item ends with exactly one `finished` or `stopped` playback event. */
export interface VoiceEngineEvents {
  readonly vad: { readonly speaking: boolean; readonly probability: number; readonly atMs: number };
  readonly partial: { readonly text: string };
  readonly eou: { readonly text: string };
  readonly playback: { readonly id: string; readonly state: "started" | "finished" | "stopped" };
  /** FluidAudio reports download progress per model as a fraction, never in bytes. */
  readonly models: {
    readonly state: "downloading" | "ready" | "failed";
    readonly part: "vad" | "asr" | "tts" | null;
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
  finalize(): Promise<{ readonly text: string }>;
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
  finalize: () => native.finalize(),
  speak: (item) => native.speak(item.id, item.text, ++seq),
  duck: (level) => native.duck(level),
  stopSpeech: (fadeMs) => native.stopSpeech(fadeMs, ++seq),
  selfTest: () => native.selfTest(),
  addListener: (event, listener) => native.addListener(event, listener),
};
