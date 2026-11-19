import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** A name a `$skill` mention can carry, as in packages/shared/src/composerInlineTokens.ts. */
export const CustomModeSkillName = TrimmedNonEmptyString.check(
  Schema.isPattern(/^(?=[a-zA-Z0-9:_-]*[a-zA-Z])[a-zA-Z0-9][a-zA-Z0-9:_-]*$/),
);
export type CustomModeSkillName = typeof CustomModeSkillName.Type;

/** A skill can be a mode only when a `$skill` mention can carry its name. */
export const isCustomModeSkillName = Schema.is(CustomModeSkillName);

/**
 * A skill pinned to a thread so every turn keeps following it. `off` keeps the last skill so the
 * next turn can tell the agent to stop.
 */
export const ThreadCustomMode = Schema.Struct({
  status: Schema.Literals(["on", "off"]),
  skill: CustomModeSkillName,
  updatedAt: IsoDateTime,
});
export type ThreadCustomMode = typeof ThreadCustomMode.Type;

export const activeCustomModeSkill = (
  mode: ThreadCustomMode | null | undefined,
): CustomModeSkillName | null => (mode?.status === "on" ? mode.skill : null);
