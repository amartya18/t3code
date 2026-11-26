import { describe, expect, it } from "vite-plus/test";

import {
  bargeIn,
  DEFAULT_BARGE_IN_CONFIG,
  EMPTY_SPEECH_QUEUE,
  enqueue,
  INITIAL_BARGE_IN_STATE,
  isSpeaking,
  onPlayback,
  stepBargeIn,
  type BargeInEffect,
  type BargeInEvent,
  type BargeInState,
  type SpeechItem,
  type SpeechQueue,
} from "./speechQueue";

/** A fake engine: plays what it was handed with `speak`, in order. */
function engine() {
  let queue: SpeechQueue = EMPTY_SPEECH_QUEUE;
  let synthesizing: string[] = [];
  const played: string[] = [];
  const handed = (speak: ReadonlyArray<SpeechItem>) => {
    synthesizing = [...synthesizing, ...speak.map((item) => item.id)];
  };
  return {
    played,
    queue: () => queue,
    synthesizing: () => synthesizing,
    add(id: string, source: SpeechItem["source"], revision = queue.revision) {
      const step = enqueue(queue, { id, text: `text of ${id}`, source, revision });
      queue = step.queue;
      handed(step.speak);
    },
    finishNext() {
      const [id] = synthesizing;
      if (id === undefined) return;
      synthesizing = synthesizing.slice(1);
      played.push(id);
      queue = onPlayback(queue, { id, state: "started" }).queue;
      const step = onPlayback(queue, { id, state: "finished" });
      queue = step.queue;
      handed(step.speak);
    },
    playAll() {
      while (synthesizing.length > 0) this.finishNext();
    },
    bargeIn() {
      const step = bargeIn(queue);
      queue = step.queue;
      synthesizing = [];
      return step.stop;
    },
  };
}

describe("speech queue", () => {
  it("plays items in the order they arrive", () => {
    const voice = engine();
    for (const id of ["f1", "f2", "f3", "f4", "f5"]) voice.add(id, "front");
    voice.playAll();
    expect(voice.played).toEqual(["f1", "f2", "f3", "f4", "f5"]);
    expect(isSpeaking(voice.queue())).toBe(false);
  });

  it("hands the engine only a few items ahead", () => {
    const voice = engine();
    for (const id of ["f1", "f2", "f3", "f4", "f5"]) voice.add(id, "front");
    expect(voice.synthesizing()).toEqual(["f1", "f2", "f3"]);
  });

  it("plays a home item queued after front items ahead of the front items still waiting", () => {
    const voice = engine();
    for (const id of ["f1", "f2", "f3", "f4", "f5"]) voice.add(id, "front");
    voice.add("h1", "home");
    voice.add("h2", "home");
    voice.playAll();
    expect(voice.played).toEqual(["f1", "f2", "f3", "h1", "h2", "f4", "f5"]);
  });

  it("drops queued items on a barge-in and returns the ones to stop", () => {
    const voice = engine();
    for (const id of ["f1", "f2", "f3", "f4", "f5"]) voice.add(id, "front");
    voice.finishNext();

    expect(voice.bargeIn()).toEqual(["f2", "f3", "f4"]);
    voice.playAll();
    expect(voice.played).toEqual(["f1"]);
    expect(isSpeaking(voice.queue())).toBe(false);
  });

  it("never speaks an item that arrives late with a stale revision", () => {
    const voice = engine();
    voice.add("f1", "front");
    const replyRevision = voice.queue().revision;
    voice.bargeIn();

    voice.add("f2-late", "front", replyRevision);
    voice.add("next-reply", "front");
    voice.playAll();
    expect(voice.played).toEqual(["next-reply"]);
  });

  it("ignores playback events for items it no longer holds", () => {
    const voice = engine();
    voice.add("f1", "front");
    const [stopped] = voice.bargeIn();
    voice.add("f2", "front");

    const step = onPlayback(voice.queue(), { id: stopped ?? "", state: "stopped" });
    expect(step.queue).toEqual(voice.queue());
    expect(step.speak).toEqual([]);
  });
});

describe("stepBargeIn", () => {
  function barge() {
    let state: BargeInState = INITIAL_BARGE_IN_STATE;
    let now = 0;
    let speaking = true;
    const effects: Array<BargeInEffect & { atMs: number }> = [];
    const send = (event: Omit<BargeInEvent, "atMs"> & Partial<BargeInEvent>) => {
      const step = stepBargeIn(state, { ...event, atMs: now } as BargeInEvent, speaking);
      state = step.state;
      effects.push(...step.effects.map((effect) => ({ ...effect, atMs: now })));
    };
    return {
      effects,
      send,
      finishReply: () => {
        speaking = false;
      },
      wait(ms: number) {
        for (let elapsed = 0; elapsed < ms; elapsed += 50) {
          now += Math.min(50, ms - elapsed);
          send({ type: "tick" });
        }
      },
    };
  }
  const { duckLevel, fadeMs } = DEFAULT_BARGE_IN_CONFIG;

  it("ducks at once, then stops with a fade after 300 ms of speech with words", () => {
    const voice = barge();
    voice.send({ type: "vad", speaking: true });
    expect(voice.effects).toEqual([{ type: "duck", level: duckLevel, atMs: 0 }]);

    voice.wait(100);
    voice.send({ type: "partial", text: "wait, stop" });
    voice.wait(150);
    expect(voice.effects).toHaveLength(1);
    voice.wait(50);
    expect(voice.effects.slice(1)).toEqual([{ type: "interrupt", fadeMs, atMs: 300 }]);
  });

  it("keeps ducking past 300 ms until a partial has words", () => {
    const voice = barge();
    voice.send({ type: "vad", speaking: true });
    voice.send({ type: "partial", text: " " });
    voice.wait(600);
    expect(voice.effects.map((effect) => effect.type)).toEqual(["duck"]);
    voice.send({ type: "partial", text: "hold on" });
    expect(voice.effects.slice(1)).toEqual([{ type: "interrupt", fadeMs, atMs: 600 }]);
  });

  it("unducks when the speech ends before it is confirmed", () => {
    const voice = barge();
    voice.send({ type: "vad", speaking: true });
    voice.send({ type: "partial", text: "mm" });
    voice.wait(200);
    voice.send({ type: "vad", speaking: false });
    voice.wait(500);
    expect(voice.effects).toEqual([
      { type: "duck", level: duckLevel, atMs: 0 },
      { type: "duck", level: 1, atMs: 200 },
    ]);
  });

  it("unducks when the reply ends on its own", () => {
    const voice = barge();
    voice.send({ type: "vad", speaking: true });
    voice.wait(100);
    voice.finishReply();
    voice.send({ type: "partial", text: "thanks" });
    voice.wait(500);
    expect(voice.effects).toEqual([
      { type: "duck", level: duckLevel, atMs: 0 },
      { type: "duck", level: 1, atMs: 100 },
    ]);
  });

  it("does nothing when the voice is silent", () => {
    const voice = barge();
    voice.finishReply();
    voice.send({ type: "vad", speaking: true });
    voice.send({ type: "partial", text: "next question" });
    voice.wait(1_000);
    expect(voice.effects).toEqual([]);
  });
});
