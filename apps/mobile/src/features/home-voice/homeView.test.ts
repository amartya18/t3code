import { describe, expect, it } from "vite-plus/test";

import { speakable } from "./homeView";

describe("speakable", () => {
  it("drops a parenthesised link whole", () => {
    expect(
      speakable(
        'PR 43, "Mark Mode prototype" (https://github.com/amartya18/t3code/pull/43) is still open.',
        200,
      ),
    ).toBe('PR 43, "Mark Mode prototype" is still open.');
  });

  it("drops mixed letter and digit ids but keeps names like laptop13", () => {
    expect(speakable("sleep is running as background task b0rfrdrs2 on laptop13.", 200)).toBe(
      "sleep is running as background task on laptop13.",
    );
  });

  it("keeps the word Home before a colon but drops thread refs", () => {
    expect(speakable("Relayed to Home: merge PR 43. See home:abc123 for more.", 200)).toBe(
      "Relayed to Home: merge PR 43. See for more.",
    );
  });
});
