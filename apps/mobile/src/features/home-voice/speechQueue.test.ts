import { describe, expect, it } from "vite-plus/test";

import {
  bargeIn,
  EMPTY_SPEECH_QUEUE,
  enqueue,
  isSpeaking,
  onPlayback,
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
