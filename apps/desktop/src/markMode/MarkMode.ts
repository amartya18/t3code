import type {
  DesktopMarkModeEvent,
  MarkModePauseMs,
  MarkModeStartFailure,
  MarkModeStartResult,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Electron from "electron";
import { msg } from "gt-i18n";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { m } from "../i18n/messages.ts";
import * as MacPermissions from "../permissions/MacPermissions.ts";
import { requestMacScreenCapturePermission } from "../snapShot/DesktopSnapShot.ts";
import { isWaylandSession } from "../snapShot/snapShot.ts";
import { MARK_MODE_EVENT_CHANNEL } from "./channels.ts";
import { MarkModeSession } from "./MarkModeSession.ts";

const SHORTCUT = "Alt+Shift+M";

export class MarkMode extends Context.Service<
  MarkMode,
  {
    readonly start: (input: {
      readonly pauseMs: MarkModePauseMs;
    }) => Effect.Effect<MarkModeStartResult>;
    readonly finish: Effect.Effect<void>;
    readonly cancel: Effect.Effect<void>;
    /** Alt+Shift+M (⌥⇧M) asks the renderer to start, or finishes an active session. */
    readonly registerShortcut: Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/markMode/MarkMode") {}

class MarkModeOverlayError extends Schema.TaggedError<MarkModeOverlayError>()(
  "MarkModeOverlayError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not open the Mark Mode overlay.";
  }
}

const failure = (reason: MarkModeStartFailure, message: string): MarkModeStartResult => ({
  ok: false,
  reason,
  message,
});

export const layer = Layer.effect(
  MarkMode,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const permissions = yield* MacPermissions.MacPermissions;
    const path = yield* Path.Path;
    const env = yield* HostProcess.Environment;
    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    const preloadPath = path.join(environment.dirname, "mark-mode-overlay-preload.cjs");
    let current: MarkModeSession | "starting" | undefined;

    // Only the main window's preload listens; overlays and preview guests never see marks.
    const emit = Effect.fn("MarkMode.emit")(function* (event: DesktopMarkModeEvent) {
      const main = yield* electronWindow.main;
      if (Option.isSome(main) && !main.value.isDestroyed()) {
        main.value.webContents.send(MARK_MODE_EVENT_CHANNEL, event);
      }
    });

    const open = Effect.fn("MarkMode.open")(function* (pauseMs: MarkModePauseMs) {
      const permissionMessage =
        environment.platform === "darwin"
          ? yield* Effect.promise(requestMacScreenCapturePermission)
          : null;
      if (permissionMessage !== null) {
        yield* permissions.showHelper("screen-recording", null);
        return failure(
          "screen-permission",
          m(
            msg(
              "Mark Mode needs Screen Recording. Allow T3 Code in System Settings → Privacy & Security → Screen Recording, then restart T3 Code. On a managed Mac without admin rights, ask your IT admin to allow it.",
            ),
          ),
        );
      }
      const session: MarkModeSession = new MarkModeSession({
        pauseMs,
        preloadPath,
        platform: environment.platform,
        toolbar: { label: m(msg("Mark Mode")), done: m(msg("Done")), discard: m(msg("Discard")) },
        marksLabel: (count) => m(msg("Marks: {count}"), { count: String(count) }),
        onEnd: (event) => {
          if (current === session) current = undefined;
          runFork(emit(event));
        },
        onCaptureError: (cause) =>
          runFork(Effect.logWarning("Mark Mode could not capture a mark", cause)),
      });
      // Set before opening, so a session that ends while its overlays load clears itself.
      current = session;
      const opened = yield* Effect.tryPromise({
        try: () => session.open(),
        catch: (cause) => new MarkModeOverlayError({ cause }),
      }).pipe(
        Effect.as(true),
        Effect.catch((cause) =>
          Effect.logWarning("Mark Mode could not open its overlay", cause).pipe(Effect.as(false)),
        ),
      );
      if (opened) return { ok: true } as const;
      if (current === session) current = undefined;
      return failure("unsupported", m(msg("Mark Mode couldn't open its overlay.")));
    });

    const start = Effect.fn("MarkMode.start")(function* (input: {
      readonly pauseMs: MarkModePauseMs;
    }) {
      if (current !== undefined) return failure("busy", m(msg("Mark Mode is already running.")));
      if (isWaylandSession(environment.platform, env)) {
        return failure(
          "unsupported",
          m(msg("Mark Mode can't draw over other apps on Wayland yet. Use an X11 session.")),
        );
      }
      current = "starting";
      return yield* open(input.pauseMs).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (current === "starting") current = undefined;
          }),
        ),
      );
    });

    const finish = Effect.fn("MarkMode.finish")(function* () {
      const session = current;
      if (session instanceof MarkModeSession) yield* Effect.promise(() => session.finish());
    });

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (current instanceof MarkModeSession) current.cancel();
      }),
    );

    return MarkMode.of({
      start,
      finish: finish(),
      cancel: Effect.sync(() => {
        if (current instanceof MarkModeSession) current.cancel();
      }).pipe(Effect.withSpan("MarkMode.cancel")),
      registerShortcut: Effect.acquireRelease(
        Effect.sync(() =>
          Electron.globalShortcut.register(SHORTCUT, () => {
            if (current === "starting") return;
            runFork(current ? finish() : emit({ type: "start-requested" }));
          }),
        ),
        (registered) =>
          Effect.sync(() => {
            if (registered) Electron.globalShortcut.unregister(SHORTCUT);
          }),
      ).pipe(
        Effect.flatMap((registered) =>
          registered
            ? Effect.void
            : Effect.logWarning("Mark Mode could not register its shortcut", { SHORTCUT }),
        ),
        Effect.withSpan("MarkMode.registerShortcut"),
      ),
    });
  }),
);
