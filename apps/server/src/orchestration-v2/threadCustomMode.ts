import type { CustomModeSkillName, OrchestrationV2Run, ThreadCustomMode } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export const customModeOn = (skill: CustomModeSkillName, now: DateTime.Utc): ThreadCustomMode => ({
  status: "on",
  skill,
  updatedAt: DateTime.formatIso(now),
});

/** Undefined when the command changes nothing. */
export function nextThreadCustomMode(
  current: ThreadCustomMode | null | undefined,
  skill: CustomModeSkillName | null,
  now: DateTime.Utc,
): ThreadCustomMode | undefined {
  if (skill !== null) {
    return current?.status === "on" && current.skill === skill
      ? undefined
      : customModeOn(skill, now);
  }
  return current?.status === "on"
    ? { status: "off", skill: current.skill, updatedAt: DateTime.formatIso(now) }
    : undefined;
}

export type CustomModeTurn =
  | { readonly kind: "none" }
  | { readonly kind: "activate" | "remind" | "exit"; readonly skill: CustomModeSkillName };

/**
 * A mode change after the previous turn started is still news to the provider. A turn's start,
 * not its request, counts, so a message queued before the change cannot hide it.
 */
function planCustomModeTurn(input: {
  readonly customMode: ThreadCustomMode | null | undefined;
  readonly previousRunStartedAt: DateTime.Utc | null;
}): CustomModeTurn {
  const mode = input.customMode;
  if (mode === null || mode === undefined) return { kind: "none" };
  const changedSincePreviousRun =
    input.previousRunStartedAt === null ||
    Date.parse(mode.updatedAt) > DateTime.toEpochMillis(input.previousRunStartedAt);
  if (mode.status === "on") {
    return { kind: changedSincePreviousRun ? "activate" : "remind", skill: mode.skill };
  }
  return changedSincePreviousRun ? { kind: "exit", skill: mode.skill } : { kind: "none" };
}

type ModeRun = Pick<OrchestrationV2Run, "ordinal" | "startedAt" | "providerThreadId">;

/** Only earlier turns of the same provider conversation have seen the skill. */
export function customModeTurnForRun(input: {
  readonly customMode: ThreadCustomMode | null | undefined;
  readonly run: ModeRun & Pick<OrchestrationV2Run, "freshContext">;
  readonly runs: ReadonlyArray<ModeRun>;
}): CustomModeTurn {
  const previous =
    input.run.freshContext === true
      ? undefined
      : input.runs.findLast(
          (candidate) =>
            candidate.ordinal < input.run.ordinal &&
            candidate.startedAt !== null &&
            candidate.providerThreadId === input.run.providerThreadId,
        );
  return planCustomModeTurn({
    customMode: input.customMode,
    previousRunStartedAt: previous?.startedAt ?? null,
  });
}

/** `context` goes in the turn's inline context; `prefix` starts the user's message. */
export function renderCustomModeTurn(turn: CustomModeTurn): {
  readonly context: string;
  readonly prefix: string;
} {
  switch (turn.kind) {
    case "none":
      return { context: "", prefix: "" };
    case "activate":
      return {
        context: `Custom mode \`${turn.skill}\` is now on for this thread. Follow that skill for this and every later message until it is turned off.`,
        prefix: `$${turn.skill} `,
      };
    case "remind":
      return {
        context: `Custom mode \`${turn.skill}\` is on for this thread. Keep following that skill's instructions. If you lost track of them, re-read its SKILL.md. If this message starts a new task, route it as a new task under the skill.`,
        prefix: "",
      };
    case "exit":
      return {
        context: `Custom mode \`${turn.skill}\` is now off. Stop following that skill unless the user invokes it again.`,
        prefix: "",
      };
  }
}
