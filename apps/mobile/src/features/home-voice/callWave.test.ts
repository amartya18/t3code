import { describe, expect, it } from "vite-plus/test";

import type { VoiceEngineEvents } from "../../../modules/t3-voice-mode";
import {
  callGlow,
  callWaveHeights,
  followMicLevel,
  MIC_FALL_MS,
  MIC_FLOOR,
  micWaveEnergy,
  smoothMicLevel,
  SWEEPS,
  waveBar,
  type WaveMoment,
} from "./callWave";

const COUNT = 29;
const REST = 0.1;
const idle: WaveMoment = { energy: 0, phase: 0, sweep: SWEEPS };

function bars(moment: WaveMoment) {
  return Array.from({ length: COUNT }, (_, index) => waveBar(moment, index, COUNT, REST, 1));
}

function brightest(moment: WaveMoment): number {
  const tints = bars(moment).map((bar) => bar.tint);
  return tints.indexOf(Math.max(...tints));
}

describe("callWaveHeights", () => {
  it("peaks in the middle and stays within the tallest bar", () => {
    const heights = callWaveHeights(COUNT, 30);
    expect(heights).toHaveLength(COUNT);
    expect(Math.max(...heights)).toBeLessThanOrEqual(30);
    expect(heights[0]!).toBeLessThan(Math.max(...heights.slice(10, 19)));
  });
});

describe("waveBar", () => {
  it("rests as grey dots when idle, whatever the phase", () => {
    for (const phase of [0, 0.3, 7.25]) {
      expect(bars({ ...idle, phase })).toEqual(
        Array.from({ length: COUNT }, () => ({ scale: REST, tint: 0 })),
      );
    }
  });

  it("turns blue and ripples while he talks", () => {
    const live = { energy: 1, phase: 0.2, sweep: SWEEPS };
    expect(bars(live).every((bar) => bar.tint === 1)).toBe(true);
    const later = bars({ ...live, phase: 0.6 });
    expect(bars(live).some((bar, index) => bar.scale !== later[index]!.scale)).toBe(true);
    expect(bars(live).every((bar) => bar.scale >= REST && bar.scale <= 1)).toBe(true);
  });

  it("sweeps the highlight left to right twice, then rests", () => {
    const pass = [0.2, 0.4, 0.6].map((sweep) => brightest({ ...idle, sweep }));
    expect(pass[0]!).toBeLessThan(pass[1]!);
    expect(pass[1]!).toBeLessThan(pass[2]!);
    expect(brightest({ ...idle, sweep: 1.4 })).toBe(pass[1]);
    expect(bars({ ...idle, sweep: SWEEPS })).toEqual(bars(idle));
  });

  it("grows the highlighted dot without reaching a talking bar's height", () => {
    const sweeping = bars({ ...idle, sweep: 0.5 });
    const top = Math.max(...sweeping.map((bar) => bar.scale));
    expect(top).toBeGreaterThan(REST);
    expect(top).toBeLessThan(0.5);
  });
});

describe("callGlow", () => {
  it("is dark when idle", () => {
    expect(callGlow(idle).opacity).toBe(0);
  });

  it("rises while he talks", () => {
    const live = callGlow({ energy: 1, sweep: SWEEPS });
    expect(live.opacity).toBeGreaterThan(0.3);
    expect(live.scale).toBeGreaterThan(callGlow(idle).scale);
  });

  it("glows low through the sweep and fades out by its end", () => {
    expect(callGlow({ ...idle, sweep: 0.5 }).opacity).toBeGreaterThan(0.1);
    expect(callGlow({ ...idle, sweep: 1.5 }).opacity).toBeGreaterThan(0.1);
    expect(callGlow({ ...idle, sweep: SWEEPS - 0.01 }).opacity).toBeLessThan(0.01);
    expect(callGlow({ ...idle, sweep: 0 }).opacity).toBe(0);
  });
});

describe("mic level", () => {
  const WINDOW_MS = 32;
  const SPEECH = 0.05;

  function settle(level: number, raw: number, ms: number): number {
    let next = level;
    for (let at = 0; at < ms; at += WINDOW_MS) next = smoothMicLevel(next, raw, WINDOW_MS);
    return next;
  }

  it("lights the wave on the first window of speech and never on room noise", () => {
    expect(micWaveEnergy(smoothMicLevel(0, SPEECH, WINDOW_MS))).toBe(1);
    expect(micWaveEnergy(settle(0, MIC_FLOOR, 2_000))).toBe(0);
    expect(micWaveEnergy(settle(0, MIC_FLOOR * 2, 2_000))).toBe(0);
  });

  it("holds through a pause between words and settles soon after speech stops", () => {
    const talking = settle(0, SPEECH, 500);
    expect(micWaveEnergy(settle(talking, 0.001, 150))).toBe(1);
    expect(micWaveEnergy(settle(talking, 0.001, 500))).toBe(0);
  });

  it("falls by e over the fall time", () => {
    const talking = smoothMicLevel(0, SPEECH, Number.POSITIVE_INFINITY);
    expect(smoothMicLevel(talking, 0, MIC_FALL_MS)).toBeCloseTo(talking / Math.E, 6);
  });

  it("writes the smoothed level to the wave until stopped, dropping at once when the mic goes quiet", () => {
    let listener: ((event: VoiceEngineEvents["micLevel"]) => void) | null = null;
    const engine = {
      addListener: (_event: "micLevel", next: (event: VoiceEngineEvents["micLevel"]) => void) => {
        listener = next;
        return { remove: () => (listener = null) };
      },
    };
    const written: number[] = [];
    const stop = followMicLevel(engine, { set: (value) => written.push(value) });
    const hear = (level: number, atMs: number) => listener?.({ level, atMs });

    hear(SPEECH, 1_000);
    hear(SPEECH / 2, 1_032);
    hear(0, 1_040);
    expect(written).toEqual([
      SPEECH - MIC_FLOOR,
      smoothMicLevel(SPEECH - MIC_FLOOR, SPEECH / 2, 32),
      0,
    ]);

    stop();
    expect(listener).toBeNull();
    expect(written.at(-1)).toBe(0);
  });
});
