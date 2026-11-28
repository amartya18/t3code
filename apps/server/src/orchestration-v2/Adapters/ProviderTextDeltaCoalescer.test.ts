import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";
import { makeProviderTextDeltaCoalescer } from "./ProviderTextDeltaCoalescer.ts";

it.effect.each([
  { leading: true, firstShown: ["Sure"] },
  { leading: false, firstShown: [] },
])("emits the first delta at once only when leading is $leading", ({ leading, firstShown }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const emitted = yield* Ref.make<ReadonlyArray<string>>([]);
      const deltas = yield* makeProviderTextDeltaCoalescer({
        flushIntervalMs: 50,
        emit: (update) => Ref.update(emitted, (texts) => [...texts, update.text]),
      });
      const append = (delta: string) =>
        deltas.append({ turnId: "turn", itemId: "item", delta, leading });

      yield* append("Sure");
      expect(yield* Ref.get(emitted)).toEqual(firstShown);
      yield* append(", it");
      yield* append(" is.");
      yield* TestClock.adjust("49 millis");
      expect(yield* Ref.get(emitted)).toEqual(firstShown);
      yield* TestClock.adjust("1 millis");
      expect(yield* Ref.get(emitted)).toEqual([...firstShown, "Sure, it is."]);
    }),
  ),
);
