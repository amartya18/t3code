import { expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({
  speak: vi.fn<(id: string, text: string, seq: number) => Promise<void>>(() => Promise.resolve()),
  stopSpeech: vi.fn<(fadeMs: number, seq: number) => void>(),
}));

vi.mock("expo", () => ({ requireOptionalNativeModule: () => native }));

import { voiceEngine } from "./index";

it("stamps a stop between the speech sent before it and after it", async () => {
  const engine = voiceEngine!;
  await engine.speak({ id: "before", text: "One." });
  engine.stopSpeech(80);
  await engine.speak({ id: "after", text: "Two." });

  const [before, after] = native.speak.mock.calls.map(([, , seq]) => seq);
  const [[fadeMs, stop]] = native.stopSpeech.mock.calls as [[number, number]];
  expect(fadeMs).toBe(80);
  expect(before).toBeLessThan(stop);
  expect(after).toBeGreaterThan(stop);
});
