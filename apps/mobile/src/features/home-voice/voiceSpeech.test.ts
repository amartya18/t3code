import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_VOICE_SPEECH_CONFIG,
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
  const answers: Array<() => void> = [];
  const engine = {
    transcript: "",
    muted: false,
    volume: 1,
    downloading: false,
    discarded: 0,
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
        answers.push(() => send({ type: "finalized", text }));
        return;
      }
      case "discardTranscript":
        engine.transcript = "";
        engine.discarded += 1;
        return;
      case "send":
        sent.push(effect.text);
        answers.push(() => send({ type: "sent", ok: true }));
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
      send({ type: "replies", replies });
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
    expect(liveWords(voice.state())).toEqual({ sending: null, current: "what is home doing" });

    voice.engine.transcript = "What is Home doing?";
    voice.wait(100);
    expect(voice.sent).toEqual(["What is Home doing?"]);
    expect(liveWords(voice.state())).toEqual({ sending: null, current: null });
    expect(needsTicks(voice.state())).toBe(false);

    voice.reply("r1", "Home is idle.", true);
    voice.reply("r1", "Home is idle. No threads are running.");
    voice.playAll();
    expect(voice.played).toEqual(["Home is idle.", "No threads are running."]);
    expect(voice.logs).toEqual([
      "[voice] turn 1 (pause) from speech end: finalized +3000ms, sent +3000ms, first text +3000ms, first audio +3000ms",
    ]);
  });

  it("sends at once on a tap in the pause", () => {
    const voice = call();
    voice.say("merge it");
    voice.stopTalking();
    voice.wait(500);
    voice.send({ type: "tap" });
    expect(voice.sent).toEqual(["merge it"]);
  });

  it("speaks a streaming reply sentence by sentence, as each sentence completes", () => {
    const voice = call();
    voice.reply("r1", "Sure, checking.", true);
    expect(voice.engine.synthesizing).toEqual([]);

    voice.reply("r1", "Sure, checking. PR 43 merged", true);
    expect(voice.engine.synthesizing.map((item) => item.text)).toEqual(["Sure, checking."]);

    voice.reply("r1", "Sure, checking. PR 43 merged an hour ago.");
    voice.playAll();
    expect(voice.played).toEqual(["Sure, checking.", "PR 43 merged an hour ago."]);
  });

  it("stops the voice when Amar talks over it, and stale sentences never play", () => {
    const voice = call();
    voice.reply("r1", "First sentence here. Second", true);
    const [first] = voice.engine.synthesizing;
    voice.send({ type: "playback", id: first!.id, state: "started" });

    voice.send({ type: "vad", speaking: true });
    expect(voice.engine.volume).toBe(DEFAULT_VOICE_SPEECH_CONFIG.bargeIn.duckLevel);
    voice.engine.transcript = "wait";
    voice.send({ type: "partial", text: "wait" });
    voice.wait(300);
    expect(voice.engine.stops).toEqual([DEFAULT_VOICE_SPEECH_CONFIG.bargeIn.fadeMs]);
    expect(liveWords(voice.state()).current).toBe("wait");

    voice.reply("r1", "First sentence here. Second sentence here. Third sentence here.");
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

  it("lets its own echo neither interrupt it nor end Amar's turn", () => {
    const voice = call();
    voice.reply("r1", "A long answer that keeps going.");
    voice.send({ type: "vad", speaking: true });
    voice.engine.transcript = "a long answer";
    voice.send({ type: "partial", text: "a long answer" });
    voice.wait(100);
    voice.send({ type: "vad", speaking: false });
    voice.wait(5_000);

    expect(voice.engine.stops).toEqual([]);
    expect(voice.engine.volume).toBe(1);
    expect(voice.state().turn.kind).toBe("idle");

    voice.playAll();
    expect(voice.played).toEqual(["A long answer that keeps going."]);
    expect(voice.engine.discarded).toBe(1);
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

  it("stops the voice on a tap and drops what the mic overheard", () => {
    const voice = call();
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
    expect(liveWords(voice.state()).current).toBeNull();

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
    expect(voice.played).toEqual(["Hi.", "Home is idle."]);
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
