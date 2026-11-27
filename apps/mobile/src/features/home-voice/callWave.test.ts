import { describe, expect, it } from "vite-plus/test";

import { callGlow, callWaveHeights, SWEEPS, waveBar, type WaveMoment } from "./callWave";

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
