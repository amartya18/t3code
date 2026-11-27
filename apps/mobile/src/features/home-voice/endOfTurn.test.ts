import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_END_OF_TURN_CONFIG,
  INITIAL_END_OF_TURN_STATE,
  stepEndOfTurn,
  type EndOfTurnConfig,
  type EndOfTurnEffect,
  type EndOfTurnEvent,
  type EndOfTurnState,
} from "./endOfTurn";

type Input = EndOfTurnEvent extends infer E
  ? E extends { atMs: number }
    ? Omit<E, "atMs">
    : never
  : never;

const TIMER_ONLY: EndOfTurnConfig = { ...DEFAULT_END_OF_TURN_CONFIG, earlySend: false };

function session(config: EndOfTurnConfig = TIMER_ONLY) {
  let state: EndOfTurnState = INITIAL_END_OF_TURN_STATE;
  let now = 0;
  const finalized: Array<{ reason: EndOfTurnEffect["reason"]; atMs: number }> = [];
  const send = (input: Input) => {
    const step = stepEndOfTurn(state, { ...input, atMs: now } as EndOfTurnEvent, config);
    state = step.state;
    finalized.push(...step.effects.map((effect) => ({ reason: effect.reason, atMs: now })));
  };
  return {
    finalized,
    state: () => state,
    send,
    say(text: string) {
      send({ type: "vad", speaking: true });
      send({ type: "partial", text });
    },
    stopTalking: () => send({ type: "vad", speaking: false }),
    /** Advances the fake clock in 100 ms ticks, the way the hook's interval would. */
    wait(ms: number) {
      for (let elapsed = 0; elapsed < ms; elapsed += 100) {
        now += Math.min(100, ms - elapsed);
        send({ type: "tick" });
      }
    },
  };
}

describe("stepEndOfTurn", () => {
  it("does not send on a 2.5 s mid-sentence pause, and sends after 3 s", () => {
    const voice = session();
    voice.say("tell Home to merge");
    voice.stopTalking();
    voice.wait(2_500);
    expect(voice.finalized).toEqual([]);

    voice.wait(500);
    expect(voice.finalized).toEqual([{ reason: "pause", atMs: 3_000 }]);
    expect(voice.state()).toEqual({ kind: "finalizing", reason: "pause" });
  });

  it("returns to speaking when speech resumes during a pause, and restarts the timer", () => {
    const voice = session();
    voice.say("tell Home to merge");
    voice.stopTalking();
    voice.wait(2_500);
    voice.say("tell Home to merge it once checks pass");
    expect(voice.state().kind).toBe("speaking");

    voice.wait(5_000);
    expect(voice.finalized).toEqual([]);
    voice.stopTalking();
    voice.wait(2_900);
    expect(voice.finalized).toEqual([]);
    voice.wait(100);
    expect(voice.finalized).toEqual([{ reason: "pause", atMs: 10_500 }]);
  });

  it("keeps counting from his last word through a sound with no words", () => {
    const voice = session();
    voice.say("tell Home to merge");
    voice.stopTalking();
    voice.wait(2_000);
    voice.send({ type: "vad", speaking: true });
    voice.wait(300);
    voice.stopTalking();
    voice.wait(700);
    expect(voice.finalized).toEqual([{ reason: "pause", atMs: 3_000 }]);
  });

  it("waits out a voice in the pause, then sends once no words came of it", () => {
    const voice = session();
    voice.say("tell Home to merge");
    voice.stopTalking();
    voice.wait(2_500);
    voice.send({ type: "vad", speaking: true });
    voice.wait(1_000);
    expect(voice.finalized).toEqual([]);
    voice.stopTalking();
    voice.wait(300);
    expect(voice.finalized).toEqual([]);
    voice.wait(100);
    expect(voice.finalized).toEqual([{ reason: "pause", atMs: 3_900 }]);
  });

  it("restarts the countdown from a voice whose words arrive just after it ends", () => {
    const voice = session();
    voice.say("tell Home to merge");
    voice.stopTalking();
    voice.wait(2_000);
    voice.send({ type: "vad", speaking: true });
    voice.wait(300);
    voice.stopTalking();
    voice.wait(200);
    voice.send({ type: "partial", text: "tell Home to merge it" });
    voice.wait(2_700);
    expect(voice.finalized).toEqual([]);
    voice.wait(100);
    expect(voice.finalized).toEqual([{ reason: "pause", atMs: 5_300 }]);
  });

  it("holds a touched pause until the 10 s ceiling, then sends", () => {
    const voice = session();
    voice.say("rerun the iOS build");
    voice.stopTalking();
    voice.wait(1_000);
    voice.send({ type: "holdStart" });
    voice.wait(8_900);
    expect(voice.finalized).toEqual([]);
    voice.wait(100);
    expect(voice.finalized).toEqual([{ reason: "ceiling", atMs: 10_000 }]);
  });

  it("starts a fresh pause when the finger lifts", () => {
    const voice = session();
    voice.say("rerun the iOS build");
    voice.send({ type: "holdStart" });
    voice.stopTalking();
    voice.wait(4_000);
    voice.send({ type: "holdEnd" });
    voice.wait(2_900);
    expect(voice.finalized).toEqual([]);
    voice.wait(100);
    expect(voice.finalized).toEqual([{ reason: "pause", atMs: 7_000 }]);
  });

  it('treats a trailing "hang on" as a hold, and sends one message once the sentence finishes', () => {
    const voice = session();
    voice.say("tell Home to merge it once checks pass, and… hang on…");
    voice.stopTalking();
    voice.wait(6_000);
    expect(voice.finalized).toEqual([]);

    voice.say(
      "tell Home to merge it once checks pass, and… hang on… ask it to rerun the iOS build too.",
    );
    voice.stopTalking();
    voice.wait(3_000);
    expect(voice.finalized).toEqual([{ reason: "pause", atMs: 9_000 }]);
  });

  it('holds when "hold on" arrives in a late partial after the speech ended', () => {
    const voice = session();
    voice.say("merge it once checks pass and");
    voice.stopTalking();
    voice.wait(300);
    voice.send({ type: "partial", text: "merge it once checks pass and hold on" });
    voice.wait(9_600);
    expect(voice.finalized).toEqual([]);
    voice.wait(100);
    expect(voice.finalized).toEqual([{ reason: "ceiling", atMs: 10_000 }]);
  });

  it("sends at once on a tap, while speaking or paused", () => {
    const speaking = session();
    speaking.say("merge it");
    speaking.send({ type: "tap" });
    expect(speaking.finalized).toEqual([{ reason: "tap", atMs: 0 }]);

    const paused = session();
    paused.say("merge it");
    paused.stopTalking();
    paused.send({ type: "holdStart" });
    paused.wait(1_000);
    paused.send({ type: "tap" });
    expect(paused.finalized).toEqual([{ reason: "tap", atMs: 1_000 }]);
  });

  it("never sends an empty transcript", () => {
    const voice = session();
    voice.send({ type: "vad", speaking: true });
    voice.send({ type: "partial", text: "  " });
    voice.stopTalking();
    voice.wait(3_000);
    voice.send({ type: "tap" });
    expect(voice.finalized).toEqual([]);
    expect(voice.state()).toEqual({ kind: "idle" });
  });

  it("drops the utterance and ignores the mic while muted", () => {
    const voice = session();
    voice.say("merge it");
    voice.send({ type: "muted", muted: true });
    voice.say("this is a side conversation");
    voice.stopTalking();
    voice.wait(4_000);
    expect(voice.finalized).toEqual([]);

    voice.send({ type: "muted", muted: false });
    voice.say("merge it");
    voice.stopTalking();
    voice.wait(3_000);
    expect(voice.finalized).toEqual([{ reason: "pause", atMs: 7_000 }]);
  });

  it("starts the next utterance after a send", () => {
    const voice = session();
    voice.say("merge it");
    voice.stopTalking();
    voice.wait(3_000);
    voice.say("and rerun the build");
    voice.stopTalking();
    voice.wait(3_000);
    expect(voice.finalized.map((sent) => sent.reason)).toEqual(["pause", "pause"]);
  });
});

describe("early send", () => {
  const EARLY: EndOfTurnConfig = { ...DEFAULT_END_OF_TURN_CONFIG, earlySend: true };

  it("sends on Parakeet's end of utterance once the floor has passed", () => {
    const voice = session(EARLY);
    voice.say("what is Home working on?");
    voice.stopTalking();
    voice.wait(200);
    voice.send({ type: "eou", text: "what is Home working on?" });
    expect(voice.finalized).toEqual([]);
    voice.wait(300);
    expect(voice.finalized).toEqual([{ reason: "early", atMs: 500 }]);
  });

  it("keeps an end of utterance that arrives before the speech ends", () => {
    const voice = session(EARLY);
    voice.say("what is Home working on?");
    voice.send({ type: "eou", text: "what is Home working on?" });
    voice.wait(1_000);
    voice.stopTalking();
    voice.wait(500);
    expect(voice.finalized).toEqual([{ reason: "early", atMs: 1_500 }]);
  });

  it.each(["and", "so", "um", "uh", "but", "because", "so,", "um…"])(
    'falls back to the pause timer when the transcript ends in "%s"',
    (filler) => {
      const voice = session(EARLY);
      const text = `tell Home to merge it ${filler}`;
      voice.say(text);
      voice.stopTalking();
      voice.send({ type: "eou", text });
      voice.wait(2_900);
      expect(voice.finalized).toEqual([]);
      voice.wait(100);
      expect(voice.finalized).toEqual([{ reason: "pause", atMs: 3_000 }]);
    },
  );

  it("forgets an end of utterance once the words change", () => {
    const voice = session(EARLY);
    voice.say("merge it");
    voice.send({ type: "eou", text: "merge it" });
    voice.send({ type: "partial", text: "merge it once checks pass" });
    voice.stopTalking();
    voice.wait(2_900);
    expect(voice.finalized).toEqual([]);
  });

  it("does not send early while held", () => {
    const voice = session(EARLY);
    voice.say("merge it");
    voice.send({ type: "holdStart" });
    voice.stopTalking();
    voice.send({ type: "eou", text: "merge it" });
    voice.wait(9_900);
    expect(voice.finalized).toEqual([]);
  });

  it("is off when the setting is off", () => {
    const voice = session(TIMER_ONLY);
    voice.say("what is Home working on?");
    voice.stopTalking();
    voice.send({ type: "eou", text: "what is Home working on?" });
    voice.wait(2_900);
    expect(voice.finalized).toEqual([]);
  });
});

describe("pause from the real end of speech", () => {
  const LAG = 300;
  const FROM_SPEECH_END: EndOfTurnConfig = { ...TIMER_ONLY, pauseMs: 500, vadEndLagMs: LAG };

  /** The VAD reports the end `LAG` ms after he stopped, so the clock starts at his real end. */
  function stoppedAt(config: EndOfTurnConfig, text = "tell Home to merge") {
    const voice = session(config);
    voice.say(text);
    voice.wait(LAG);
    voice.stopTalking();
    return voice;
  }

  it("sends the pause after he stopped, not after the VAD said so", () => {
    const voice = stoppedAt(FROM_SPEECH_END);
    voice.wait(100);
    expect(voice.finalized).toEqual([]);
    voice.wait(100);
    expect(voice.finalized).toEqual([{ reason: "pause", atMs: LAG + 200 }]);
  });

  it("counts from the VAD's report when off", () => {
    const voice = stoppedAt({ ...FROM_SPEECH_END, vadEndLagMs: 0 });
    voice.wait(400);
    expect(voice.finalized).toEqual([]);
    voice.wait(100);
    expect(voice.finalized).toEqual([{ reason: "pause", atMs: LAG + 500 }]);
  });

  it("counts a later voice's words from that voice's real end", () => {
    const voice = stoppedAt(FROM_SPEECH_END, "tell Home");
    voice.send({ type: "vad", speaking: true });
    voice.wait(600);
    voice.send({ type: "vad", speaking: false });
    voice.wait(100);
    voice.send({ type: "partial", text: "tell Home to merge" });
    expect(voice.finalized).toEqual([]);
    voice.wait(100);
    expect(voice.finalized).toEqual([{ reason: "pause", atMs: LAG + 800 }]);
  });

  it("still holds a touched pause and a trailing hang on until the ceiling", () => {
    const touched = stoppedAt(FROM_SPEECH_END);
    touched.send({ type: "holdStart" });
    touched.wait(9_600);
    expect(touched.finalized).toEqual([]);
    touched.wait(100);
    expect(touched.finalized).toEqual([{ reason: "ceiling", atMs: LAG + 9_700 }]);

    const hangOn = stoppedAt(FROM_SPEECH_END, "merge it, hang on");
    hangOn.wait(9_600);
    expect(hangOn.finalized).toEqual([]);
    hangOn.wait(100);
    expect(hangOn.finalized).toEqual([{ reason: "ceiling", atMs: LAG + 9_700 }]);
  });

  it("starts a fresh full pause when the finger lifts", () => {
    const voice = stoppedAt(FROM_SPEECH_END);
    voice.send({ type: "holdStart" });
    voice.wait(2_000);
    voice.send({ type: "holdEnd" });
    voice.wait(400);
    expect(voice.finalized).toEqual([]);
    voice.wait(100);
    expect(voice.finalized).toEqual([{ reason: "pause", atMs: LAG + 2_500 }]);
  });

  it("sends early once the floor has passed since he stopped", () => {
    const voice = stoppedAt({ ...FROM_SPEECH_END, pauseMs: 3_000, earlySend: true });
    voice.send({ type: "eou", text: "tell Home to merge" });
    expect(voice.finalized).toEqual([]);
    voice.wait(100);
    expect(voice.finalized).toEqual([]);
    voice.wait(100);
    expect(voice.finalized).toEqual([{ reason: "early", atMs: LAG + 200 }]);
  });
});
