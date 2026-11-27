import { expect, it, vi } from "vite-plus/test";

import type { VoiceEngine, VoiceEngineConfig } from "../../../modules/t3-voice-mode";
import { DEFAULT_VOICE_TUNING, voiceEngineConfig, voiceSpeechConfig } from "./voiceEngine";
import { createVoiceSpeechDriver } from "./voiceSpeechDriver";

vi.mock("react-native", () => ({ Platform: { OS: "ios", Version: "26.0" } }));
vi.mock("../../../modules/t3-voice-mode", () => ({ voiceEngine: null }));
vi.stubGlobal("__DEV__", false);

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
    setVocabulary: async (words) => {
      calls.push(`setVocabulary ${words.join(", ")}`);
    },
    transcribe: async () => ({ text: "" }),
    turnScore: async () => ({ probability: 1 }),
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

function engineConfig(logStages: boolean): VoiceEngineConfig {
  return { ...voiceEngineConfig("af_heart", DEFAULT_VOICE_TUNING), logStages };
}

function inputs(config: VoiceEngineConfig, send: (text: string) => Promise<unknown>) {
  return { engineConfig: config, config: voiceSpeechConfig(DEFAULT_VOICE_TUNING), send };
}

function open(
  engine: VoiceEngine,
  now: () => number = () => 0,
  log: ((line: string) => void) | null = null,
  send: (text: string) => Promise<unknown> = async () => {},
) {
  return createVoiceSpeechDriver({
    engine,
    inputs: inputs(engineConfig(log !== null), send),
    previous: null,
    vocabulary: ["T3", "laptop13"],
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
  expect(fake.calls.slice(-3)).toEqual(["stopped", "start", "setVocabulary T3, laptop13"]);
});

it("gives Parakeet the call's word list once the engine has started", async () => {
  const fake = fakeEngine();
  open({ ...fake.engine, stop: async () => {} });
  await settle();
  expect(fake.calls).toEqual(["start", "setVocabulary T3, laptop13"]);
});

it("feeds new detector holds from the sliders to the live engine without restarting it", async () => {
  const fake = fakeEngine();
  const configured: VoiceEngineConfig["vad"][] = [];
  const engine: VoiceEngine = {
    ...fake.engine,
    stop: async () => {},
    configure: async (config) => {
      configured.push(config.vad);
    },
  };
  const driver = open(engine);
  await settle();
  const tuning = { ...DEFAULT_VOICE_TUNING, minSpeechMs: 900, minSilenceMs: 1_200 };
  driver.update(inputs(voiceEngineConfig("af_heart", tuning), async () => {}));
  await settle();

  expect(configured.at(-1)).toMatchObject({ minSpeechMs: 900, minSilenceMs: 1_200 });
  expect(fake.calls.filter((call) => call === "start")).toHaveLength(1);
  driver.dispose();
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

  listeners.get("vad")!({ speaking: true, probability: 1, level: 0.5, atMs: 0 });
  vi.advanceTimersByTime(200);
  const ducked = levels.splice(0);
  expect(ducked.length).toBeGreaterThan(2);
  expect(ducked.at(-1)).toBe(0.25);
  expect(ducked).toEqual([...ducked].sort((left, right) => right - left));

  clock = 200;
  listeners.get("vad")!({ speaking: false, probability: 0, level: 0, atMs: clock });
  vi.advanceTimersByTime(200);
  expect(levels.length).toBeGreaterThan(2);
  expect(levels.at(-1)).toBe(1);
  expect(levels).toEqual([...levels].sort((left, right) => left - right));

  driver.dispose();
  vi.useRealTimers();
});

it("hands Smart Turn and Parakeet the engine's own times for his speech, and sends what Parakeet heard", async () => {
  const listeners = new Map<string, (event: unknown) => void>();
  const asked: string[] = [];
  const sent: string[] = [];
  const engine: VoiceEngine = {
    ...fakeEngine().engine,
    stop: async () => {},
    turnScore: async (fromMs, toMs) => {
      asked.push(`turnScore ${fromMs}-${toMs}`);
      return { probability: 0.9 };
    },
    transcribe: async (fromMs, toMs) => {
      asked.push(`transcribe ${fromMs}-${toMs}`);
      return { text: "Merge it." };
    },
    addListener: (name, listener) => {
      listeners.set(name, listener as (event: unknown) => void);
      return { remove: () => {} };
    },
  };
  const driver = open(
    engine,
    () => 1_800_000_000_000,
    null,
    async (text) => {
      sent.push(text);
    },
  );
  await settle();

  listeners.get("vad")!({ speaking: true, probability: 0.9, level: 0.4, atMs: 5_000 });
  listeners.get("vad")!({ speaking: false, probability: 0.1, level: 0, atMs: 6_200 });
  await settle();
  expect(asked).toEqual(["turnScore 5000-6200", "transcribe 4600-6200"]);
  expect(sent).toEqual(["Merge it."]);

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
  driver.dispatch({ type: "retry" });

  clock = 1_600;
  vi.advanceTimersByTime(100);
  expect(logs).toContain("+1.600s [voice] js blocked 1500ms, 100ms after retry");

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
  logs.splice(0);
  clock = 5_250;
  driver.dispatch({
    type: "thread",
    replies: [{ id: "r1", text: "Hello there.", streaming: false }],
    userMessageIds: new Set(),
    lastLine: null,
    atMs: clock,
  });
  clock = 5_400;
  listeners.get("stage")!({ name: "synth.start:r1:0", atMs: 5_390 });

  expect(logs).toEqual(["+0.250s [voice] speak r1:0", "+0.400s [voice] stage synth.start:r1:0"]);

  driver.dispose();
  vi.useRealTimers();
});

it("in development, logs the tuning the engine starts with", async () => {
  const logs: string[] = [];
  const driver = open(
    { ...fakeEngine().engine, stop: async () => {} },
    () => 0,
    (line) => {
      logs.push(line);
    },
  );
  await settle();

  expect(logs).toContain(
    "+0.000s [voice] tuning: threshold 0.5, min speech 250ms, silence before scoring 200ms, wait when not done 3000ms",
  );
  driver.dispose();
});
