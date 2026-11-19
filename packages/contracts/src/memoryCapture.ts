/**
 * Fork-only: reads finished threads and proposes lasting facts for the wiki.
 * Trial mode appends candidates to a local file and never touches the wiki.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

export const MemoryCaptureMode = Schema.Literals(["off", "trial", "live"]);
export type MemoryCaptureMode = typeof MemoryCaptureMode.Type;

/** Widening tiers: home covers Home and threads it launched, subagents adds subagents, all adds every thread. */
export const MemoryCaptureScope = Schema.Literals(["home", "subagents", "all"]);
export type MemoryCaptureScope = typeof MemoryCaptureScope.Type;

export const MemoryCaptureSettings = Schema.Struct({
  mode: MemoryCaptureMode.pipe(Schema.withDecodingDefault(Effect.succeed("off" as const))),
  scope: MemoryCaptureScope.pipe(Schema.withDecodingDefault(Effect.succeed("all" as const))),
  /** Null uses Claude Haiku. */
  modelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** Null uses `$XDG_DATA_HOME/t3-capture/trial`, or `~/.local/share/t3-capture/trial`. */
  trialDir: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  excludeProjectIds: Schema.Array(ProjectId).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type MemoryCaptureSettings = typeof MemoryCaptureSettings.Type;

export const DEFAULT_MEMORY_CAPTURE_SETTINGS: MemoryCaptureSettings = {
  mode: "off",
  scope: "all",
  modelSelection: null,
  trialDir: null,
  excludeProjectIds: [],
};
