import { KeybindingShortcut, MarkModePauseMs, MarkModeStartResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import {
  MARK_MODE_CANCEL_CHANNEL,
  MARK_MODE_FINISH_CHANNEL,
  MARK_MODE_SET_SHORTCUT_CHANNEL,
  MARK_MODE_START_CHANNEL,
} from "./channels.ts";
import { MarkMode } from "./MarkMode.ts";

// DesktopIpc.handle already rejects every sender but the main window's main frame.
const start = DesktopIpc.makeIpcMethod({
  channel: MARK_MODE_START_CHANNEL,
  payload: Schema.Struct({ pauseMs: MarkModePauseMs }),
  result: MarkModeStartResult,
  handler: Effect.fn("desktop.ipc.markMode.start")(function* (input) {
    return yield* (yield* MarkMode).start(input);
  }),
});

const finish = DesktopIpc.makeIpcMethod({
  channel: MARK_MODE_FINISH_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.markMode.finish")(function* () {
    yield* (yield* MarkMode).finish;
  }),
});

const cancel = DesktopIpc.makeIpcMethod({
  channel: MARK_MODE_CANCEL_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.markMode.cancel")(function* () {
    yield* (yield* MarkMode).cancel;
  }),
});

const setShortcut = DesktopIpc.makeIpcMethod({
  channel: MARK_MODE_SET_SHORTCUT_CHANNEL,
  payload: Schema.NullOr(KeybindingShortcut),
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.markMode.setShortcut")(function* (shortcut) {
    return yield* (yield* MarkMode).setShortcut(shortcut);
  }),
});

export const installMarkMode = Effect.fn("desktop.ipc.markMode.install")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  yield* ipc.handle(start);
  yield* ipc.handle(finish);
  yield* ipc.handle(cancel);
  yield* ipc.handle(setShortcut);
});
