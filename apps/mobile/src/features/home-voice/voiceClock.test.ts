import { describe, expect, it } from "vite-plus/test";

import { formatVoiceClock } from "./voiceClock";

describe("formatVoiceClock", () => {
  it("shows minutes and seconds, and hours once a call passes one", () => {
    expect(formatVoiceClock(-500)).toBe("0:00");
    expect(formatVoiceClock(363_900)).toBe("6:03");
    expect(formatVoiceClock(3_723_000)).toBe("1:02:03");
  });
});
