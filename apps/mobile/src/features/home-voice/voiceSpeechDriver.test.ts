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

function open(
  engine: VoiceEngine,
  now: () => number = () => 0,
  log: ((line: string) => void) | null = null,
) {
  return createVoiceSpeechDriver({
    engine,
    inputs: {
      engineConfig: {
        asr: { chunkMs: 320, eouDebounceMs: 640 },
        vad: { threshold: 0.5, minSpeechMs: 150, minSilenceMs: 300 },
        tts: { voiceId: "af_heart", speed: 1, vocoderFloat32: false },
        aec: { enabled: false },
        logStages: log !== null,
      },
      config: DEFAULT_VOICE_SPEECH_CONFIG,
      send: async () => {},
    },
    previous: null,
    now,
    newMessageId: () => "m1",
    log: log ?? (() => {}),
    onReady: () => {},
    onHangUp: () => {},
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
  let clock = 0;
  const driver = open(engine, () => clock);
  await settle();
  driver.dispatch({
    type: "thread",
    replies: [{ id: "r1", text: "A long answer that keeps going.", streaming: false }],
    userMessageIds: new Set(),
    lastLine: null,
    atMs: 0,
  });

  listeners.get("vad")!({ speaking: true, probability: 1, atMs: 0 });
  vi.advanceTimersByTime(200);
  const ducked = levels.splice(0);
  expect(ducked.length).toBeGreaterThan(2);
  expect(ducked.at(-1)).toBe(DEFAULT_VOICE_SPEECH_CONFIG.bargeIn.duckLevel);
  expect(ducked).toEqual([...ducked].sort((left, right) => right - left));

  clock = 200;
  listeners.get("vad")!({ speaking: false, probability: 0, atMs: clock });
  clock = 1_200;
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

it("in development, logs a blocked JS thread with the voice step just before it", () => {
  vi.useFakeTimers();
  let clock = 0;
  const logs: string[] = [];
  const driver = open(
    { ...fakeEngine().engine, stop: async () => {} },
    () => clock,
    (line) => {
      logs.push(line);
    },
  );
  driver.dispatch({ type: "holdStart", atMs: clock });

  clock = 1_600;
  vi.advanceTimersByTime(100);
  expect(logs).toContain("+1.600s [voice] js blocked 1500ms, 100ms after holdStart");

  driver.dispose();
  vi.useRealTimers();
});

it("in development, stamps each line with the time since the session opened, on arrival", async () => {
  vi.useFakeTimers();
  let clock = 5_000;
  const logs: string[] = [];
  const listeners = new Map<string, (event: unknown) => void>();
  const engine: VoiceEngine = {
    ...fakeEngine().engine,
    stop: async () => {},
    addListener: (name, listener) => {
      listeners.set(name, listener as (event: unknown) => void);
      return { remove: () => {} };
    },
  };
  const driver = open(
    engine,
    () => clock,
    (line) => {
      logs.push(line);
    },
  );
  await settle();
  clock = 5_250;
  driver.dispatch({
    type: "thread",
    replies: [{ id: "r1", text: "Hello there.", streaming: false }],
    userMessageIds: new Set(),
    lastLine: null,
    atMs: clock,
  });
  clock = 5_400;
  listeners.get("stage")!({ name: "synth.start:r1:0.0", atMs: 5_390 });

  expect(logs).toEqual([
    "+0.250s [voice] speak r1:0.0",
    "+0.400s [voice] stage synth.start:r1:0.0",
  ]);

  driver.dispose();
  vi.useRealTimers();
});
