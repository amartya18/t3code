import type { VoiceEngineEvents } from "../../../modules/t3-voice-mode";

/** The send highlight crosses the wave this many times, then the wave rests. */
export const SWEEPS = 2;

// Tuned against the engine's raw mic RMS (0 to 1).
/** Time constant of the level's rise toward a louder window. */
export const MIC_RISE_MS = 10;
/** Time constant of the level's fall toward a quieter window. */
export const MIC_FALL_MS = 100;
/** Raw RMS at or below this is room noise and reads as 0. */
export const MIC_FLOOR = 0.003;
/** The wave turns active once the level above the floor passes this. */
export const MIC_ACTIVE_LEVEL = 0.005;
// Measured on an iPhone with voice processing on: speech is about 0.04 typical, 0.12 loud.
/** Active levels at or below this swing at MIC_MIN_ENERGY. */
export const MIC_QUIET_LEVEL = 0.02;
export const MIC_LOUD_LEVEL = 0.25;
/** The smallest swing of an active wave, so quiet speech still shows. */
export const MIC_MIN_ENERGY = 0.1;

/** One moment of the call's wave and glow, read on the UI thread. */
export interface WaveMoment {
  /** How much the wave swings, 0 to 1, from the mic's level. */
  readonly energy: number;
  /** The ripple's position, in cycles. */
  readonly phase: number;
  /** The send sweep's progress, 0 to SWEEPS; at SWEEPS it rests. */
  readonly sweep: number;
}

/** Smooths toward one raw window `dtMs` after the last, with room noise below the floor removed. */
export function smoothMicLevel(previous: number, raw: number, dtMs: number): number {
  "worklet";
  const level = Math.max(0, raw - MIC_FLOOR);
  const timeMs = level > previous ? MIC_RISE_MS : MIC_FALL_MS;
  const keep = timeMs > 0 ? Math.exp(-Math.max(0, dtMs) / timeMs) : 0;
  return level + (previous - level) * keep;
}

export function micWaveEnergy(level: number): number {
  "worklet";
  if (level <= MIC_ACTIVE_LEVEL) return 0;
  const loudness = Math.log(level / MIC_QUIET_LEVEL) / Math.log(MIC_LOUD_LEVEL / MIC_QUIET_LEVEL);
  return MIC_MIN_ENERGY + (1 - MIC_MIN_ENERGY) * Math.min(1, Math.max(0, loudness));
}

export function followMicLevel(
  engine: {
    addListener(
      event: "micLevel",
      listener: (event: VoiceEngineEvents["micLevel"]) => void,
    ): { remove(): void };
  },
  level: { set(value: number): void },
): () => void {
  let smoothed = 0;
  let lastAtMs = Number.NEGATIVE_INFINITY;
  const subscription = engine.addListener("micLevel", (event) => {
    smoothed = event.level === 0 ? 0 : smoothMicLevel(smoothed, event.level, event.atMs - lastAtMs);
    lastAtMs = event.atMs;
    level.set(smoothed);
  });
  return () => {
    subscription.remove();
    level.set(0);
  };
}

/** The pill's contour; the call's wave repeats it under a hump. */
export const PILL_WAVE = [3, 5, 8, 5, 10, 6, 3, 7, 4, 3];

export function callWaveHeights(count: number, tallest: number): ReadonlyArray<number> {
  return Array.from({ length: count }, (_, index) => {
    const contour = PILL_WAVE[index % PILL_WAVE.length]! / 10;
    const hump = Math.sin((Math.PI * (index + 0.5)) / count);
    return Math.round(tallest * (0.35 + 0.65 * contour) * (0.45 + 0.55 * hump));
  });
}

// Reanimated's Babel plugin turns worklet declarations into unhoisted assignments; keep this above waveBar.
function sweepHighlight(sweep: number, at: number): number {
  "worklet";
  if (sweep <= 0 || sweep >= SWEEPS) return 0;
  const head = (sweep % 1) * 1.5 - 0.25;
  return Math.max(0, 1 - Math.abs(at - head) * 5);
}

/**
 * One bar: its scale against its full height, and its tint from grey (0) to blue (1). It sits at
 * `rest`, swings toward `peak` while he talks, and bumps as the send sweep passes.
 */
export function waveBar(
  moment: WaveMoment,
  index: number,
  count: number,
  rest: number,
  peak: number,
): { readonly scale: number; readonly tint: number } {
  "worklet";
  const swing = 0.5 + 0.5 * Math.sin(2 * Math.PI * (moment.phase + index * 0.17));
  const live = rest + (peak - rest) * moment.energy * swing;
  const highlight = sweepHighlight(moment.sweep, index / Math.max(1, count - 1));
  return {
    scale: Math.max(live, rest * (1 + 1.6 * highlight)),
    tint: Math.max(moment.energy, highlight),
  };
}

/** The glow behind the controls: rises while he talks, pulses low through the sweep. */
export function callGlow({ energy, sweep }: Pick<WaveMoment, "energy" | "sweep">): {
  readonly opacity: number;
  readonly scale: number;
} {
  "worklet";
  const sweeping = sweep > 0 && sweep < SWEEPS;
  const fade = Math.min(1, sweep / 0.15, (SWEEPS - sweep) / 0.25);
  const pulse = 0.5 - 0.5 * Math.cos(2 * Math.PI * sweep);
  const sending = sweeping ? (0.12 + 0.1 * pulse) * fade : 0;
  return { opacity: Math.max(0.4 * energy, sending), scale: 0.35 + 0.52 * energy };
}
