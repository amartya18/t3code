import { expect, it, vi } from "vite-plus/test";

import type { VoiceEngine } from "../../../modules/t3-voice-mode";
import { DEFAULT_VOICE_SPEECH_CONFIG } from "./voiceSpeech";
import { createVoiceSpeechDriver } from "./voiceSpeechDriver";

function fakeEngine() {
  const calls: string[] = [];
  let finishStop = () => {};
  const engine: VoiceEngine = {
    configure: async () => {},
    modelStatus: async () => ({ state: "ready", bytesOnDisk: 1 }),
    downloadModels: async () => {},
    deleteModels: async () => {},
    start: async () => {
      calls.push("start");
    },
    stop: () => {
      calls.push("stop");
      return new Promise<void>((resolve) => {
        finishStop = () => {
          calls.push("stopped");
          resolve();
        };
      });
    },
    setMuted: () => {},
    finalize: async () => ({ text: "" }),
    speak: async () => {},
    duck: () => {},
    stopSpeech: () => {
      calls.push("stopSpeech");
    },
    selfTest: async () => "",
    addListener: () => ({ remove: () => {} }),
  };
  return { engine, calls, finishStop: () => finishStop() };
}

function open(engine: VoiceEngine, now: () => number = () => 0) {
  return createVoiceSpeechDriver({
    engine,
    inputs: {
      engineConfig: {
        asr: { chunkMs: 320, eouDebounceMs: 640 },
        vad: { threshold: 0.5, minSpeechMs: 150, minSilenceMs: 300 },
        tts: { voiceId: "af_heart", speed: 1, vocoderFloat32: false },
        aec: { enabled: false },
        logStages: false,
      },
      config: DEFAULT_VOICE_SPEECH_CONFIG,
      send: async () => {},
    },
    previous: null,
    now,
    log: () => {},
    onChange: () => {},
  });
}

const settle = async () => {
  for (let turn = 0; turn < 10; turn++) await Promise.resolve();
};

it("hanging up mid-speech stops the voice, and the next call starts only after the stop finishes", async () => {
  const fake = fakeEngine();
  open(fake.engine).dispose();
  expect(fake.calls).toEqual(["stopSpeech", "stop"]);

  open(fake.engine);
  await settle();
  expect(fake.calls).not.toContain("start");

  fake.finishStop();
  await settle();
  fake.finishStop();
  await settle();
  expect(fake.calls.slice(-2)).toEqual(["stopped", "start"]);
});

it("ducks the voice in steps rather than one jump, and restores it the same way", async () => {
  vi.useFakeTimers();
  const levels: number[] = [];
  const listeners = new Map<string, (event: unknown) => void>();
  const engine: VoiceEngine = {
    ...fakeEngine().engine,
    stop: async () => {},
    duck: (level) => {
      levels.push(level);
    },
    addListener: (name, listener) => {
      listeners.set(name, listener as (event: unknown) => void);
      return { remove: () => {} };
    },
  };
  const driver = open(engine);
  await settle();
  driver.dispatch({
    type: "replies",
    replies: [{ id: "r1", text: "A long answer that keeps going.", streaming: false }],
    atMs: 0,
  });

  listeners.get("vad")!({ speaking: true, probability: 1, atMs: 0 });
  vi.advanceTimersByTime(200);
  const ducked = levels.splice(0);
  expect(ducked.length).toBeGreaterThan(2);
  expect(ducked.at(-1)).toBe(DEFAULT_VOICE_SPEECH_CONFIG.bargeIn.duckLevel);
  expect(ducked).toEqual([...ducked].sort((left, right) => right - left));

  listeners.get("vad")!({ speaking: false, probability: 0, atMs: 0 });
  vi.advanceTimersByTime(200);
  expect(levels.length).toBeGreaterThan(2);
  expect(levels.at(-1)).toBe(1);
  expect(levels).toEqual([...levels].sort((left, right) => left - right));

  driver.dispose();
  vi.useRealTimers();
});

it("counts the pause from when the engine heard his voice end, not when JS got the event", async () => {
  const listeners = new Map<string, (event: unknown) => void>();
  let finalized = 0;
  const engine: VoiceEngine = {
    ...fakeEngine().engine,
    stop: async () => {},
    finalize: async () => {
      finalized += 1;
      return { text: "merge it" };
    },
    addListener: (name, listener) => {
      listeners.set(name, listener as (event: unknown) => void);
      return { remove: () => {} };
    },
  };
  const driver = open(engine, () => 10_000);
  await settle();
  const { pauseMs } = DEFAULT_VOICE_SPEECH_CONFIG.endOfTurn;

  listeners.get("vad")!({ speaking: true, probability: 1, atMs: 8_000 });
  listeners.get("partial")!({ text: "merge it" });
  listeners.get("vad")!({ speaking: false, probability: 0, atMs: 8_500 });
  driver.dispatch({ type: "tick", atMs: 8_500 + pauseMs });
  expect(finalized).toBe(1);

  driver.dispose();
});
