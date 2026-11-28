import { describe, expect, it } from "vite-plus/test";

import { endsCall, goodbyeReply, isClosing, withoutEndCall } from "./endCall";

describe("isClosing", () => {
  it.each([
    "Bye.",
    "Okay, bye!",
    "Bye bye.",
    "Good-bye",
    "Thanks, that's all.",
    "That’s all for now.",
    "I'm done.",
    "No, that's it, thanks.",
    "Alright, talk to you later.",
    "You can hang up.",
    "okay can you close the call",
    "Can you end the call?",
    "please hang up now",
    "you can end this",
    "end the voice call",
  ])("hears %j as a closing", (line) => {
    expect(isClosing(line)).toBe(true);
  });

  it.each([
    "Bye bye, wait, one more thing.",
    "Bye. Actually, ask Home about PR 43.",
    "Thanks.",
    "Is that all?",
    "Tell Home I'm done.",
    "I'm done with PR 43, what's next",
    "Okay.",
    "",
    "still kind of",
    "don't hang up yet",
    "wait, before you end the call, ask Home about PR 43",
    "close the PR",
    "end this PR review",
  ])("does not hear %j as a closing", (line) => {
    expect(isClosing(line)).toBe(false);
  });
});

describe("the end-call marker", () => {
  it("ends the call only from the very end of a reply", () => {
    expect(endsCall("Bye, Amar. [end call]")).toBe(true);
    expect(endsCall("Bye, Amar. [END CALL]\n")).toBe(true);
    expect(endsCall("Bye. [end call] Anything else?")).toBe(false);
    expect(endsCall("Bye, Amar.")).toBe(false);
  });

  it("never reaches the transcript or the voice", () => {
    expect(withoutEndCall("Bye, Amar. [end call]")).toBe("Bye, Amar.");
    expect(withoutEndCall("Bye. [end call] Anything else?")).toBe("Bye. Anything else?");
  });

  it("picks the newest finished reply, when it answers a closing", () => {
    const goodbye = { id: "r2", text: "Bye, Amar. [end call]", streaming: false };
    const earlier = { id: "r1", text: "Home is idle.", streaming: false };
    expect(goodbyeReply([earlier, goodbye], "Okay, bye.")).toBe("r2");
    expect(goodbyeReply([earlier, { ...goodbye, streaming: true }], "Okay, bye.")).toBeNull();
    expect(goodbyeReply([goodbye, earlier], "Okay, bye.")).toBeNull();
    expect(goodbyeReply([earlier, goodbye], "What's Home doing")).toBeNull();
    expect(goodbyeReply([earlier, goodbye], null)).toBeNull();
  });

  it("ends the call Amar asked to close on 27 Nov", () => {
    const goodbye = { id: "r2", text: "Bye, Amar. [end call]", streaming: false };
    expect(goodbyeReply([goodbye], "okay can you close the call")).toBe("r2");
  });
});
