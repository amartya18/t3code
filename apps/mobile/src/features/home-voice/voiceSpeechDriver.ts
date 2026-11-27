import type { VoiceEngine, VoiceEngineConfig } from "../../../modules/t3-voice-mode";
import {
  needsTicks,
  openVoiceSpeech,
  stepVoiceSpeech,
  type VoiceSpeechConfig,
  type VoiceSpeechEffect,
  type VoiceSpeechEvent,
  type VoiceSpeechState,
} from "./voiceSpeech";

const TICK_MS = 100;
/** The engine only sets a volume, so a duck steps there instead of jumping. */
const DUCK_STEPS = 4;
const DUCK_STEP_MS = 20;

// A hung-up session's stop must finish before the next session starts: native start does not wait for it.
let stopping: Promise<unknown> = Promise.resolve();

export interface VoiceSpeechInputs {
  readonly engineConfig: VoiceEngineConfig;
  readonly config: VoiceSpeechConfig;
  /** Queues Amar's words in the voice thread. */
  readonly send: (text: string) => Promise<unknown>;
}

export interface VoiceSpeechDriver {
  readonly dispatch: (event: VoiceSpeechEvent) => void;
  readonly update: (inputs: VoiceSpeechInputs) => void;
  readonly dispose: () => void;
}

/** Runs the speech state machine against the engine: its events in, its effects out. */
export function createVoiceSpeechDriver(options: {
  readonly engine: VoiceEngine;
  readonly inputs: VoiceSpeechInputs;
  readonly previous: VoiceSpeechState | null;
  readonly now: () => number;
  readonly log: (line: string) => void;
  readonly onChange: (state: VoiceSpeechState, config: VoiceSpeechConfig) => void;
}): VoiceSpeechDriver {
  const { engine, now } = options;
  let inputs = options.inputs;
  let state: VoiceSpeechState;
  let ticker: ReturnType<typeof setInterval> | null = null;
  let volume = 1;
  let ramp: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  const duck = (level: number) => {
    if (ramp !== null) clearInterval(ramp);
    const from = volume;
    let step = 0;
    const next = () => {
      step += 1;
      volume = from + ((level - from) * step) / DUCK_STEPS;
      engine.duck(volume);
      if (step === DUCK_STEPS && ramp !== null) {
        clearInterval(ramp);
        ramp = null;
      }
    };
    next();
    ramp = setInterval(next, DUCK_STEP_MS);
  };

  const dispatch = (event: VoiceSpeechEvent) => {
    if (disposed) return;
    apply(stepVoiceSpeech(state, event, inputs.config));
  };

  const apply = (step: { state: VoiceSpeechState; effects: ReadonlyArray<VoiceSpeechEffect> }) => {
    if (step.state !== state) {
      state = step.state;
      options.onChange(state, inputs.config);
    }
    if (needsTicks(state) && ticker === null) {
      ticker = setInterval(() => dispatch({ type: "tick", atMs: now() }), TICK_MS);
    } else if (!needsTicks(state) && ticker !== null) {
      clearInterval(ticker);
      ticker = null;
    }
    for (const effect of step.effects) run(effect);
  };

  const run = (effect: VoiceSpeechEffect) => {
    switch (effect.type) {
      case "checkModels":
        void engine
          .configure(inputs.engineConfig)
          .then(() => engine.modelStatus())
          .then(
            (status) => dispatch({ type: "modelStatus", ready: status.state === "ready" }),
            (error) => dispatch({ type: "startFailed", code: errorCode(error) }),
          );
        return;
      case "download":
        engine.downloadModels().then(
          () => dispatch({ type: "models", state: "ready", part: null, fraction: 1 }),
          (error) => {
            // A remounted session finds the first download still running; its events keep coming.
            if (errorCode(error) !== "busy") {
              dispatch({ type: "models", state: "failed", part: null, fraction: 0 });
            }
          },
        );
        return;
      case "start":
        stopping
          .then(() => engine.stop())
          .then(() => engine.start())
          .then(
            () => dispatch({ type: "started" }),
            (error) => dispatch({ type: "startFailed", code: errorCode(error) }),
          );
        return;
      case "setMuted":
        engine.setMuted(effect.muted);
        return;
      case "finalize":
        engine.finalize().then(
          (result) => dispatch({ type: "finalized", text: result.text, atMs: now() }),
          () => dispatch({ type: "finalized", text: "", atMs: now() }),
        );
        return;
      case "discardTranscript":
        engine.finalize().catch(() => {});
        return;
      case "send":
        inputs.send(effect.text).then(
          () => dispatch({ type: "sent", ok: true, atMs: now() }),
          () => dispatch({ type: "sent", ok: false, atMs: now() }),
        );
        return;
      case "speak":
        // `speak` rejects without a playback event when the engine never took the item.
        engine
          .speak({ id: effect.id, text: effect.text })
          .catch(() =>
            dispatch({ type: "playback", id: effect.id, state: "stopped", atMs: now() }),
          );
        return;
      case "stopSpeech":
        engine.stopSpeech(effect.fadeMs);
        return;
      case "duck":
        duck(effect.level);
        return;
      case "log":
        if (inputs.engineConfig.logStages) options.log(effect.line);
        return;
    }
  };

  const subscriptions = [
    engine.addListener("vad", (event) =>
      dispatch({ type: "vad", speaking: event.speaking, atMs: now() }),
    ),
    engine.addListener("partial", (event) =>
      dispatch({ type: "partial", text: event.text, atMs: now() }),
    ),
    engine.addListener("eou", (event) => dispatch({ type: "eou", text: event.text, atMs: now() })),
    engine.addListener("playback", (event) =>
      dispatch({ type: "playback", id: event.id, state: event.state, atMs: now() }),
    ),
    engine.addListener("models", (event) =>
      dispatch({ type: "models", state: event.state, part: event.part, fraction: event.fraction }),
    ),
    engine.addListener("route", (event) => dispatch({ type: "route", output: event.output })),
    engine.addListener("interruption", (event) =>
      dispatch({ type: "interruption", phase: event.phase }),
    ),
    engine.addListener("stage", (event) => {
      if (inputs.engineConfig.logStages) options.log(`[voice] stage ${event.name}`);
    }),
    engine.addListener("error", (event) =>
      dispatch({ type: "error", code: event.code, message: event.message }),
    ),
  ];

  const opened = openVoiceSpeech(options.previous);
  state = opened.state;
  options.onChange(state, inputs.config);
  apply(opened);

  return {
    dispatch,
    update(next) {
      const reconfigure = JSON.stringify(next.engineConfig) !== JSON.stringify(inputs.engineConfig);
      inputs = next;
      if (reconfigure && !disposed) {
        engine.configure(next.engineConfig).catch((error) => {
          dispatch({ type: "error", code: errorCode(error), message: String(error) });
        });
      }
    },
    dispose() {
      disposed = true;
      if (ticker !== null) clearInterval(ticker);
      if (ramp !== null) clearInterval(ramp);
      for (const subscription of subscriptions) subscription.remove();
      engine.stopSpeech(0);
      stopping = engine.stop().catch(() => {});
    },
  };
}

function errorCode(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : "unknown";
}
