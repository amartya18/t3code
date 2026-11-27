import { describe, expect, it } from "vite-plus/test";

import { speechChunks } from "./speakable";
import {
  isHearing,
  needsTicks,
  openVoiceSpeech,
  stepVoiceSpeech,
  type AgentReply,
  type VoiceSpeechConfig,
  type VoiceSpeechEffect,
  type VoiceSpeechEvent,
  type VoiceSpeechState,
  type VoiceSpeechStep,
} from "./voiceSpeech";

type Input = VoiceSpeechEvent extends infer E
  ? E extends { atMs: number }
    ? Omit<E, "atMs">
    : E
  : never;

const ONE = "Sure, I am checking on that.";
const TWO = "Home is working through the queue.";
const THREE = "It has three threads running right now.";

const CONFIG: VoiceSpeechConfig = {
  vad: { minSpeechMs: 250, minSilenceMs: 200 },
  voiceBargeIn: true,
};
const { minSpeechMs, minSilenceMs } = CONFIG.vad;

/** The engine keeps its own clock; times it reports must come back to it unchanged. */
const ENGINE_CLOCK_AHEAD_MS = 7_000_000;

/**
 * The speech state machine wired to a fake engine on a fake clock. Engine replies queue up
 * and run after every effect of a step, the way the native module answers asynchronously.
 */
function call(
  options: {
    readonly models?: "ready" | "missing";
    readonly startError?: string;
    readonly previous?: VoiceSpeechState;
    readonly config?: VoiceSpeechConfig;
  } = {},
) {
  let now = 1_000;
  const engineNow = () => now + ENGINE_CLOCK_AHEAD_MS;
  let state: VoiceSpeechState;
  let replies: AgentReply[] = [];
  let ids = 0;
  /** The thread has a line once the outbox delivers it; `delivering` false holds lines back. */
  const thread = {
    delivering: true,
    landed: new Set<string>(),
    lines: [] as string[],
    held: [] as Array<{ messageId: string; text: string }>,
  };
  const answers: Array<() => void> = [];
  const lateTranscripts: Array<() => void> = [];
  let talking: { readonly fromMs: number; readonly text: string } | null = null;
  const engine = {
    muted: false,
    volume: 1,
    downloading: false,
    readyCues: 0,
    hangUps: 0,
    stops: [] as number[],
    synthesizing: [] as Array<{ id: string; text: string }>,
    /** What the mic heard of Amar, on the engine's clock. */
    audio: [] as Array<{ fromMs: number; toMs: number; text: string }>,
    /** The ranges Parakeet was asked to transcribe. */
    transcribed: [] as Array<readonly [number, number]>,
    /** Smart Turn's score for the words of the turn so far. */
    smartTurn: (_words: string) => 0.9,
    /** Parakeet answers only when the test lets its transcripts arrive. */
    slowParakeet: false,
  };
  const sent: string[] = [];
  const played: string[] = [];
  const logs: string[] = [];

  const wordsBetween = (fromMs: number, toMs: number) =>
    engine.audio
      .filter((speech) => speech.fromMs >= fromMs && speech.fromMs < toMs)
      .map((speech) => speech.text)
      .join(" ");

  const run = (effect: VoiceSpeechEffect) => {
    switch (effect.type) {
      case "checkModels":
        answers.push(() => send({ type: "modelStatus", ready: options.models !== "missing" }));
        return;
      case "download":
        engine.downloading = true;
        return;
      case "start":
        answers.push(() =>
          send(
            options.startError === undefined
              ? { type: "started" }
              : { type: "startFailed", code: options.startError },
          ),
        );
        return;
      case "setMuted":
        engine.muted = effect.muted;
        return;
      case "scoreTurn": {
        const probability = engine.smartTurn(wordsBetween(effect.fromMs, effect.toMs));
        answers.push(() => send({ type: "scored", toMs: effect.toMs, probability }));
        return;
      }
      case "transcribe": {
        const { fromMs, toMs } = effect;
        engine.transcribed.push([fromMs, toMs]);
        const messageId = `m${++ids}`;
        const answer = () =>
          send({ type: "transcribed", fromMs, text: wordsBetween(fromMs, toMs), messageId });
        (engine.slowParakeet ? lateTranscripts : answers).push(answer);
        return;
      }
      case "send":
        sent.push(effect.text);
        if (thread.delivering) land(effect.messageId, effect.text);
        else thread.held.push({ messageId: effect.messageId, text: effect.text });
        answers.push(() => send({ type: "sent", ok: true, messageId: effect.messageId }));
        return;
      case "speak":
        engine.synthesizing.push({ id: effect.id, text: effect.text });
        return;
      case "stopSpeech": {
        const doomed = engine.synthesizing;
        engine.synthesizing = [];
        engine.stops.push(effect.fadeMs);
        for (const item of doomed) {
          answers.push(() => send({ type: "playback", id: item.id, state: "stopped" }));
        }
        return;
      }
      case "duck":
        engine.volume = effect.level;
        return;
      case "log":
        logs.push(effect.line);
        return;
      case "ready":
        engine.readyCues += 1;
        return;
      case "hangUp":
        engine.hangUps += 1;
        return;
    }
  };

  const apply = (step: VoiceSpeechStep) => {
    state = step.state;
    for (const effect of step.effects) run(effect);
  };

  const send = (input: Input) => {
    apply(
      stepVoiceSpeech(state, { ...input, atMs: now } as VoiceSpeechEvent, options.config ?? CONFIG),
    );
  };

  const settle = () => {
    while (answers.length > 0) answers.shift()!();
  };

  /** Advances the clock, ticking every 100 ms only while the machine asks for ticks. */
  const wait = (ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 100) {
      now += Math.min(100, ms - elapsed);
      if (needsTicks(state)) send({ type: "tick" });
      settle();
    }
  };

  const land = (messageId: string, text: string) => {
    thread.landed.add(messageId);
    thread.lines.push(text);
  };

  const threadChanged = () =>
    send({
      type: "thread",
      replies,
      userMessageIds: new Set(thread.landed),
      lastLine: thread.lines.at(-1) ?? null,
    });

  /** He starts talking now; the detector reports it once the voice has held long enough. */
  const startTalking = (text: string) => {
    const fromMs = engineNow();
    talking = { fromMs, text };
    wait(minSpeechMs);
    send({ type: "vad", speaking: true, speechMs: fromMs });
    settle();
    return fromMs;
  };

  /** He stops now; the detector reports it once the silence has held long enough. */
  const stopTalking = () => {
    const speech = talking!;
    talking = null;
    const toMs = engineNow();
    engine.audio.push({ fromMs: speech.fromMs, toMs, text: speech.text });
    wait(minSilenceMs);
    send({ type: "vad", speaking: false, speechMs: toMs });
    settle();
    return toMs;
  };

  apply(openVoiceSpeech(options.previous ?? null));
  settle();

  return {
    engine,
    sent,
    played,
    logs,
    state: () => state,
    send(input: Input) {
      send(input);
      settle();
    },
    wait,
    startTalking,
    stopTalking,
    /** He says `text` for `ms`; returns when the speech really started and ended, on the engine's clock. */
    talk(text: string, ms = 800) {
      const fromMs = startTalking(text);
      wait(ms - minSpeechMs);
      return { fromMs, toMs: stopTalking() };
    },
    transcriptsArrive() {
      for (const answer of lateTranscripts.splice(0)) answer();
      settle();
    },
    reply(id: string, text: string, streaming = false) {
      replies = [...replies.filter((reply) => reply.id !== id), { id, text, streaming }];
      threadChanged();
      settle();
    },
    holdDelivery() {
      thread.delivering = false;
    },
    /** A line typed rather than spoken: it lands in the thread without the mic. */
    type(text: string) {
      land(`typed-${thread.lines.length}`, text);
      threadChanged();
      settle();
    },
    deliver() {
      for (const line of thread.held.splice(0)) land(line.messageId, line.text);
      thread.delivering = true;
      threadChanged();
      settle();
    },
    /** Starts the oldest sentence the engine was handed. */
    startNext() {
      send({ type: "playback", id: engine.synthesizing[0]!.id, state: "started" });
      settle();
    },
    /** Plays the oldest sentence the engine was handed, start to finish. */
    playNext() {
      const item = engine.synthesizing.shift();
      if (item === undefined) return;
      played.push(item.text);
      send({ type: "playback", id: item.id, state: "started" });
      send({ type: "playback", id: item.id, state: "finished" });
      settle();
    },
    playAll() {
      while (engine.synthesizing.length > 0) this.playNext();
    },
  };
}

describe("his turn", () => {
  it("sends as soon as Smart Turn calls it done, and logs its latency through the first audio", () => {
    const voice = call();
    expect(voice.state().engine.kind).toBe("listening");

    const speech = voice.talk("What is Home doing?");
    expect(voice.sent).toEqual(["What is Home doing?"]);
    expect(voice.engine.transcribed).toEqual([[speech.fromMs - 400, speech.toMs]]);
    expect(needsTicks(voice.state())).toBe(false);

    voice.wait(500);
    voice.reply("r1", "Home is idle.", true);
    voice.reply("r1", "Home is idle. No threads are running.");
    voice.playAll();
    expect(voice.played).toEqual(["Home is idle. No threads are running."]);
    expect(voice.logs).toEqual([
      "[voice] turn 1 from speech end: decided +200ms (Smart Turn 0.90), transcribed +200ms, sent +200ms, first text +700ms, first audio +700ms",
    ]);
  });

  it("waits out a pause Smart Turn calls unfinished, then sends after 2 s", () => {
    const voice = call();
    voice.engine.smartTurn = () => 0.2;
    voice.talk("So the deploy, and");
    voice.wait(1_900);
    expect(voice.sent).toEqual([]);

    voice.wait(100);
    expect(voice.sent).toEqual(["So the deploy, and"]);
    voice.reply("r1", "Which deploy?");
    voice.playAll();
    expect(voice.logs).toEqual([
      "[voice] turn 1 from speech end: decided +2200ms (Smart Turn 0.20, waited), transcribed +2200ms, sent +2200ms, first text +2200ms, first audio +2200ms",
    ]);
  });

  it("keeps one turn when he speaks again in the wait", () => {
    const voice = call();
    voice.engine.smartTurn = (words) => (words.endsWith("and") ? 0.2 : 0.9);
    voice.talk("Check the deploy and");
    voice.wait(1_000);
    voice.talk("tell me if it passed.");
    expect(voice.sent).toEqual(["Check the deploy and tell me if it passed."]);

    voice.wait(3_000);
    expect(voice.sent).toHaveLength(1);
  });

  it("transcribes a long turn's earlier pieces while he talks, and only the rest at its end", () => {
    const voice = call();
    voice.engine.smartTurn = (words) => (words.endsWith(",") ? 0.1 : 0.9);
    const first = voice.talk("First, the deploy failed,", 3_000);
    voice.wait(500);
    const second = voice.talk("then the retry passed,", 3_000);
    voice.wait(500);
    expect(voice.engine.transcribed).toEqual([
      [first.fromMs - 400, first.toMs],
      [first.toMs, second.toMs],
    ]);
    expect(voice.sent).toEqual([]);

    const third = voice.talk("so merge it.");
    expect(voice.engine.transcribed.at(-1)).toEqual([second.toMs, third.toMs]);
    expect(voice.engine.transcribed).toHaveLength(3);
    expect(voice.sent).toEqual(["First, the deploy failed, then the retry passed, so merge it."]);
  });

  it("sends nothing when no words came of it, and plays the reply that waited for it", () => {
    const voice = call();
    voice.engine.slowParakeet = true;
    voice.talk("");
    voice.reply("r1", "Home finished the deploy.");
    expect(voice.engine.synthesizing).toEqual([]);

    voice.transcriptsArrive();
    expect(voice.sent).toEqual([]);
    expect(voice.state().own).toBeNull();
    expect(voice.logs).toEqual([
      "[voice] turn 1 from speech end: decided +200ms (Smart Turn 0.90), transcribed +200ms, no words",
    ]);
    voice.playAll();
    expect(voice.played).toEqual(["Home finished the deploy."]);
  });

  it("shows his line once its words are known, until the thread has it", () => {
    const voice = call();
    voice.engine.slowParakeet = true;
    voice.holdDelivery();
    voice.talk("Merge it.");
    expect(voice.state().own).toBeNull();

    voice.transcriptsArrive();
    expect(voice.state().own).toEqual({ text: "Merge it.", messageId: "m1" });
    voice.reply("r0", "An older reply.");
    expect(voice.state().own).toEqual({ text: "Merge it.", messageId: "m1" });

    voice.deliver();
    expect(voice.state().own).toBeNull();
  });

  it("drops his line when it could not be queued", () => {
    const voice = call();
    voice.talk("Merge it.");
    voice.send({ type: "sent", ok: false, messageId: "m1" });
    expect(voice.state().own).toBeNull();
  });

  it("drops the turn in progress on mute and hears nothing until unmuted", () => {
    const voice = call();
    voice.startTalking("Never mind.");
    voice.send({ type: "muted", muted: true });
    expect(voice.engine.muted).toBe(true);
    expect(isHearing(voice.state())).toBe(false);
    voice.stopTalking();
    voice.talk("A secret.");
    voice.wait(5_000);
    expect(voice.sent).toEqual([]);

    voice.send({ type: "muted", muted: false });
    voice.talk("OK, go.");
    expect(voice.sent).toEqual(["OK, go."]);
  });

  it("hears Amar while his voice is on, settles in his pause, and ignores sound over the agent", () => {
    const voice = call();
    voice.engine.smartTurn = () => 0.2;
    expect(isHearing(voice.state())).toBe(false);

    voice.startTalking("Merge it");
    expect(isHearing(voice.state())).toBe(true);
    voice.stopTalking();
    expect(isHearing(voice.state())).toBe(false);
    voice.startTalking("now.");
    expect(isHearing(voice.state())).toBe(true);
    voice.stopTalking();
    voice.wait(2_000);

    voice.reply("r1", "A long answer that keeps going.");
    voice.send({ type: "vad", speaking: true, speechMs: 0 });
    expect(isHearing(voice.state())).toBe(false);
  });
});

describe("voice speech", () => {
  it("never plays a reply Amar talked past before it started", () => {
    const voice = call();
    voice.talk("What is Home doing?");

    voice.startTalking("Actually, never mind.");
    voice.reply("r1", "Home is checking three threads.", true);
    voice.holdDelivery();
    voice.stopTalking();
    voice.reply("r1", "Home is checking three threads. One is waiting on you.");
    expect(voice.engine.synthesizing).toEqual([]);
    expect(voice.state().shown.get("r1")).toEqual({ kind: "whole" });

    voice.deliver();
    voice.reply("r2", "Okay, never mind.");
    voice.playAll();
    expect(voice.played).toEqual(["Okay, never mind."]);
  });

  it("speaks a streaming reply chunk by chunk, as each chunk completes", () => {
    const voice = call();
    voice.reply("r1", ONE, true);
    expect(voice.engine.synthesizing).toEqual([]);

    voice.reply("r1", `${ONE} Home`, true);
    expect(voice.engine.synthesizing.map((item) => item.text)).toEqual([ONE]);

    voice.reply("r1", `${ONE} ${TWO} ${THREE} PR 43`, true);
    expect(voice.engine.synthesizing.map((item) => item.text)).toEqual([ONE]);

    voice.reply("r1", `${ONE} ${TWO} ${THREE} PR 43 merged an hour ago.`);
    voice.playAll();
    expect(voice.played).toEqual([ONE, `${TWO} ${THREE} PR 43 merged an hour ago.`]);
  });

  it("drops speech whose playback never reports back, and listens again", () => {
    const voice = call({ config: { ...CONFIG, voiceBargeIn: false } });
    voice.reply("r1", "This sentence never plays.");
    voice.wait(29_000);
    expect(voice.engine.stops).toEqual([]);

    voice.wait(2_000);
    expect(voice.engine.stops).toHaveLength(1);
    voice.talk("Are you there?");
    expect(voice.sent).toEqual(["Are you there?"]);
  });

  it("downloads missing models first and speaks what arrived meanwhile once it listens", () => {
    const voice = call({ models: "missing" });
    expect(voice.engine.downloading).toBe(true);

    voice.send({ type: "models", state: "downloading", part: "asr", fraction: 0.5 });
    const halfway = voice.state().engine;
    expect(halfway.kind === "downloading" ? halfway.fraction : null).toBeCloseTo(0.28);
    voice.reply("r1", "Hi. Home is idle.");
    expect(voice.engine.synthesizing).toEqual([]);

    voice.send({ type: "models", state: "failed", part: null, fraction: 0 });
    expect(voice.state().engine.kind).toBe("downloadFailed");
    voice.send({ type: "retry" });
    expect(voice.state().engine).toEqual({ kind: "downloading", fraction: 0 });

    voice.send({ type: "models", state: "ready", part: null, fraction: 1 });
    expect(voice.state().engine.kind).toBe("listening");
    voice.playAll();
    expect(voice.played).toEqual(["Hi. Home is idle."]);
  });

  it("cues once when it starts listening, and not again after an interruption", () => {
    const voice = call({ models: "missing" });
    expect(voice.engine.readyCues).toBe(0);

    voice.send({ type: "models", state: "ready", part: null, fraction: 1 });
    expect(voice.engine.readyCues).toBe(1);
    voice.send({ type: "interruption", phase: "began" });
    voice.send({ type: "interruption", phase: "ended" });
    expect(voice.engine.readyCues).toBe(1);
  });

  it("waits for microphone access", () => {
    const voice = call({ startError: "permission_denied" });
    expect(voice.state().engine.kind).toBe("micDenied");
  });

  it("goes quiet through an audio interruption and listens again after it", () => {
    const voice = call();
    voice.reply("r1", "One. Two.");
    voice.send({ type: "interruption", phase: "began" });
    expect(voice.state().engine.kind).toBe("interrupted");
    expect(voice.engine.stops).toEqual([0]);

    voice.send({ type: "interruption", phase: "ended" });
    voice.reply("r2", "Back.");
    voice.playAll();
    expect(voice.played).toEqual(["Back."]);
  });

  it("never repeats a reply after the engine restarts in the same session", () => {
    const first = call();
    first.reply("r1", "Already said.");
    first.playAll();

    const second = call({ previous: first.state() });
    second.reply("r1", "Already said.");
    second.reply("r2", "New.");
    second.playAll();
    expect(second.played).toEqual(["New."]);
  });
});

describe("interrupting the voice", () => {
  const LONG = `${ONE} ${TWO} ${THREE} PR 43 merged an hour ago, and its checks are all green now.`;
  const CHUNKS = speechChunks(LONG);

  function playing() {
    const voice = call();
    voice.reply("r1", LONG);
    voice.startNext();
    return voice;
  }

  it("reads a long reply as more than one chunk", () => {
    expect(CHUNKS.length).toBeGreaterThan(1);
  });

  it("ducks at his voice and stops once it outlasts the confirm; what he says is his next turn", () => {
    const voice = playing();
    const fromMs = voice.startTalking("Wait, ask Home instead.");
    expect(voice.engine.volume).toBe(0.25);
    voice.wait(200);
    expect(voice.engine.stops).toEqual([]);

    voice.wait(100);
    expect(voice.engine.stops).toEqual([80]);
    expect(isHearing(voice.state())).toBe(true);
    const toMs = voice.stopTalking();
    expect(voice.sent).toEqual(["Wait, ask Home instead."]);
    expect(voice.engine.transcribed).toEqual([[fromMs - 400, toMs]]);
    expect(voice.logs).toContain("[voice] interrupt from speech onset: duck +250ms, stop +550ms");

    voice.reply("r1", `${LONG} One more sentence here.`);
    expect(voice.engine.synthesizing).toEqual([]);
    voice.reply("r2", "Asking Home.");
    expect(voice.engine.volume).toBe(1);
    voice.playAll();
    expect(voice.played).toEqual(["Asking Home."]);
  });

  it("plays on at full volume after a blip shorter than the confirm, replaying nothing", () => {
    const voice = playing();
    voice.startTalking("");
    voice.stopTalking();
    expect(voice.engine.volume).toBe(1);
    expect(voice.engine.stops).toEqual([]);
    expect(voice.logs).toEqual([
      "[voice] interrupt from speech onset: duck +250ms, restore +450ms",
    ]);

    voice.wait(3_000);
    voice.playAll();
    expect(voice.played).toEqual(CHUNKS);
    expect(voice.sent).toEqual([]);
    expect(voice.state().turn.live.kind).toBe("idle");
  });

  it("keeps the duck for a reply that arrives under it", () => {
    const voice = playing();
    voice.startTalking("");
    voice.reply("r2", "Also, Home is idle.");
    expect(voice.engine.volume).toBe(0.25);
  });

  it("takes his voice over the agent's last words as his turn when the agent finishes first", () => {
    const voice = call();
    voice.reply("r1", "Done.");
    voice.startTalking("Thanks, now check the queue.");
    voice.playAll();
    expect(voice.engine.stops).toEqual([]);
    voice.stopTalking();
    expect(voice.sent).toEqual(["Thanks, now check the queue."]);
    expect(voice.logs).toContain("[voice] interrupt from speech onset: duck +250ms, end +250ms");
  });

  it("restores the volume when he mutes under a duck, and never stops the agent for it", () => {
    const voice = playing();
    voice.startTalking("");
    voice.send({ type: "muted", muted: true });
    expect(voice.engine.volume).toBe(1);
    voice.wait(1_000);
    expect(voice.engine.stops).toEqual([]);
  });
});

describe("ending the call", () => {
  it("hangs up once the goodbye to Amar's bye has played, never voicing the marker", () => {
    const voice = call();
    voice.talk("Okay, that's all, bye.");
    voice.reply("r1", "Bye, Amar. [end call]", true);
    voice.reply("r1", "Bye, Amar. [end call]");
    expect(voice.engine.synthesizing.map((item) => item.text)).toEqual(["Bye, Amar."]);
    expect(voice.engine.hangUps).toBe(0);

    voice.playAll();
    expect(voice.played).toEqual(["Bye, Amar."]);
    expect(voice.engine.hangUps).toBe(1);
  });

  it("hangs up at once when the voice can't speak the goodbye", () => {
    const voice = call({ startError: "permission_denied" });
    voice.type("I'm done.");
    voice.reply("r1", "Bye, Amar. [end call]");
    expect(voice.engine.hangUps).toBe(1);
  });

  it("stays on when Amar says bye and keeps going", () => {
    const voice = call();
    voice.talk("Bye bye, wait, one more thing.");
    voice.reply("r1", "Sure, go ahead. [end call]");
    voice.playAll();
    expect(voice.played).toEqual(["Sure, go ahead."]);
    expect(voice.engine.hangUps).toBe(0);
  });

  it("never ends the call on the agent's own initiative", () => {
    const voice = call();
    voice.talk("What is Home doing?");
    voice.reply("r1", "Home is idle. [end call]");
    voice.playAll();
    expect(voice.engine.hangUps).toBe(0);
  });

  it("ignores a marker anywhere but the very end of the reply", () => {
    const voice = call();
    voice.talk("Bye.");
    voice.reply("r1", "Bye. [end call] Anything else before you go?");
    voice.playAll();
    expect(voice.played).toEqual(["Bye. Anything else before you go?"]);
    expect(voice.engine.hangUps).toBe(0);
  });

  it("stays on when Amar talks over the goodbye", () => {
    const voice = call();
    voice.talk("Bye.");
    voice.reply("r1", `${ONE} ${TWO} ${THREE} Bye for now. [end call]`);
    voice.startNext();
    voice.startTalking("Wait, one more thing.");
    voice.wait(300);
    voice.playAll();
    expect(voice.engine.hangUps).toBe(0);
  });
});

describe("what the transcript shows of a reply", () => {
  const OPENER = `${ONE} ${TWO} ${THREE}`;
  const REPLY = `${OPENER} Home will report back soon.`;

  it("shows each chunk as it starts playing, then the whole reply once it has played", () => {
    const voice = call();
    voice.reply("r1", REPLY);
    expect(voice.state().shown.get("r1")).toBeUndefined();

    const [first, second] = voice.engine.synthesizing;
    voice.send({ type: "playback", id: first!.id, state: "started" });
    expect(voice.state().shown.get("r1")).toEqual({ kind: "spoken", text: ONE });
    voice.send({ type: "playback", id: first!.id, state: "finished" });
    voice.send({ type: "playback", id: second!.id, state: "started" });
    expect(voice.state().shown.get("r1")).toEqual({ kind: "spoken", text: REPLY });
    voice.send({ type: "playback", id: second!.id, state: "finished" });
    expect(voice.state().shown.get("r1")).toEqual({ kind: "whole" });
  });

  it("keeps only what played when Amar cuts the reply off", () => {
    const voice = call();
    voice.reply("r1", REPLY, true);
    voice.startNext();
    voice.startTalking("Wait.");
    voice.wait(300);
    voice.reply("r1", `${REPLY} It found two more threads.`);
    voice.playAll();

    expect(voice.state().shown.get("r1")).toEqual({ kind: "spoken", text: ONE });
  });

  it("shows a reply whole when it is cut off before it plays a word", () => {
    const voice = call();
    voice.reply("r1", REPLY);
    voice.startTalking("Wait.");
    voice.wait(300);
    expect(voice.state().shown.get("r1")).toEqual({ kind: "whole" });
  });

  it("shows replies whole while the voice can't speak them", () => {
    const voice = call({ models: "missing" });
    voice.reply("r1", "Hi. Home is idle.");
    expect(voice.state().shown.get("r1")).toEqual({ kind: "whole" });
  });
});
