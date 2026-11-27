/** The send highlight crosses the wave this many times, then the wave rests. */
export const SWEEPS = 2;

/** One moment of the call's wave and glow, read on the UI thread. */
export interface WaveMoment {
  /** How much voice the mic hears, 0 to 1. Voice detection drives it today; a level can later. */
  readonly energy: number;
  /** The ripple's position, in cycles. */
  readonly phase: number;
  /** The send sweep's progress, 0 to SWEEPS; at SWEEPS it rests. */
  readonly sweep: number;
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
