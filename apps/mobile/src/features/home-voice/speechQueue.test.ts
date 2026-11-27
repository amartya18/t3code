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
  function barge(headphones = false) {
    let state: BargeInState = INITIAL_BARGE_IN_STATE;
    let speaking = true;
    const effects: BargeInEffect[] = [];
    const send = (event: Omit<BargeInEvent, "atMs"> & Partial<BargeInEvent>) => {
      const step = stepBargeIn(state, { ...event, atMs: 0 } as BargeInEvent, {
        speaking,
        headphones,
      });
      state = step.state;
      effects.push(...step.effects);
    };
    return {
      effects,
      send,
      finishReply: () => {
        speaking = false;
      },
    };
  }
  const { duckLevel, fadeMs } = DEFAULT_BARGE_IN_CONFIG;

  it("ducks on his voice, then stops at his first word", () => {
    const voice = barge();
    voice.send({ type: "vad", speaking: true });
    expect(voice.effects).toEqual([{ type: "duck", level: duckLevel }]);

    voice.send({ type: "partial", text: "yes" });
    expect(voice.effects.slice(1)).toEqual([{ type: "interrupt", fadeMs }]);
  });

  it("stops at a word heard before the voice detector fires", () => {
    const voice = barge();
    voice.send({ type: "partial", text: "wait" });
    expect(voice.effects).toEqual([{ type: "interrupt", fadeMs }]);
  });

  it("keeps ducking through a partial with no words", () => {
    const voice = barge();
    voice.send({ type: "vad", speaking: true });
    voice.send({ type: "partial", text: " " });
    expect(voice.effects).toEqual([{ type: "duck", level: duckLevel }]);
  });

  it("unducks when his voice ends without a word", () => {
    const voice = barge();
    voice.send({ type: "vad", speaking: true });
    voice.send({ type: "vad", speaking: false });
    expect(voice.effects).toEqual([
      { type: "duck", level: duckLevel },
      { type: "duck", level: 1 },
    ]);
  });

  it("on headphones, stops at his voice alone", () => {
    const voice = barge(true);
    voice.send({ type: "vad", speaking: true });
    expect(voice.effects).toEqual([{ type: "interrupt", fadeMs }]);
  });

  it("unducks when the reply ends on its own", () => {
    const voice = barge();
    voice.send({ type: "vad", speaking: true });
    voice.finishReply();
    voice.send({ type: "partial", text: "thanks" });
    expect(voice.effects).toEqual([
      { type: "duck", level: duckLevel },
      { type: "duck", level: 1 },
    ]);
  });

  it("does nothing when the voice is silent", () => {
    const voice = barge(true);
    voice.finishReply();
    voice.send({ type: "vad", speaking: true });
    voice.send({ type: "partial", text: "next question" });
    expect(voice.effects).toEqual([]);
  });
});
