import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { computeRates, formatRates, parseGradedLines } from "./memory-capture-rates.ts";

const row = (
  kind: string,
  graded: number,
  [truthful, attributionCorrect, worthKeeping, duplicate, fresh]: ReadonlyArray<number>,
) => ({
  kind,
  graded,
  ungraded: 0,
  true: truthful,
  attributionCorrect,
  worthKeeping,
  duplicate,
  new: fresh,
});

it.effect("computes strict rates per thread kind from the graded sample", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(
      new URL("./fixtures/memory-capture-graded.sample.jsonl", import.meta.url).pathname,
    );
    const rates = computeRates(yield* parseGradedLines(text));

    expect(rates).toEqual({
      rows: [
        row("home", 1, [1, 1, 1, 0, 1]),
        row("home-launched", 1, [1, 0, 0, 0, 1]),
        row("subagent", 1, [0, 1, 0, 1, 0]),
        row("normal", 2, [2, 2, 2, 0, 1]),
        row("total", 5, [4, 4, 3, 1, 3]),
      ],
      disagreements: { true: 0, attributionCorrect: 0, worthKeeping: 1, duplicate: 1 },
      droppedByReason: { transient: 2, secret: 1 },
      downgraded: 1,
    });
    const report = formatRates(rates);
    expect(report).toContain("total          5       0         4/5 (80%)");
    expect(report).toContain(
      "Grader disagreements: true 0, attributionCorrect 0, worthKeeping 1, duplicate 1",
    );
    expect(report).toContain("Dropped by reason: secret 1, transient 2");
  }).pipe(Effect.provide(NodeServices.layer)),
);
