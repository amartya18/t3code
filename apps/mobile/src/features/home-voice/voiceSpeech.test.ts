import { describe, expect, it } from "vite-plus/test";

import { speechChunks } from "./speakable";
import type { BargeInConfig } from "./speechQueue";
import {
  DEFAULT_VOICE_SPEECH_CONFIG,
  isHearing,
  liveWords,
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

const TIMER_ONLY: VoiceSpeechConfig = {
  ...DEFAULT_VOICE_SPEECH_CONFIG,
  endOfTurn: { ...DEFAULT_VOICE_SPEECH_CONFIG.endOfTurn, earlySend: false },
};

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
  let now = 0;
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
  const engine = {
    transcript: "",
    muted: false,
    volume: 1,
    downloading: false,
    discarded: 0,
    readyCues: 0,
    hangUps: 0,
    stops: [] as number[],
    synthesizing: [] as Array<{ id: string; text: string }>,
  };
  const sent: string[] = [];
  const played: string[] = [];
  const logs: string[] = [];

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
      case "finalize": {
        const text = engine.transcript;
        engine.transcript = "";
        const messageId = `m${++ids}`;
        answers.push(() => send({ type: "finalized", text, messageId }));
        return;
      }
      case "discardTranscript":
        engine.transcript = "";
        engine.discarded += 1;
        return;
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
      stepVoiceSpeech(
        state,
        { ...input, atMs: now } as VoiceSpeechEvent,
        options.config ?? TIMER_ONLY,
      ),
    );
  };

  const settle = () => {
    while (answers.length > 0) answers.shift()!();
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
    say(text: string) {
      if (state.turn.kind !== "speaking") send({ type: "vad", speaking: true });
      engine.transcript = text;
      send({ type: "partial", text });
      settle();
    },
    stopTalking() {
      send({ type: "vad", speaking: false });
      settle();
    },
    /** Advances the clock in 100 ms steps, ticking only while the machine asks for ticks. */
    wait(ms: number) {
      for (let elapsed = 0; elapsed < ms; elapsed += 100) {
        now += 100;
        if (needsTicks(state)) send({ type: "tick" });
        settle();
      }
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

describe("voice speech", () => {
  it("sends a spoken turn after the pause and logs its latency through the first audio", () => {
    const voice = call();
    expect(voice.state().engine.kind).toBe("listening");

    voice.say("what is home doing");
    voice.stopTalking();
    voice.wait(2_900);
    expect(voice.sent).toEqual([]);
    expect(liveWords(voice.state())).toBe("what is home doing");

    voice.engine.transcript = "What is Home doing?";
    voice.wait(100);
    expect(voice.sent).toEqual(["What is Home doing?"]);
    expect(liveWords(voice.state())).toBeNull();
    expect(needsTicks(voice.state())).toBe(false);

    voice.reply("r1", "Home is idle.", true);
    voice.reply("r1", "Home is idle. No threads are running.");
    voice.playAll();
    expect(voice.played).toEqual(["Home is idle. No threads are running."]);
    expect(voice.logs).toEqual([
      "[voice] turn 1 (pause) from vad speech end: finalized +3000ms, sent +3000ms, first text +3000ms, first speak +3000ms, first audio +3000ms",
    ]);
  });

  it("counts the pause and its latency log from his real end of speech", () => {
    const voice = call({
      config: {
        ...DEFAULT_VOICE_SPEECH_CONFIG,
        endOfTurn: { ...DEFAULT_VOICE_SPEECH_CONFIG.endOfTurn, earlySend: false, vadEndLagMs: 300 },
      },
    });
    voice.say("what is home doing");
    voice.wait(300);
    voice.stopTalking();
    voice.engine.transcript = "What is Home doing?";
    voice.wait(2_600);
    expect(voice.sent).toEqual([]);

    voice.wait(100);
    expect(voice.sent).toEqual(["What is Home doing?"]);
    voice.reply("r1", "Home is idle. No threads are running.");
    voice.playAll();
    expect(voice.logs).toEqual([
      "[voice] turn 1 (pause) from real speech end: finalized +3000ms, sent +3000ms, first text +3000ms, first speak +3000ms, first audio +3000ms",
    ]);
  });

  it("keeps his line on screen from the end of his turn until the thread has it", () => {
    const voice = call();
    voice.holdDelivery();
    voice.say("merge it");
    voice.stopTalking();
    voice.wait(2_900);
    expect(voice.state().own).toBeNull();

    voice.wait(100);
    expect(voice.state().own).toEqual({ text: "merge it", messageId: "m1" });
    voice.reply("r0", "An older reply.");
    expect(voice.state().own).toEqual({ text: "merge it", messageId: "m1" });

    voice.deliver();
    expect(voice.state().own).toBeNull();
  });

  it("drops his line when it could not be queued", () => {
    const voice = call();
    voice.say("merge it");
    voice.stopTalking();
    voice.wait(3_000);
    voice.send({ type: "sent", ok: false, messageId: "m1" });
    expect(voice.state().own).toBeNull();
  });

  it("never plays a reply Amar talked past before it started", () => {
    const voice = call();
    voice.say("what is Home doing");
    voice.stopTalking();
    voice.wait(3_000);

    voice.say("actually, never mind");
    voice.reply("r1", "Home is checking three threads.", true);
    voice.stopTalking();
    voice.holdDelivery();
    voice.wait(3_000);
    voice.reply("r1", "Home is checking three threads. One is waiting on you.");
    expect(voice.engine.synthesizing).toEqual([]);
    expect(voice.state().shown.get("r1")).toEqual({ kind: "whole" });

    voice.deliver();
    voice.reply("r2", "Okay, never mind.");
    voice.playAll();
    expect(voice.played).toEqual(["Okay, never mind."]);
  });

  it("sends at once on a tap in the pause", () => {
    const voice = call();
    voice.say("merge it");
    voice.stopTalking();
    voice.wait(500);
    voice.send({ type: "tap" });
    expect(voice.sent).toEqual(["merge it"]);
  });

  it("speaks a streaming reply chunk by chunk, as each chunk completes", () => {
    const voice = call();
    voice.reply("r1", `${ONE} ${TWO}`, true);
    expect(voice.engine.synthesizing).toEqual([]);

    voice.reply("r1", `${ONE} ${TWO} ${THREE} PR 43`, true);
    expect(voice.engine.synthesizing.map((item) => item.text)).toEqual([`${ONE} ${TWO} ${THREE}`]);

    voice.reply("r1", `${ONE} ${TWO} ${THREE} PR 43 merged an hour ago.`);
    voice.playAll();
    expect(voice.played).toEqual([`${ONE} ${TWO} ${THREE}`, "PR 43 merged an hour ago."]);
  });

  it("stops the voice when Amar talks over it, and stale sentences never play", () => {
    const voice = call();
    voice.reply("r1", `${ONE} ${TWO} ${THREE} Second`, true);
    const [first] = voice.engine.synthesizing;
    voice.send({ type: "playback", id: first!.id, state: "started" });

    voice.send({ type: "vad", speaking: true });
    expect(voice.engine.volume).toBe(DEFAULT_VOICE_SPEECH_CONFIG.bargeIn.duckLevel);
    voice.engine.transcript = "wait";
    voice.send({ type: "partial", text: "wait" });
    expect(voice.engine.stops).toEqual([DEFAULT_VOICE_SPEECH_CONFIG.bargeIn.fadeMs]);
    expect(liveWords(voice.state())).toBe("wait");

    voice.reply("r1", `${ONE} ${TWO} ${THREE} Second sentence here. Third sentence here.`);
    expect(voice.engine.synthesizing).toEqual([]);

    voice.say("wait, ask Home instead");
    voice.stopTalking();
    voice.wait(3_000);
    expect(voice.sent).toEqual(["wait, ask Home instead"]);

    voice.reply("r2", "Asking Home.");
    expect(voice.engine.volume).toBe(1);
    voice.playAll();
    expect(voice.played).toEqual(["Asking Home."]);
  });

  it("ducks for a sound with no words and plays on, and the sound starts no turn", () => {
    const voice = call();
    voice.reply("r1", "A long answer that keeps going.");
    voice.send({ type: "vad", speaking: true });
    expect(voice.engine.volume).toBe(DEFAULT_VOICE_SPEECH_CONFIG.bargeIn.duckLevel);
    voice.wait(100);
    voice.send({ type: "vad", speaking: false });
    voice.wait(5_000);

    expect(voice.engine.stops).toEqual([]);
    expect(voice.engine.volume).toBe(1);
    expect(voice.state().turn.kind).toBe("idle");

    voice.playAll();
    expect(voice.played).toEqual(["A long answer that keeps going."]);
    expect(voice.sent).toEqual([]);
  });

  it("without echo cancellation, only a tap stops the voice", () => {
    const voice = call({ config: { ...TIMER_ONLY, voiceBargeIn: false } });
    voice.reply("r1", "One. Two. Three.");
    voice.send({ type: "vad", speaking: true });
    voice.engine.transcript = "one two";
    voice.send({ type: "partial", text: "one two" });
    voice.wait(2_000);
    expect(voice.engine.volume).toBe(1);
    expect(voice.engine.stops).toEqual([]);

    voice.send({ type: "tap" });
    expect(voice.engine.stops).toHaveLength(1);
    voice.playAll();
    expect(voice.sent).toEqual([]);
  });

  it("drops speech whose playback never reports back, and listens again", () => {
    const voice = call({ config: { ...TIMER_ONLY, voiceBargeIn: false } });
    voice.reply("r1", "This sentence never plays.");
    voice.wait(29_000);
    expect(voice.engine.stops).toEqual([]);

    voice.wait(2_000);
    expect(voice.engine.stops).toHaveLength(1);
    voice.say("are you there");
    voice.stopTalking();
    voice.wait(3_500);
    expect(voice.sent).toEqual(["are you there"]);
  });

  it("without echo cancellation, a tap stops the voice and drops what the mic overheard", () => {
    const voice = call({ config: { ...TIMER_ONLY, voiceBargeIn: false } });
    voice.reply("r1", "One. Two. Three.");
    voice.send({ type: "partial", text: "one" });
    voice.send({ type: "tap" });
    expect(voice.engine.stops).toHaveLength(1);
    expect(voice.engine.discarded).toBe(1);
    voice.playAll();
    expect(voice.played).toEqual([]);
  });

  it("drops the words in progress on mute and hears nothing until unmuted", () => {
    const voice = call();
    voice.say("never mind");
    voice.send({ type: "muted", muted: true });
    expect(voice.engine.muted).toBe(true);
    expect(voice.engine.discarded).toBe(1);
    expect(liveWords(voice.state())).toBeNull();

    voice.send({ type: "partial", text: "secret" });
    voice.wait(5_000);
    expect(voice.sent).toEqual([]);

    voice.send({ type: "muted", muted: false });
    voice.say("ok go");
    voice.stopTalking();
    voice.wait(3_000);
    expect(voice.sent).toEqual(["ok go"]);
  });

  it("downloads missing models first and speaks what arrived meanwhile once it listens", () => {
    const voice = call({ models: "missing" });
    expect(voice.engine.downloading).toBe(true);

    voice.send({ type: "models", state: "downloading", part: "asr", fraction: 0.5 });
    expect(voice.state().engine).toEqual({ kind: "downloading", fraction: 0.24 });
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

  it("hears Amar while his voice is on, settles in his pause, and ignores sound over the agent", () => {
    const voice = call();
    expect(isHearing(voice.state())).toBe(false);

    voice.say("merge it");
    expect(isHearing(voice.state())).toBe(true);
    voice.stopTalking();
    expect(isHearing(voice.state())).toBe(false);
    voice.send({ type: "vad", speaking: true });
    expect(isHearing(voice.state())).toBe(true);
    voice.stopTalking();
    voice.wait(3_000);

    voice.reply("r1", "A long answer that keeps going.");
    voice.send({ type: "vad", speaking: true });
    expect(isHearing(voice.state())).toBe(false);
    voice.send({ type: "vad", speaking: false });

    voice.send({ type: "muted", muted: true });
    voice.send({ type: "vad", speaking: true });
    expect(isHearing(voice.state())).toBe(false);
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

describe("ending the call", () => {
  const sayLine = (voice: ReturnType<typeof call>, text: string) => {
    voice.say(text);
    voice.stopTalking();
    voice.wait(3_000);
  };

  it("hangs up once the goodbye to Amar's bye has played, never voicing the marker", () => {
    const voice = call();
    sayLine(voice, "Okay, that's all, bye.");
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
    sayLine(voice, "Bye bye, wait, one more thing.");
    voice.reply("r1", "Sure, go ahead. [end call]");
    voice.playAll();
    expect(voice.played).toEqual(["Sure, go ahead."]);
    expect(voice.engine.hangUps).toBe(0);
  });

  it("never ends the call on the agent's own initiative", () => {
    const voice = call();
    sayLine(voice, "What is Home doing?");
    voice.reply("r1", "Home is idle. [end call]");
    voice.playAll();
    expect(voice.engine.hangUps).toBe(0);
  });

  it("ignores a marker anywhere but the very end of the reply", () => {
    const voice = call();
    sayLine(voice, "Bye.");
    voice.reply("r1", "Bye. [end call] Anything else before you go?");
    voice.playAll();
    expect(voice.played).toEqual(["Bye. Anything else before you go?"]);
    expect(voice.engine.hangUps).toBe(0);
  });

  it("stays on when Amar talks over the goodbye", () => {
    const voice = call();
    sayLine(voice, "Bye.");
    voice.reply("r1", `${ONE} ${TWO} ${THREE} Bye for now. [end call]`);
    const [first] = voice.engine.synthesizing;
    voice.send({ type: "playback", id: first!.id, state: "started" });
    voice.say("wait, one more thing");
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
    expect(voice.state().shown.get("r1")).toEqual({ kind: "spoken", text: OPENER });
    voice.send({ type: "playback", id: first!.id, state: "finished" });
    voice.send({ type: "playback", id: second!.id, state: "started" });
    expect(voice.state().shown.get("r1")).toEqual({ kind: "spoken", text: REPLY });
    voice.send({ type: "playback", id: second!.id, state: "finished" });
    expect(voice.state().shown.get("r1")).toEqual({ kind: "whole" });
  });

  it("keeps only what played when Amar cuts the reply off", () => {
    const voice = call();
    voice.reply("r1", REPLY, true);
    const [first] = voice.engine.synthesizing;
    voice.send({ type: "playback", id: first!.id, state: "started" });
    voice.send({ type: "partial", text: "wait" });
    voice.reply("r1", `${REPLY} It found two more threads.`);
    voice.playAll();

    expect(voice.state().shown.get("r1")).toEqual({ kind: "spoken", text: OPENER });
  });

  it("shows a reply whole when it is cut off before it plays a word", () => {
    const voice = call();
    voice.reply("r1", REPLY);
    voice.send({ type: "partial", text: "wait" });
    expect(voice.state().shown.get("r1")).toEqual({ kind: "whole" });
  });

  it("shows replies whole while the voice can't speak them", () => {
    const voice = call({ models: "missing" });
    voice.reply("r1", "Hi. Home is idle.");
    expect(voice.state().shown.get("r1")).toEqual({ kind: "whole" });
  });
});

describe("interrupting the voice", () => {
  const LONG = `${ONE} ${TWO} ${THREE} PR 43 merged an hour ago, and its checks are all green now.`;
  const CHUNKS = speechChunks(LONG);

  function playing(bargeIn: Partial<BargeInConfig>) {
    const voice = call({
      config: { ...TIMER_ONLY, bargeIn: { ...TIMER_ONLY.bargeIn, ...bargeIn } },
    });
    voice.reply("r1", LONG);
    return voice;
  }

  function startNext(voice: ReturnType<typeof call>) {
    voice.send({ type: "playback", id: voice.engine.synthesizing[0]!.id, state: "started" });
  }

  /** A sound with no words: the detector hears it for `ms`, then nothing. */
  function cough(voice: ReturnType<typeof call>, ms: number) {
    voice.send({ type: "vad", speaking: true });
    voice.wait(ms);
    voice.stopTalking();
  }

  const { duckLevel, fadeMs } = TIMER_ONLY.bargeIn;

  it("reads a long reply as more than one chunk", () => {
    expect(CHUNKS.length).toBeGreaterThan(1);
  });

  it("anySound stops the voice the moment the detector fires", () => {
    const voice = playing({ mode: "anySound" });
    startNext(voice);
    voice.send({ type: "vad", speaking: true });
    expect(voice.engine.stops).toEqual([fadeMs]);
    expect(voice.logs).toEqual([
      "[voice] interrupt anySound: onset +0ms, word none, duck none, stop +0ms",
    ]);
  });

  it("words ignores the detector, and stops at the first word with its delay logged", () => {
    const voice = playing({ mode: "words" });
    startNext(voice);
    voice.send({ type: "vad", speaking: true });
    voice.wait(300);
    expect(voice.engine.volume).toBe(1);
    expect(voice.engine.stops).toEqual([]);

    voice.engine.transcript = "wait";
    voice.send({ type: "partial", text: "wait" });
    expect(voice.engine.stops).toEqual([fadeMs]);
    expect(liveWords(voice.state())).toBe("wait");
    expect(voice.logs).toEqual([
      "[voice] interrupt words: onset +0ms, word +300ms, duck none, stop +300ms",
    ]);
  });

  it("words never stops for a sound that brings no words", () => {
    const voice = playing({ mode: "words" });
    startNext(voice);
    cough(voice, 200);
    voice.wait(3_000);
    expect(voice.engine.stops).toEqual([]);
    voice.playAll();
    expect(voice.played).toEqual(CHUNKS);
  });

  it("hybrid ducks at the detector and stops at the first word", () => {
    const voice = playing({ mode: "hybrid" });
    startNext(voice);
    voice.send({ type: "vad", speaking: true });
    expect(voice.engine.volume).toBe(duckLevel);
    voice.wait(400);
    voice.engine.transcript = "hold on";
    voice.send({ type: "partial", text: "hold on" });
    expect(voice.engine.stops).toEqual([fadeMs]);
    expect(voice.logs).toEqual([
      "[voice] interrupt hybrid: onset +0ms, word +400ms, duck +0ms, stop +400ms",
    ]);
  });

  it("hybrid restores the volume after a cough, and resume plays on", () => {
    const voice = playing({ mode: "hybrid", recovery: "resume" });
    startNext(voice);
    cough(voice, 100);
    voice.wait(400);
    expect(voice.engine.volume).toBe(duckLevel);
    voice.wait(200);
    expect(voice.engine.volume).toBe(1);
    expect(voice.engine.stops).toEqual([]);
    expect(voice.logs).toEqual([
      "[voice] interrupt hybrid: onset +0ms, word none, duck +0ms, restore +600ms",
      "[voice] recover hybrid resume: paused 600ms, restored volume",
    ]);
    voice.playAll();
    expect(voice.played).toEqual(CHUNKS);
    expect(voice.sent).toEqual([]);
  });

  it("hybrid keeps the duck while the sound goes on, until it has been quiet for words", () => {
    const voice = playing({ mode: "hybrid", recovery: "resume" });
    startNext(voice);
    cough(voice, 1_500);
    expect(voice.engine.volume).toBe(duckLevel);
    voice.wait(400);
    expect(voice.engine.volume).toBe(1);
    expect(voice.logs.at(-1)).toBe("[voice] recover hybrid resume: paused 1900ms, restored volume");
  });

  it("restart plays the cut chunk again from its start, then the rest", () => {
    const voice = playing({ mode: "hybrid", recovery: "restart" });
    voice.playNext();
    startNext(voice);
    cough(voice, 100);
    voice.wait(600);
    expect(voice.engine.stops).toEqual([fadeMs]);
    expect(voice.engine.volume).toBe(1);
    expect(voice.logs.at(-1)).toBe(
      "[voice] recover hybrid restart: paused 600ms, replayed the chunk",
    );
    expect(voice.state().shown.get("r1")).toEqual({ kind: "spoken", text: CHUNKS[0] });

    voice.playAll();
    expect(voice.played).toEqual(CHUNKS);
    expect(voice.state().shown.get("r1")).toEqual({ kind: "whole" });
  });

  it("smart plays on after a short pause", () => {
    const voice = playing({ mode: "hybrid", recovery: "smart", smartCutoffMs: 1_000 });
    startNext(voice);
    cough(voice, 100);
    voice.wait(600);
    expect(voice.engine.stops).toEqual([]);
    expect(voice.logs.at(-1)).toBe("[voice] recover hybrid smart: paused 600ms, restored volume");
  });

  it("smart restarts the chunk after a long pause", () => {
    const voice = playing({ mode: "hybrid", recovery: "smart", smartCutoffMs: 1_000 });
    startNext(voice);
    cough(voice, 800);
    voice.wait(400);
    expect(voice.engine.stops).toEqual([fadeMs]);
    expect(voice.logs.at(-1)).toBe(
      "[voice] recover hybrid smart: paused 1200ms, replayed the chunk",
    );
    voice.playAll();
    expect(voice.played).toEqual(CHUNKS);
  });

  it("after anySound stops for a cough, even resume replays the chunk, and no turn is sent", () => {
    const voice = playing({ mode: "anySound", recovery: "resume" });
    startNext(voice);
    cough(voice, 100);
    expect(voice.engine.stops).toEqual([fadeMs]);
    expect(voice.engine.synthesizing).toEqual([]);
    voice.wait(600);
    expect(voice.logs.at(-1)).toBe(
      "[voice] recover anySound resume: paused 600ms, replayed the chunk",
    );
    expect(voice.state().turn.kind).toBe("idle");

    voice.playAll();
    expect(voice.played).toEqual(CHUNKS);
    voice.wait(5_000);
    expect(voice.sent).toEqual([]);
  });

  it("after anySound stops for real words, nothing replays and the words are sent", () => {
    const voice = playing({ mode: "anySound" });
    startNext(voice);
    voice.say("stop, ask Home instead");
    voice.stopTalking();
    voice.wait(3_500);
    expect(voice.engine.synthesizing).toEqual([]);
    expect(voice.sent).toEqual(["stop, ask Home instead"]);
  });
});
