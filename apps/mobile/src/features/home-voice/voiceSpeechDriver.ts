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
/** Dev logs: a JS block this long is logged with the voice step that came just before it. */
const STALL_CHECK_MS = 100;
const STALL_LOG_MS = 250;

// A hung-up session's stop must finish before the next session starts: native start does not wait for it.
let stopping: Promise<unknown> = Promise.resolve();

export interface VoiceSpeechInputs {
  readonly engineConfig: VoiceEngineConfig;
  readonly config: VoiceSpeechConfig;
  /** Queues Amar's words in the voice thread under `messageId`. */
  readonly send: (text: string, messageId: string) => Promise<unknown>;
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
  /** Names Parakeet should favour in this call. */
  readonly vocabulary: ReadonlyArray<string>;
  readonly now: () => number;
  readonly newMessageId: () => string;
  readonly log: (line: string) => void;
  readonly onReady: () => void;
  readonly onHangUp: () => void;
  readonly onChange: (state: VoiceSpeechState, config: VoiceSpeechConfig) => void;
}): VoiceSpeechDriver {
  const { engine, now } = options;
  let inputs = options.inputs;
  const openedAt = now();
  const devLog = (line: string) => {
    if (inputs.engineConfig.logStages) options.log(`${sinceOpen(now() - openedAt)} ${line}`);
  };
  let lastStep = { name: "open", atMs: now() };
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
    if (event.type !== "tick") lastStep = { name: event.type, atMs: now() };
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
    if (effect.type !== "log") lastStep = { name: effect.type, atMs: now() };
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
            () => {
              engine
                .setVocabulary(options.vocabulary)
                .catch((error) => devLog(`[voice] word list failed: ${errorCode(error)}`));
              dispatch({ type: "started" });
            },
            (error) => dispatch({ type: "startFailed", code: errorCode(error) }),
          );
        return;
      case "setMuted":
        engine.setMuted(effect.muted);
        return;
      case "scoreTurn":
        engine.turnScore(effect.fromMs, effect.toMs).then(
          (result) =>
            dispatch({
              type: "scored",
              toMs: effect.toMs,
              probability: result.probability,
              atMs: now(),
            }),
          (error) => devLog(`[voice] turn score failed: ${errorCode(error)}`),
        );
        return;
      case "transcribe": {
        const heard = (text: string) =>
          dispatch({
            type: "transcribed",
            fromMs: effect.fromMs,
            text,
            messageId: options.newMessageId(),
            atMs: now(),
          });
        engine.transcribe(effect.fromMs, effect.toMs).then(
          (result) => heard(result.text),
          (error) => {
            devLog(`[voice] transcribe failed: ${errorCode(error)}`);
            heard("");
          },
        );
        return;
      }
      case "send": {
        const { messageId } = effect;
        const startedAt = now();
        inputs.send(effect.text, messageId).then(
          () => dispatch({ type: "sent", ok: true, messageId, atMs: now() }),
          () => dispatch({ type: "sent", ok: false, messageId, atMs: now() }),
        );
        devLog(`[voice] send ran ${Math.round(now() - startedAt)}ms before returning`);
        return;
      }
      case "speak":
        devLog(`[voice] speak ${effect.id}`);
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
      case "ready":
        options.onReady();
        return;
      case "hangUp":
        options.onHangUp();
        return;
      case "log":
        devLog(effect.line);
        return;
    }
  };

  const subscriptions = [
    engine.addListener("vad", (event) =>
      dispatch({ type: "vad", speaking: event.speaking, speechMs: event.atMs, atMs: now() }),
    ),
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
    engine.addListener("stage", (event) => devLog(`[voice] stage ${event.name}`)),
    engine.addListener("error", (event) =>
      dispatch({ type: "error", code: event.code, message: event.message }),
    ),
  ];

  let due = now() + STALL_CHECK_MS;
  const watchdog = inputs.engineConfig.logStages
    ? setInterval(() => {
        const at = now();
        const late = at - due;
        if (late > STALL_LOG_MS) {
          const after = Math.max(0, Math.round(due - lastStep.atMs));
          devLog(`[voice] js blocked ${Math.round(late)}ms, ${after}ms after ${lastStep.name}`);
        }
        due = at + STALL_CHECK_MS;
      }, STALL_CHECK_MS)
    : null;

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
      if (watchdog !== null) clearInterval(watchdog);
      for (const subscription of subscriptions) subscription.remove();
      engine.stopSpeech(0);
      stopping = engine.stop().catch(() => {});
    },
  };
}

/** Stamps a dev log line with the time since this session's engine opened. */
function sinceOpen(ms: number): string {
  return `+${(ms / 1000).toFixed(3)}s`;
}

function errorCode(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : "unknown";
}
