import { expect, it } from "vite-plus/test";

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

function open(engine: VoiceEngine) {
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
    now: () => 0,
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
